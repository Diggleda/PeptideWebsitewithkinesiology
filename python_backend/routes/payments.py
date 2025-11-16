from __future__ import annotations

import json

from flask import Blueprint, request

from ..integrations import stripe_payments
from ..middleware.auth import require_auth
from ..utils.http import handle_action

blueprint = Blueprint("payments", __name__, url_prefix="/api/payments")


@blueprint.post("/intent")
@require_auth
def create_intent():
    payload = request.get_json(force=True, silent=True) or {}
    order_id = payload.get("orderId")
    total = payload.get("total")
    if not order_id or total is None:
        return {"error": "orderId and total are required"}, 400
    order = {
        "id": order_id,
        "total": total,
        "userId": getattr(getattr(request, "user", None), "id", None) or None,
    }
    return handle_action(lambda: stripe_payments.create_payment_intent(order))


@blueprint.post("/stripe/confirm")
@require_auth
def confirm_intent():
    payload = request.get_json(force=True, silent=True) or {}
    payment_intent_id = payload.get("paymentIntentId")
    if not payment_intent_id:
        return {"error": "paymentIntentId is required"}, 400
    return handle_action(lambda: stripe_payments.finalize_payment_intent(payment_intent_id))


@blueprint.post("/stripe/webhook")
def handle_stripe_webhook():
    payload = request.get_data()
    sig_header = request.headers.get("Stripe-Signature")
    try:
        event = stripe_payments.parse_webhook(payload, sig_header)
    except stripe_payments.StripeIntegrationError as exc:
        return {"error": str(exc)}, getattr(exc, "status", 400)
    # Placeholder: in a full implementation, update Woo order/payment state based on event["type"].
    try:
        event_json = event if isinstance(event, dict) else json.loads(str(event))
    except Exception:
        event_json = {"type": "unknown"}
    return {"received": True, "type": event_json.get("type")}
