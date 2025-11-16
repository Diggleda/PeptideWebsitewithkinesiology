from __future__ import annotations

import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

try:
    import stripe  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    stripe = None

from ..services import get_config
from ..repositories import order_repository


class StripeIntegrationError(RuntimeError):
    def __init__(self, message: str, status: int = 500, response: Optional[Dict] = None):
        super().__init__(message)
        self.status = status
        self.response = response


def is_configured() -> bool:
    config = get_config()
    data = config.stripe
    return bool(data.get("onsite_enabled") and data.get("secret_key"))


def create_payment_intent(order: Dict[str, Any]) -> Dict[str, Any]:
    """Create a Stripe PaymentIntent for an order. Returns a status payload suitable for the API."""
    config = get_config()
    if not config.stripe.get("onsite_enabled"):
        return {"status": "skipped", "reason": "stripe_disabled"}
    if not config.stripe.get("secret_key"):
        return {"status": "error", "message": "Stripe not configured"}
    if stripe is None:
        return {"status": "error", "message": "Stripe SDK not installed on server"}

    stripe.api_key = config.stripe.get("secret_key")
    amount = int(round(float(order.get("total", 0)) * 100))
    currency = "usd"
    metadata = {
        "peppro_order_id": order.get("id"),
        "user_id": order.get("userId"),
    }
    if order.get("wooOrderId"):
        metadata["woo_order_id"] = order.get("wooOrderId")
    if order.get("wooOrderKey"):
        metadata["woo_order_key"] = order.get("wooOrderKey")

    try:
        intent = stripe.PaymentIntent.create(
            amount=amount,
            currency=currency,
            metadata=metadata,
            description=f"PepPro Order {order.get('id')}",
            automatic_payment_methods={"enabled": True},
        )
        return {
            "status": "success",
            "clientSecret": intent.get("client_secret"),
            "paymentIntentId": intent.get("id"),
        }
    except Exception as exc:  # pragma: no cover - network error path
        logger.error("Stripe PaymentIntent creation failed", exc_info=True, extra={"orderId": order.get("id")})
        raise StripeIntegrationError("Stripe PaymentIntent creation failed", response=getattr(exc, "json_body", None))


def parse_webhook(payload: bytes, signature: Optional[str]) -> Dict[str, Any]:
    """Best-effort webhook parser. Returns event dict or raises on signature mismatch."""
    config = get_config()
    if not config.stripe.get("webhook_secret") or stripe is None:
        raise StripeIntegrationError("Stripe webhook not configured", status=400)
    try:
        event = stripe.Webhook.construct_event(payload, signature, config.stripe["webhook_secret"])
        return event
    except Exception as exc:  # pragma: no cover - signature/parse error
        logger.warning("Stripe webhook parse failed", exc_info=True)
        raise StripeIntegrationError("Invalid Stripe webhook", status=400) from exc


def retrieve_payment_intent(payment_intent_id: str) -> Dict[str, Any]:
    config = get_config()
    if not config.stripe.get("onsite_enabled"):
        return {"status": "skipped", "reason": "stripe_disabled"}
    if not config.stripe.get("secret_key"):
        raise StripeIntegrationError("Stripe not configured", status=500)
    if stripe is None:
        raise StripeIntegrationError("Stripe SDK not installed", status=500)

    stripe.api_key = config.stripe.get("secret_key")
    try:
        intent = stripe.PaymentIntent.retrieve(payment_intent_id)
        return {"status": intent.get("status"), "intent": intent}
    except Exception as exc:
        logger.error("Stripe PaymentIntent retrieve failed", exc_info=True, extra={"paymentIntentId": payment_intent_id})
        raise StripeIntegrationError("Stripe PaymentIntent retrieve failed", status=500, response=getattr(exc, "json_body", None))


def finalize_payment_intent(payment_intent_id: str) -> Dict[str, Any]:
    result = retrieve_payment_intent(payment_intent_id)
    intent = result.get("intent") or {}
    metadata = intent.get("metadata") or {}
    order_id = metadata.get("peppro_order_id")

    if order_id:
        order = order_repository.find_by_id(order_id)
        if order:
            order["paymentIntentId"] = payment_intent_id
            order["status"] = "paid" if intent.get("status") == "succeeded" else order.get("status", "pending")
            order_repository.update(order)

    return {"status": result.get("status"), "paymentIntentId": payment_intent_id, "orderId": order_id}
