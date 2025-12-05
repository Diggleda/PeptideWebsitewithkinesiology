from __future__ import annotations

import logging
import json
from typing import Any, Dict, Optional
from datetime import datetime

logger = logging.getLogger(__name__)

try:
    import stripe  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    stripe = None

from ..services import get_config
from ..repositories import order_repository
from . import woo_commerce


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
    woo_order_id = order.get("wooOrderId")
    if woo_order_id:
        metadata["woo_order_id"] = woo_order_id
    if order.get("wooOrderKey"):
        metadata["woo_order_key"] = order.get("wooOrderKey")
    woo_order_number = order.get("wooOrderNumber") or woo_order_id
    normalized_woo_number = None
    if woo_order_number is not None:
        try:
            normalized_woo_number = str(woo_order_number).strip()
        except Exception:
            normalized_woo_number = None
        if normalized_woo_number:
            normalized_woo_number = normalized_woo_number.lstrip("#") or None
    if normalized_woo_number:
        metadata["woo_order_number"] = normalized_woo_number

    try:
        description_parts = []
        if normalized_woo_number:
            description_parts.append(f"Woo Order #{normalized_woo_number}")
        if order.get("id"):
            description_parts.append(f"PepPro Order {order.get('id')}")
        description = " · ".join(description_parts) if description_parts else "PepPro Order"
        intent = stripe.PaymentIntent.create(
            amount=amount,
            currency=currency,
            metadata=metadata,
            description=description,
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
        intent = stripe.PaymentIntent.retrieve(
            payment_intent_id,
            expand=[
                "charges.data.payment_method_details.card",
                "charges.data.payment_method_details.card_present",
                "charges.data.payment_method_details.card_swipe",
                "charges.data.payment_method_details.klarna",
                "latest_charge.payment_method_details.card",
                "latest_charge.payment_method_details.card_present",
            ],
        )
        return {"status": intent.get("status"), "intent": intent}
    except Exception as exc:
        logger.error("Stripe PaymentIntent retrieve failed", exc_info=True, extra={"paymentIntentId": payment_intent_id})
        raise StripeIntegrationError("Stripe PaymentIntent retrieve failed", status=500, response=getattr(exc, "json_body", None))


def _title_case(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    spaced = str(value).replace("_", " ").replace("-", " ").strip()
    if not spaced:
        return None
    return " ".join(part.capitalize() for part in spaced.split())


def _extract_card_summary(intent: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    charges = intent.get("charges", {}).get("data")
    if not isinstance(charges, list) or not charges:
        return None
    charge = charges[-1] or {}
    details = charge.get("payment_method_details") or {}
    card_details = (
        details.get("card")
        or details.get("card_present")
        or details.get("card_swipe")
        or details.get("klarna")
        or None
    )
    if not card_details:
        return None
    brand = (
        _title_case(card_details.get("brand"))
        or _title_case(card_details.get("card_brand"))
        or _title_case(card_details.get("network"))
        or "Card"
    )
    last4 = (
        card_details.get("last4")
        or card_details.get("card_last4")
        or card_details.get("number_last4")
        or None
    )
    if not last4:
        return None
    return {"brand": brand, "last4": last4}


def _apply_card_summary(order: Dict[str, Any], card_summary: Optional[Dict[str, Any]], stripe_data: Dict[str, Any]) -> Dict[str, Any]:
    if not card_summary:
        return {
            "paymentMethod": order.get("paymentMethod"),
            "paymentDetails": order.get("paymentDetails") or order.get("paymentMethod"),
            "stripeMeta": stripe_data,
        }
    label = f"{card_summary.get('brand') or 'Card'} •••• {card_summary.get('last4')}"
    stripe_meta = {
        **stripe_data,
        "cardBrand": card_summary.get("brand"),
        "cardLast4": card_summary.get("last4"),
    }
    return {
        "paymentMethod": label,
        "paymentDetails": label,
        "stripeMeta": stripe_meta,
    }


def ensure_order_card_summary(order: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not order or not order.get("paymentIntentId"):
        return order

    integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
    stripe_meta = _ensure_dict(integrations.get("stripe"))
    if order.get("paymentDetails") or stripe_meta.get("cardLast4"):
        return order

    payment_intent_id = order.get("paymentIntentId")
    try:
        intent_result = retrieve_payment_intent(payment_intent_id)
    except StripeIntegrationError:
        return order

    intent = intent_result.get("intent") or {}
    card_summary = _extract_card_summary(intent)
    if not card_summary:
        return order

    stripe_meta.update(
        {
            "eventType": intent.get("status"),
            "paymentIntentId": payment_intent_id,
            "lastSyncAt": datetime.utcnow().isoformat(),
        }
    )
    applied = _apply_card_summary(order, card_summary, stripe_meta)
    order["paymentMethod"] = applied["paymentMethod"] or order.get("paymentMethod") or "Card on file"
    order["paymentDetails"] = (
        applied["paymentDetails"]
        or order.get("paymentDetails")
        or order.get("paymentMethod")
        or applied["paymentMethod"]
    )
    integrations["stripe"] = applied["stripeMeta"]
    order["integrationDetails"] = integrations
    order_repository.update(order)
    return order


def finalize_payment_intent(payment_intent_id: str) -> Dict[str, Any]:
    result = retrieve_payment_intent(payment_intent_id)
    intent = result.get("intent") or {}
    metadata = intent.get("metadata") or {}
    order_id = metadata.get("peppro_order_id")
    order = order_repository.find_by_id(order_id) if order_id else None
    woo_order_id = _resolve_woo_order_id(metadata, order)
    order_key = _resolve_order_key(metadata, order)

    woo_update = None
    if woo_order_id:
        try:
            woo_update = woo_commerce.mark_order_paid(
                {
                    "woo_order_id": woo_order_id,
                    "payment_intent_id": payment_intent_id,
                    "order_key": order_key,
                }
            )
        except Exception as exc:
            logger.error(
                "Failed to mark Woo order paid from Stripe finalize",
                exc_info=True,
                extra={"wooOrderId": woo_order_id, "paymentIntentId": payment_intent_id},
            )

    if order:
        order["paymentIntentId"] = payment_intent_id
        order["status"] = "paid" if intent.get("status") == "succeeded" else order.get("status", "pending")
        if woo_order_id and not order.get("wooOrderId"):
            order["wooOrderId"] = woo_order_id
        existing_integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        stripe_meta = _ensure_dict(existing_integrations.get("stripe"))
        stripe_meta.update(
            {
                "eventType": intent.get("status"),
                "paymentIntentId": payment_intent_id,
                "lastSyncAt": datetime.utcnow().isoformat(),
                "wooUpdate": woo_update,
            }
        )
        card_summary = _extract_card_summary(intent)
        if card_summary:
            logger.info(
                "Stripe card summary applied to order",
                extra={
                    "orderId": order.get("id"),
                    "paymentIntentId": payment_intent_id,
                    "cardBrand": card_summary.get("brand"),
                    "cardLast4": card_summary.get("last4"),
                },
            )
        applied = _apply_card_summary(order, card_summary, stripe_meta)
        order["paymentMethod"] = applied["paymentMethod"] or order.get("paymentMethod") or "Card on file"
        order["paymentDetails"] = (
            applied["paymentDetails"]
            or order.get("paymentDetails")
            or order.get("paymentMethod")
            or applied["paymentMethod"]
        )
        order["integrationDetails"] = {
            **existing_integrations,
            "stripe": applied["stripeMeta"],
        }
        order_repository.update(order)

    return {
        "status": result.get("status"),
        "paymentIntentId": payment_intent_id,
        "orderId": order_id,
        "wooOrderId": woo_order_id,
        "wooUpdate": woo_update,
    }


def _ensure_dict(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _resolve_woo_order_id(metadata: Dict[str, Any], order: Optional[Dict]) -> Optional[str]:
    primary = metadata.get("woo_order_id") or metadata.get("wooOrderId")
    if primary:
        return str(primary)
    if not order:
        return None
    candidates = [
        order.get("wooOrderId"),
        order.get("woo_order_id"),
    ]
    integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
    woo_details = _ensure_dict(integrations.get("wooCommerce") or integrations.get("woocommerce"))
    for payload in (woo_details.get("response"), woo_details.get("payload")):
        data = _ensure_dict(payload)
        if data.get("id"):
            candidates.append(data.get("id"))
    for candidate in candidates:
        if candidate:
            return str(candidate)
    return None


def _resolve_order_key(metadata: Dict[str, Any], order: Optional[Dict]) -> Optional[str]:
    for key in ("woo_order_key", "wooOrderKey", "order_key"):
        if metadata.get(key):
            return str(metadata.get(key))
    if order and order.get("wooOrderKey"):
        return str(order.get("wooOrderKey"))
    return None


def refund_payment_intent(payment_intent_id: str, amount_cents: Optional[int] = None, reason: Optional[str] = None, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Issue a refund for a PaymentIntent. Returns a summary dict or raises StripeIntegrationError."""
    config = get_config()
    if not config.stripe.get("onsite_enabled"):
        return {"status": "skipped", "reason": "stripe_disabled"}
    if not config.stripe.get("secret_key"):
        raise StripeIntegrationError("Stripe not configured", status=500)
    if stripe is None:
        raise StripeIntegrationError("Stripe SDK not installed", status=500)

    stripe.api_key = config.stripe.get("secret_key")
    try:
        params: Dict[str, Any] = {"payment_intent": payment_intent_id}
        if amount_cents is not None:
            params["amount"] = int(amount_cents)
        if reason:
            params["reason"] = "requested_by_customer"
        if metadata:
            params["metadata"] = metadata
        refund = stripe.Refund.create(**params)
        return {
          "id": refund.get("id"),
          "amount": refund.get("amount"),
          "currency": refund.get("currency"),
          "status": refund.get("status"),
        }
    except Exception as exc:
        logger.error("Stripe refund failed", exc_info=True, extra={"paymentIntentId": payment_intent_id})
        raise StripeIntegrationError("Stripe refund failed", status=502, response=getattr(exc, "json_body", None)) from exc
