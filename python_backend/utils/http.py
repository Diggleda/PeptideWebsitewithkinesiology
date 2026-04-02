from __future__ import annotations

import re
from typing import Any, Callable, Tuple

from flask import Response, jsonify, request
from werkzeug.exceptions import HTTPException


_PUBLIC_SERVICE_REPLACEMENTS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bwoocommerce\b", re.IGNORECASE), "store"),
    (re.compile(r"\bwoo\s*commerce\b", re.IGNORECASE), "store"),
    (re.compile(r"\bwoo\b", re.IGNORECASE), "store"),
    (re.compile(r"\bstripe\b", re.IGNORECASE), "payment provider"),
    (re.compile(r"\bcloudflare\b", re.IGNORECASE), "network provider"),
    (re.compile(r"\bgodaddy\b", re.IGNORECASE), "hosting provider"),
    (re.compile(r"\bshipstation\b", re.IGNORECASE), "shipping provider"),
    (re.compile(r"\bshipengine\b", re.IGNORECASE), "shipping provider"),
]
_ERROR_CODE_PATTERN = re.compile(r"^[A-Z0-9]+(?:_[A-Z0-9]+)*$")


def _sanitize_public_message(message: str) -> str:
    if not isinstance(message, str) or not message:
        return message
    cleaned = message
    for pattern, replacement in _PUBLIC_SERVICE_REPLACEMENTS:
        cleaned = pattern.sub(replacement, cleaned)
    cleaned = re.sub(r"\bstore\s+store\b", "store", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(
        r"\bpayment provider\s+payment provider\b",
        "payment provider",
        cleaned,
        flags=re.IGNORECASE,
    )
    return cleaned


def service_error(message: str, status: int) -> Exception:
    """Create a ValueError with an HTTP status code for handle_action to catch."""
    err = ValueError(message)
    setattr(err, "status", status)
    normalized = str(message or "").strip()
    if _ERROR_CODE_PATTERN.fullmatch(normalized):
        setattr(err, "error_code", normalized)
    return err


def _default_code_for_status(status: int) -> str:
    if status == 400:
        return "BAD_REQUEST"
    if status == 401:
        return "UNAUTHORIZED"
    if status == 403:
        return "FORBIDDEN"
    if status == 404:
        return "NOT_FOUND"
    if status == 409:
        return "CONFLICT"
    if status == 413:
        return "PAYLOAD_TOO_LARGE"
    if status == 415:
        return "UNSUPPORTED_MEDIA_TYPE"
    if status == 422:
        return "UNPROCESSABLE_ENTITY"
    if status == 429:
        return "RATE_LIMITED"
    return "INTERNAL_ERROR" if status >= 500 else "ERROR"


def _extract_error_code(error: Exception, status: int, message: str) -> str:
    explicit = getattr(error, "error_code", None)
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    candidate = getattr(error, "code", None)
    if isinstance(candidate, str) and candidate.strip():
        return candidate.strip()
    normalized_message = str(message or "").strip()
    if _ERROR_CODE_PATTERN.fullmatch(normalized_message):
        return normalized_message
    return _default_code_for_status(status)


def require_admin() -> None:
    """Raise 403 if the current Flask request user is not an admin."""
    from flask import g

    role = str((getattr(g, "current_user", None) or {}).get("role") or "").strip().lower()
    if role != "admin":
        raise service_error("Admin access required", 403)


def is_admin() -> bool:
    """Return True if the current Flask request user is an admin."""
    from flask import g

    role = str((getattr(g, "current_user", None) or {}).get("role") or "").strip().lower()
    return role == "admin"


def utc_now_iso() -> str:
    """Return the current UTC time as an ISO 8601 string."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def json_success(data: Any, status: int = 200) -> Response:
    return jsonify(data), status


def json_error(error: Exception) -> Response:
    status = getattr(error, "status", None)
    if status is None and isinstance(error, HTTPException):
        status = getattr(error, "code", None)
    if status is None:
        status = 500

    message = getattr(error, "message", None) or str(error) or "Internal server error"
    if isinstance(error, HTTPException):
        description = getattr(error, "description", None)
        if isinstance(description, str) and description.strip():
            message = description.strip()
    message = _sanitize_public_message(message)
    return jsonify({"error": message, "code": _extract_error_code(error, status, message)}), status


def handle_action(action: Callable[[], Any], status: int = 200) -> Response:
    try:
        payload = action()
        if isinstance(payload, Response):
            return payload
        if isinstance(payload, tuple) and len(payload) == 2:
            body, code = payload
            if isinstance(body, Response):
                return payload
            if isinstance(code, int):
                return json_success(body, status=code)
        return json_success(payload, status=status)
    except Exception as exc:  # pragma: no cover - error paths
        import logging

        logger = logging.getLogger("peppro.api")
        http_status = getattr(exc, "status", None)
        if http_status is None and isinstance(exc, HTTPException):
            http_status = getattr(exc, "code", None)
        http_status = int(http_status or 500)
        log_extra = {"method": request.method, "path": request.path, "status": http_status}
        try:
            message = getattr(exc, "message", None) or str(exc) or None
            if isinstance(exc, HTTPException):
                description = getattr(exc, "description", None)
                if isinstance(description, str) and description.strip():
                    message = description.strip()
            if isinstance(message, str) and message.strip():
                log_extra["error"] = _sanitize_public_message(message.strip())
        except Exception:
            pass
        # Avoid noisy tracebacks for expected 4xx control-flow errors (auth/validation/etc.).
        if http_status >= 500:
            logger.exception("Unhandled API error", extra=log_extra)
        else:
            logger.warning("API request rejected", extra=log_extra)
        return json_error(exc)
