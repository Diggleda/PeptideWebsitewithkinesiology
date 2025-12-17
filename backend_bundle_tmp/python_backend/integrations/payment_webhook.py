from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from ..services import get_config
from . import stripe_payments, woo_commerce
from ..repositories import order_repository

logger = logging.getLogger(__name__)


def handle_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """Handle Stripe webhook events and, when applicable, mark Woo orders paid."""
    if not event or "type" not in event:
        return {"received": False, "reason": "invalid_event"}

    event_type = event.get("type")
    data_obj = event.get("data", {}).get("object", {}) or {}

    if event_type == "payment_intent.succeeded":
        _finalize_payment_intent_and_woo(data_obj)
    elif event_type == "charge.succeeded":
        pi_id = data_obj.get("payment_intent")
        if pi_id:
            _finalize_payment_intent_and_woo({"id": pi_id})

    return {"received": True, "type": event_type}


def _finalize_payment_intent_and_woo(intent: Dict[str, Any]) -> None:
    if not intent:
        return
    pi_id = intent.get("id")
    if not pi_id:
        return

    # Finalize local order record if present
    try:
        stripe_payments.finalize_payment_intent(pi_id)
    except Exception as exc:
        logger.warning("Stripe finalize intent failed", exc_info=True, extra={"piId": pi_id})

    metadata = intent.get("metadata") or {}
    woo_order_id = metadata.get("woo_order_id") or metadata.get("wooOrderId")
    if not woo_order_id:
        return

    # Update Woo order status to paid/processing
    try:
        woo_commerce.mark_order_paid(
            {
                "woo_order_id": woo_order_id,
                "payment_intent_id": pi_id,
                "order_key": metadata.get("woo_order_key") or metadata.get("order_key"),
            }
        )
    except Exception as exc:
        logger.error("Failed to mark Woo order paid", exc_info=True, extra={"wooOrderId": woo_order_id, "piId": pi_id})
