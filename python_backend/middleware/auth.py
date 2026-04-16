from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from functools import wraps
from typing import Callable, TypeVar

import jwt
from flask import Response, jsonify, request, g

from ..services import get_config
from ..services import auth_service, presence_service
from ..services import admin_shadow_session_service
from ..repositories import user_repository
from ..utils.auth_cookies import read_media_auth_cookie

F = TypeVar("F", bound=Callable)

_AUDIT_LOGGER = None

def _audit_enabled() -> bool:
    return str(os.environ.get("AUTH_AUDIT_LOGS") or "").strip().lower() in ("1", "true", "yes", "on")

def _audit(event: str, details: dict) -> None:
    if not _audit_enabled():
        return
    global _AUDIT_LOGGER
    if _AUDIT_LOGGER is None:
        import logging
        _AUDIT_LOGGER = logging.getLogger("peppro.auth_audit")
    try:
        _AUDIT_LOGGER.info("auth_audit %s", {"event": event, **(details or {})})
    except Exception:
        pass

def _parse_datetime(value) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            seconds = float(value)
            # Treat large values as milliseconds.
            if seconds > 10_000_000_000:
                seconds = seconds / 1000.0
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except Exception:
            return None
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        # Support both ISO strings and MySQL DATETIME ("YYYY-MM-DD HH:MM:SS").
        normalized = raw.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None


def _clamp_seconds(raw: str | None, *, fallback: int, min_s: int, max_s: int) -> int:
    try:
        parsed = int(float(raw)) if raw is not None else fallback
    except Exception:
        parsed = fallback
    return max(min_s, min(parsed, max_s))


def require_auth(func: F) -> F:
    @wraps(func)
    def wrapper(*args, **kwargs):
        error = _authenticate_request(allow_media_cookie=False)
        if error is not None:
            return error
        return func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def require_media_auth(func: F) -> F:
    @wraps(func)
    def wrapper(*args, **kwargs):
        error = _authenticate_request(allow_media_cookie=True)
        if error is not None:
            return error
        return func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def read_request_auth_token(*, allow_media_cookie: bool = False) -> str | None:
    header = request.headers.get("Authorization", "")
    if isinstance(header, str) and header.strip():
        parts = header.split()
        token = parts[1] if len(parts) == 2 else parts[0]
        normalized = str(token or "").strip()
        if normalized:
            return normalized
    if allow_media_cookie:
        return read_media_auth_cookie()
    return None


def _authenticate_request(*, allow_media_cookie: bool) -> Response | None:
    token = read_request_auth_token(allow_media_cookie=allow_media_cookie)
    if not token:
        return _unauthorized("Access token required", code="TOKEN_REQUIRED")

    try:
        payload = jwt.decode(token, get_config().jwt_secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return _forbidden("Token expired", code="TOKEN_EXPIRED")
    except jwt.InvalidTokenError:
        return _forbidden("Invalid token", code="TOKEN_INVALID")

    user_id = payload.get("id")
    if not user_id:
        return _forbidden("Invalid token", code="TOKEN_INVALID")

    role_raw = (payload.get("role") or "").strip().lower()
    # Normalize role strings coming from various sources ("Sales Lead", "sales-lead", etc.)
    # into a consistent underscore form used throughout the backend.
    role = re.sub(r"[\s-]+", "_", role_raw)
    payload["role"] = role
    if payload.get("shadow") is True:
        shadow_session_id = payload.get("shadowSessionId")
        if not shadow_session_id or not isinstance(shadow_session_id, str):
            return _forbidden("Invalid token", code="TOKEN_INVALID")
        try:
            resolved = admin_shadow_session_service.resolve_shadow_session(payload)
        except Exception as exc:
            code = getattr(exc, "error_code", None) or getattr(exc, "code", None)
            if isinstance(code, str) and code.strip():
                return _forbidden("Token revoked", code=code.strip())
            return _forbidden("Token revoked", code="TOKEN_REVOKED")

        target_user = resolved.get("targetUser") if isinstance(resolved, dict) else None
        if not isinstance(target_user, dict):
            return _forbidden("Token revoked", code="TOKEN_REVOKED")
        g.current_user = {
            **payload,
            "id": str(target_user.get("id") or user_id),
            "email": target_user.get("email"),
            "role": re.sub(r"[\s-]+", "_", str(target_user.get("role") or role).strip().lower()),
        }
        g.shadow_context = resolved.get("shadowContext")
        return None

    token_session_id = payload.get("sid") or payload.get("sessionId")
    if not token_session_id or not isinstance(token_session_id, str):
        return _forbidden("Invalid token", code="TOKEN_INVALID")

    exempt_multi_session = (payload.get("email") or "").strip().lower() == "test@doctor.com"

    user = user_repository.find_session_by_id(str(user_id))
    if not isinstance(user, dict):
        user = None
    stored_session_id = user.get("sessionId") if user else None

    if not stored_session_id or not isinstance(stored_session_id, str):
        return _forbidden("Token revoked", code="TOKEN_REVOKED")

    if stored_session_id != token_session_id and not exempt_multi_session:
        return _forbidden("Token revoked", code="TOKEN_REVOKED")

    session_max_s = _clamp_seconds(
        os.environ.get("USER_SESSION_MAX_AGE_SECONDS"),
        fallback=24 * 60 * 60,
        min_s=5 * 60,
        max_s=30 * 24 * 60 * 60,
    )
    idle_max_s = _clamp_seconds(
        os.environ.get("USER_IDLE_LOGOUT_SECONDS"),
        fallback=60 * 60,
        min_s=60,
        max_s=24 * 60 * 60,
    )

    now_dt = datetime.now(timezone.utc)
    issued_at_dt = _parse_datetime(payload.get("iat"))
    session_start_dt = (
        issued_at_dt
        or _parse_datetime((user or {}).get("lastLoginAt"))
    )
    if session_start_dt and (now_dt - session_start_dt).total_seconds() >= session_max_s:
        try:
            if not exempt_multi_session:
                auth_service.logout(str(user_id), role)
        except Exception:
            pass
        _audit(
            "FORCED_LOGOUT",
            {
                "reason": "SESSION_MAX_AGE",
                "userId": str(user_id),
                "role": role,
                "sessionMaxSeconds": session_max_s,
                "sessionStartedAt": session_start_dt.isoformat().replace("+00:00", "Z") if session_start_dt else None,
                "at": now_dt.isoformat().replace("+00:00", "Z"),
            },
        )
        return _unauthorized("Session expired", code="SESSION_MAX_AGE")

    idle_anchor_dt = _parse_datetime((user or {}).get("lastInteractionAt"))
    if not idle_anchor_dt:
        try:
            entry = presence_service.snapshot().get(str(user_id))
            idle_anchor_dt = _parse_datetime((entry or {}).get("lastInteractionAt"))
        except Exception:
            idle_anchor_dt = None
    idle_anchor_dt = idle_anchor_dt or _parse_datetime((user or {}).get("lastLoginAt")) or session_start_dt
    if idle_anchor_dt and (now_dt - idle_anchor_dt).total_seconds() >= idle_max_s:
        try:
            if not exempt_multi_session:
                auth_service.logout(str(user_id), role)
        except Exception:
            pass
        _audit(
            "FORCED_LOGOUT",
            {
                "reason": "SESSION_IDLE_TIMEOUT",
                "userId": str(user_id),
                "role": role,
                "idleMaxSeconds": idle_max_s,
                "idleAnchorAt": idle_anchor_dt.isoformat().replace("+00:00", "Z") if idle_anchor_dt else None,
                "at": now_dt.isoformat().replace("+00:00", "Z"),
            },
        )
        return _unauthorized("Session expired", code="SESSION_IDLE_TIMEOUT")

    g.current_user = payload
    g.shadow_context = None
    return None


def _unauthorized(message: str, *, code: str | None = None) -> Response:
    payload = {"error": message}
    if code:
        payload["code"] = code
    return jsonify(payload), 401


def _forbidden(message: str, *, code: str | None = None) -> Response:
    payload = {"error": message}
    if code:
        payload["code"] = code
    return jsonify(payload), 403
