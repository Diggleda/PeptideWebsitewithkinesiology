from __future__ import annotations

from flask import Blueprint, g, request

import jwt

from ..middleware.auth import require_auth
from ..repositories import sales_rep_repository, user_repository
from ..services import get_config
from ..services import auth_service
from ..services import presence_service
from ..utils.http import handle_action

blueprint = Blueprint("auth", __name__, url_prefix="/api/auth")

def _audit_enabled() -> bool:
    import os
    return str(os.environ.get("AUTH_AUDIT_LOGS") or "").strip().lower() in ("1", "true", "yes", "on")

def _audit(event: str, details: dict) -> None:
    if not _audit_enabled():
        return
    import logging
    try:
        logging.getLogger("peppro.auth_audit").info("auth_audit %s", {"event": event, **(details or {})})
    except Exception:
        pass


@blueprint.post("/register")
def register():
    payload = request.get_json(force=True, silent=True) or {}
    return handle_action(lambda: auth_service.register(payload))


@blueprint.post("/login")
def login():
    payload = request.get_json(force=True, silent=True) or {}
    return handle_action(lambda: auth_service.login(payload))


@blueprint.get("/check-email")
def check_email():
    email = request.args.get("email", "")
    return handle_action(lambda: auth_service.check_email(email))


@blueprint.get("/me")
@require_auth
def me():
    user_id = g.current_user.get("id")
    role = g.current_user.get("role")
    return handle_action(lambda: auth_service.get_profile(user_id, role))


@blueprint.post("/logout")
def logout():
    """
    Idempotent logout endpoint.

    If the caller presents a valid *current* token, revoke it server-side.
    If the token is missing/expired/invalid/revoked, return 200 anyway so clients
    can clear local state without surfacing noisy 401/403 console errors.
    """

    def action():
        header = request.headers.get("Authorization", "")
        if not header:
            _audit("LOGOUT_REQUEST_NOAUTH", {"at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")})
            return {"ok": True}

        parts = header.split()
        token = parts[1] if len(parts) == 2 else parts[0]
        expired_token = False
        try:
            payload = jwt.decode(token, get_config().jwt_secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            expired_token = True
            # If the token is expired but otherwise valid, we can still honor logout
            # (mark offline + rotate session id) as long as the session id matches.
            try:
                payload = jwt.decode(
                    token,
                    get_config().jwt_secret,
                    algorithms=["HS256"],
                    options={"verify_exp": False},
                )
            except jwt.InvalidTokenError:
                _audit("LOGOUT_REQUEST_INVALID", {"reason": "EXPIRED_INVALID", "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")})
                return {"ok": True}
        except jwt.InvalidTokenError:
            _audit("LOGOUT_REQUEST_INVALID", {"reason": "INVALID_TOKEN", "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")})
            return {"ok": True}

        user_id = payload.get("id")
        role = (payload.get("role") or "").strip().lower()
        token_session_id = payload.get("sid") or payload.get("sessionId")

        if not user_id or not isinstance(token_session_id, str) or not token_session_id.strip():
            _audit(
                "LOGOUT_REQUEST_INVALID",
                {
                    "reason": "MISSING_FIELDS",
                    "userId": user_id,
                    "role": role,
                    "expiredToken": expired_token,
                    "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            )
            return {"ok": True}

        # Only revoke the token if it matches the currently stored session id.
        if role == "sales_rep":
            rep = sales_rep_repository.find_by_id(str(user_id))
            if rep and rep.get("sessionId"):
                stored_session_id = rep.get("sessionId")
            else:
                user = user_repository.find_by_id(str(user_id))
                stored_session_id = user.get("sessionId") if user else None
        else:
            user = user_repository.find_by_id(str(user_id))
            stored_session_id = user.get("sessionId") if user else None

        if not stored_session_id or str(stored_session_id) != str(token_session_id):
            _audit(
                "LOGOUT_REQUEST_IGNORED",
                {
                    "reason": "SESSION_MISMATCH",
                    "userId": str(user_id),
                    "role": role,
                    "expiredToken": expired_token,
                    "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
                },
            )
            return {"ok": True}

        _audit(
            "LOGOUT_REQUEST_ACCEPTED",
            {
                "userId": str(user_id),
                "role": role,
                "expiredToken": expired_token,
                "at": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z"),
            },
        )
        result = auth_service.logout(str(user_id), payload.get("role"))
        try:
            presence_service.clear_user(str(user_id))
        except Exception:
            pass
        return result

    return handle_action(action)


@blueprint.post("/verify-npi")
def verify_npi():
    payload = request.get_json(force=True, silent=True) or {}
    npi_number = payload.get("npiNumber") or payload.get("npi_number")
    return handle_action(lambda: auth_service.verify_npi(npi_number))


@blueprint.put("/me")
@require_auth
def update_me():
    user_id = g.current_user.get("id")
    payload = request.get_json(force=True, silent=True) or {}
    return handle_action(lambda: auth_service.update_profile(user_id, payload))
