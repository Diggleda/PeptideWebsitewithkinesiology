from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import order_service
from ..utils.http import handle_action

blueprint = Blueprint("orders", __name__, url_prefix="/api/orders")


@blueprint.post("/")
@require_auth
def create_order():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    total = payload.get("total")
    referral_code = payload.get("referralCode")
    user_id = g.current_user.get("id")
    return handle_action(lambda: order_service.create_order(user_id, items, total, referral_code))


@blueprint.get("/")
@require_auth
def list_orders():
    user_id = g.current_user.get("id")
    return handle_action(lambda: order_service.get_orders_for_user(user_id))
