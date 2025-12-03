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
    shipping_total = payload.get("shippingTotal")
    shipping_address = payload.get("shippingAddress")
    # Support both keys from frontend/backends
    shipping_rate = payload.get("shippingRate") or payload.get("shippingEstimate")
    physician_certified = bool(
        payload.get("physicianCertificationAccepted")
        or payload.get("physicianCertification")
    )
    user_id = g.current_user.get("id")
    return handle_action(
        lambda: order_service.create_order(
            user_id=user_id,
            items=items,
            total=total,
            referral_code=referral_code,
            shipping_total=shipping_total,
            shipping_address=shipping_address,
            shipping_rate=shipping_rate,
            physician_certified=physician_certified,
        )
    )


@blueprint.get("/")
@require_auth
def list_orders():
    user_id = g.current_user.get("id")
    return handle_action(lambda: order_service.get_orders_for_user(user_id))


@blueprint.get("/sales-rep")
@require_auth
def list_orders_for_sales_rep():
    def action():
        sales_rep_id = g.current_user.get("id")
        return order_service.get_orders_for_sales_rep(sales_rep_id, include_doctors=True)

    return handle_action(action)


@blueprint.post("/<order_id>/cancel")
@require_auth
def cancel_order(order_id: str):
    payload = request.get_json(force=True, silent=True) or {}
    reason = (payload.get("reason") or "").strip()
    user_id = g.current_user.get("id")
    return handle_action(lambda: order_service.cancel_order(user_id=user_id, order_id=order_id, reason=reason))


@blueprint.get("/admin/sales-rep-summary")
@require_auth
def admin_sales_by_rep():
    exclude_id = g.current_user.get("id")
    return handle_action(lambda: order_service.get_sales_by_rep(exclude_sales_rep_id=exclude_id))
