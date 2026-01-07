from __future__ import annotations

import re
from typing import Any, Callable, Tuple

from flask import Response, jsonify, request


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


def json_success(data: Any, status: int = 200) -> Response:
    return jsonify(data), status


def json_error(error: Exception) -> Response:
    status = getattr(error, "status", 500)
    message = getattr(error, "message", None) or str(error) or "Internal server error"
    message = _sanitize_public_message(message)
    return jsonify({"error": message}), status


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
        http_status = int(getattr(exc, "status", 500) or 500)
        log_extra = {"method": request.method, "path": request.path, "status": http_status}
        # Avoid noisy tracebacks for expected 4xx control-flow errors (auth/validation/etc.).
        if http_status >= 500:
            logger.exception("Unhandled API error", extra=log_extra)
        else:
            logger.warning("API request rejected", extra=log_extra)
        return json_error(exc)
