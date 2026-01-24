from __future__ import annotations

import os
from datetime import datetime, timezone
from functools import wraps
from typing import Callable, TypeVar

import jwt
from flask import Response, jsonify, request, g

from ..services import get_config
from ..services import auth_service, presence_service
from ..repositories import user_repository, sales_rep_repository

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
        header = request.headers.get("Authorization", "")
        if not header:
            return _unauthorized("Access token required", code="TOKEN_REQUIRED")

        parts = header.split()
        token = parts[1] if len(parts) == 2 else parts[0]

        try:
            payload = jwt.decode(token, get_config().jwt_secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return _forbidden("Token expired", code="TOKEN_EXPIRED")
        except jwt.InvalidTokenError:
            return _forbidden("Invalid token", code="TOKEN_INVALID")

        user_id = payload.get("id")
        if not user_id:
            return _forbidden("Invalid token", code="TOKEN_INVALID")

        role = (payload.get("role") or "").strip().lower()
        token_session_id = payload.get("sid") or payload.get("sessionId")
        if not token_session_id or not isinstance(token_session_id, str):
            return _forbidden("Invalid token", code="TOKEN_INVALID")

        exempt_multi_session = (payload.get("email") or "").strip().lower() == "test@doctor.com"

        user = None
        rep = None
        if role == "sales_rep":
            rep = sales_rep_repository.find_by_id(str(user_id))
            if rep and rep.get("sessionId"):
                stored_session_id = rep.get("sessionId")
            else:
                # Some sales reps authenticate via the `users` table (role=sales_rep) rather than `sales_reps`.
                user = user_repository.find_by_id(str(user_id))
                stored_session_id = user.get("sessionId") if user else None
        else:
            user = user_repository.find_by_id(str(user_id))
            stored_session_id = user.get("sessionId") if user else None

        if not stored_session_id or not isinstance(stored_session_id, str):
            return _forbidden("Token revoked", code="TOKEN_REVOKED")

        if stored_session_id != token_session_id and not exempt_multi_session:
            return _forbidden("Token revoked", code="TOKEN_REVOKED")

        # Enforce max session age + idle timeouts server-side.
        # This prevents "stuck online" sessions when the client stops running timers.
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
            or _parse_datetime((rep or {}).get("lastLoginAt"))
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

        # Prefer persisted interaction timestamps when available; otherwise fall back to in-memory presence.
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
        return func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


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
