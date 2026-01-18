from typing import Any, Dict, List

from ..config import get_config
from ..repositories import credit_ledger_repository, user_repository
from ..services import order_service
from ..services.email_service import send_template
from .service_error import ServiceError
from logging import getLogger

logger = getLogger(__name__)

def handle_order_updated(order_data: Dict[str, Any]) -> Dict[str, Any]:
    """Handle the 'order.updated' event."""
    order_id = order_data.get("id")
    order_status = order_data.get("status")
    customer_email = order_data.get("billing", {}).get("email")

    if not order_id or not order_status:
        raise ServiceError("Missing required order data", 400)

    if order_status != "refunded":
        # Mirror status locally (best-effort) so PepPro reflects Woo changes promptly.
        try:
            return order_service.sync_order_status_from_woo_webhook(order_data)
        except Exception:
            logger.warning("Failed to sync local order from Woo webhook", exc_info=True)
            return {"status": "skipped", "reason": "local_sync_failed"}

    if not customer_email:
        raise ServiceError("Missing required order data", 400)

    # Find the user by email
    user = user_repository.find_by_email(customer_email)
    if not user:
        raise ServiceError(f"User with email {customer_email} not found", 404)

    # Calculate the refund amount
    # WooCommerce sends the total as a negative value for refunds
    refund_amount = abs(float(order_data.get("total", 0)))

    # Add the refund to the user's credit ledger
    ledger_entry = credit_ledger_repository.insert(
        {
            "doctor_id": user["id"],
            "amount": refund_amount,
            "direction": "credit",
            "reason": "order_refund",
            "description": f"Credit from refunded order #{order_id}",
            "related_entity_type": "order",
            "related_entity_id": str(order_id),
        }
    )

    # Update the user's credit balance
    updated_user = user_repository.adjust_referral_credits(user["id"], refund_amount) or {
        **user,
        "referralCredits": float(user.get("referralCredits", 0)) + refund_amount,
    }

    logger.info(
        f"Processed refund for order #{order_id}. "
        f"Added {refund_amount} to credit balance for user {updated_user['id']}"
    )

    return {"status": "processed", "ledger_entry_id": ledger_entry["id"]}


def handle_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle a WooCommerce webhook event.
    """
    if not isinstance(event, dict):
        raise ServiceError("Invalid webhook payload", 400)

    # Standard WooCommerce webhooks send the order object directly.
    # Some systems may wrap it (e.g. `{arg: {...}}` or `{order: {...}}`).
    order_data = event.get("arg")
    if not isinstance(order_data, dict):
        order_data = event.get("order")
    if not isinstance(order_data, dict) and "id" in event and "status" in event:
        order_data = event

    if not isinstance(order_data, dict):
        raise ServiceError("Invalid webhook payload", 400)

    # The topic is not always available, so we infer from the presence of 'arg'
    # and the structure of the payload.
    if "status" in order_data and "id" in order_data:
        return handle_order_updated(order_data)

    logger.warning("Unhandled WooCommerce webhook event", extra={"event": event})
    return {"status": "unhandled_event"}
