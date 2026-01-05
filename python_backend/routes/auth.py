from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
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
@require_auth
def logout():
    user_id = g.current_user.get("id")
    role = g.current_user.get("role")
    return handle_action(lambda: auth_service.logout(user_id, role))


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
