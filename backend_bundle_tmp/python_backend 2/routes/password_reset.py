from __future__ import annotations

from flask import Blueprint, request

from ..services import auth_service
from ..utils.http import handle_action

blueprint = Blueprint("password_reset", __name__, url_prefix="/api/password-reset")


@blueprint.post("/request")
def request_reset():
    payload = request.get_json(force=True, silent=True) or {}
    email = payload.get("email")
    return handle_action(lambda: auth_service.request_password_reset(email))


@blueprint.post("/reset")
def reset_password():
    payload = request.get_json(force=True, silent=True) or {}
    return handle_action(lambda: auth_service.reset_password(payload))
