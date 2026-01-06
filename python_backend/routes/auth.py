from __future__ import annotations

from flask import Blueprint, g, request

import jwt

from ..middleware.auth import require_auth
from ..repositories import sales_rep_repository, user_repository
from ..services import get_config
from ..services import auth_service
from ..utils.http import handle_action

blueprint = Blueprint("auth", __name__, url_prefix="/api/auth")


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
            return {"ok": True}

        parts = header.split()
        token = parts[1] if len(parts) == 2 else parts[0]
        try:
            payload = jwt.decode(token, get_config().jwt_secret, algorithms=["HS256"])
        except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
            return {"ok": True}

        user_id = payload.get("id")
        role = (payload.get("role") or "").strip().lower()
        token_session_id = payload.get("sid") or payload.get("sessionId")

        if not user_id or not isinstance(token_session_id, str) or not token_session_id.strip():
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
            return {"ok": True}

        return auth_service.logout(str(user_id), payload.get("role"))

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
