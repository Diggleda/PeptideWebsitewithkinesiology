from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import discount_code_service
from ..utils.http import handle_action


blueprint = Blueprint("discount_codes", __name__, url_prefix="/api/discount-codes")


@blueprint.post("/preview")
@require_auth
def preview_code():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        code = payload.get("code") or payload.get("discountCode") or payload.get("discount_code") or ""
        items_subtotal = payload.get("itemsSubtotal") or payload.get("subtotal") or payload.get("items_subtotal") or 0
        cart_quantity = payload.get("cartQuantity") or payload.get("cart_quantity") or payload.get("cartQty") or 0
        if not cart_quantity and isinstance(payload.get("items"), list):
            try:
                cart_quantity = sum(float((item or {}).get("quantity") or 0) for item in (payload.get("items") or []))
            except Exception:
                cart_quantity = 0
        try:
            subtotal = float(items_subtotal or 0)
        except Exception:
            subtotal = 0.0
        return discount_code_service.preview_discount_for_user(
            user_id=g.current_user.get("id"),
            code=str(code),
            items_subtotal=subtotal,
            cart_quantity=cart_quantity,
        )

    return handle_action(action)
