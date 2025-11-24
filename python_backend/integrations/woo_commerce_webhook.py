from typing import Any, Dict, List

from ..config import get_config
from ..repositories import credit_ledger_repository, user_repository
from ..services.email_service import send_template
from .service_error import ServiceError
from logging import getLogger

logger = getLogger(__name__)

def handle_order_updated(order_data: Dict[str, Any]) -> Dict[str, Any]:
    """Handle the 'order.updated' event."""
    order_id = order_data.get("id")
    order_status = order_data.get("status")
    customer_email = order_data.get("billing", {}).get("email")

    if not all([order_id, order_status, customer_email]):
        raise ServiceError("Missing required order data", 400)

    if order_status != "refunded":
        return {"status": "skipped", "reason": "not_a_refund"}

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
    current_balance = float(user.get("referralCredits", 0))
    new_balance = current_balance + refund_amount
    user_repository.update({**user, "referralCredits": new_balance})

    logger.info(
        f"Processed refund for order #{order_id}. "
        f"Added {refund_amount} to credit balance for user {user['id']}"
    )

    return {"status": "processed", "ledger_entry_id": ledger_entry["id"]}


def handle_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Handle a WooCommerce webhook event.
    """
    # The actual order data is nested inside the 'arg' key for order.updated
    order_data = event.get("arg")

    if not order_data:
        raise ServiceError("Invalid webhook payload", 400)

    # The topic is not always available, so we infer from the presence of 'arg'
    # and the structure of the payload.
    if "status" in order_data and "id" in order_data:
        return handle_order_updated(order_data)

    logger.warning("Unhandled WooCommerce webhook event", extra={"event": event})
    return {"status": "unhandled_event"}
