from __future__ import annotations

from flask import Blueprint, request

from ..services import shipping_service
from ..utils.http import handle_action

blueprint = Blueprint("shipping", __name__, url_prefix="/api/shipping")


@blueprint.post("/rates")
def rates():
    def action():
        payload = request.get_json(silent=True) or {}
        address = payload.get("shippingAddress")
        items = payload.get("items") or []
        return shipping_service.get_rates(address, items)

    return handle_action(action)
