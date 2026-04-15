from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..integrations import ups_tracking
from ..repositories import order_repository, user_repository
from . import email_service

logger = logging.getLogger(__name__)

_EMAIL_ELIGIBLE_STATUSES = {"shipped", "out_for_delivery", "delivered"}


def _coerce_object(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _normalize_status(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    lowered = text.lower().replace("-", "_").replace(" ", "_")
    while "__" in lowered:
        lowered = lowered.replace("__", "_")
    if lowered == "shipped":
        return "shipped"
    normalized = ups_tracking.normalize_tracking_status(lowered)
    if not normalized or normalized == "unknown":
        return None
    return normalized


def _extract_integrations(order: Dict[str, Any]) -> Dict[str, Any]:
    return _coerce_object(order.get("integrations") or order.get("integrationDetails"))


def _extract_notification_state(order: Dict[str, Any]) -> Dict[str, Any]:
    integrations = _extract_integrations(order)
    pep_pro = _coerce_object(
        integrations.get("pepProNotifications")
        or integrations.get("pepproNotifications")
        or integrations.get("pep_pro_notifications")
    )
    return _coerce_object(
        pep_pro.get("shippingStatusEmails")
        or pep_pro.get("shipping_status_emails")
    )


def _extract_tracking_number(order: Dict[str, Any]) -> Optional[str]:
    direct = str(order.get("trackingNumber") or "").strip()
    if direct:
        return direct
    estimate = _coerce_object(order.get("shippingEstimate"))
    for candidate in (
        estimate.get("trackingNumber"),
        estimate.get("tracking_number"),
    ):
        text = str(candidate or "").strip()
        if text:
            return text
    shipstation = _coerce_object(_extract_integrations(order).get("shipStation") or _extract_integrations(order).get("shipstation"))
    text = str(shipstation.get("trackingNumber") or shipstation.get("tracking_number") or "").strip()
    return text or None


def _extract_carrier_code(order: Dict[str, Any]) -> Optional[str]:
    estimate = _coerce_object(order.get("shippingEstimate"))
    shipstation = _coerce_object(_extract_integrations(order).get("shipStation") or _extract_integrations(order).get("shipstation"))
    for candidate in (
        order.get("shippingCarrier"),
        estimate.get("carrierId"),
        estimate.get("carrier_id"),
        shipstation.get("carrierCode"),
        shipstation.get("carrier_code"),
    ):
        text = str(candidate or "").strip()
        if text:
            return text
    return None


def _extract_recipient(order: Dict[str, Any]) -> tuple[Optional[str], Optional[str]]:
    user_id = str(
        order.get("userId")
        or order.get("user_id")
        or order.get("doctorId")
        or ""
    ).strip()
    user = user_repository.find_by_id(user_id) if user_id else None
    shipping_address = _coerce_object(order.get("shippingAddress") or order.get("shipping_address"))
    billing_address = _coerce_object(order.get("billingAddress") or order.get("billing_address"))

    recipient = None
    for candidate in (
        (user or {}).get("email"),
        order.get("doctorEmail"),
        order.get("billingEmail"),
        billing_address.get("email"),
        shipping_address.get("email"),
    ):
        text = str(candidate or "").strip()
        if text and "@" in text:
            recipient = text
            break

    customer_name = None
    for candidate in (
        (user or {}).get("name"),
        order.get("doctorName"),
        billing_address.get("name"),
        shipping_address.get("name"),
    ):
        text = str(candidate or "").strip()
        if text:
            customer_name = text
            break

    return recipient, customer_name


def _extract_delivery_label(order: Dict[str, Any], status: str) -> Optional[str]:
    estimate = _coerce_object(order.get("shippingEstimate"))
    if status == "delivered":
        for candidate in (
            order.get("upsDeliveredAt"),
            estimate.get("deliveredAt"),
            estimate.get("delivered_at"),
            order.get("deliveryDate"),
            order.get("delivery_date"),
        ):
            text = str(candidate or "").strip()
            if text:
                return text
        return None
    for candidate in (
        order.get("deliveryDate"),
        order.get("delivery_date"),
        order.get("expectedShipmentWindow"),
        order.get("expected_shipment_window"),
        estimate.get("deliveryDateGuaranteed"),
        estimate.get("delivery_date_guaranteed"),
        estimate.get("estimatedArrivalDate"),
        estimate.get("estimated_arrival_date"),
    ):
        text = str(candidate or "").strip()
        if text:
            return text
    return None


def _mark_sent(order: Dict[str, Any], status: str, recipient: str) -> None:
    integrations = _extract_integrations(order)
    pep_pro = _coerce_object(
        integrations.get("pepProNotifications")
        or integrations.get("pepproNotifications")
        or integrations.get("pep_pro_notifications")
    )
    shipping_state = _coerce_object(
        pep_pro.get("shippingStatusEmails")
        or pep_pro.get("shipping_status_emails")
    )
    shipping_state[status] = {
        "sentAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "recipient": recipient,
        "trackingNumber": _extract_tracking_number(order),
    }
    pep_pro["shippingStatusEmails"] = shipping_state
    integrations["pepProNotifications"] = pep_pro

    updated = dict(order)
    updated["integrations"] = integrations
    updated["integrationDetails"] = integrations
    updated["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    order_repository.update(updated)


def notify_customer_order_shipping_status(order_id: str, status: Any) -> bool:
    normalized_status = _normalize_status(status)
    normalized_order_id = str(order_id or "").strip()
    if not normalized_order_id or normalized_status not in _EMAIL_ELIGIBLE_STATUSES:
        return False

    order = order_repository.find_by_id(normalized_order_id)
    if not isinstance(order, dict):
        return False

    notification_state = _extract_notification_state(order)
    if notification_state.get(normalized_status):
        return False

    recipient, customer_name = _extract_recipient(order)
    if not recipient:
        logger.info(
            "Skipping shipping status email with no recipient",
            extra={"orderId": normalized_order_id, "status": normalized_status},
        )
        return False

    order_number = str(order.get("wooOrderNumber") or order.get("number") or order.get("id") or "").strip() or None
    tracking_number = _extract_tracking_number(order)
    carrier_code = _extract_carrier_code(order)
    delivery_label = _extract_delivery_label(order, normalized_status)

    email_service.send_order_shipping_status_email(
        recipient,
        status=normalized_status,
        customer_name=customer_name,
        order_number=order_number,
        tracking_number=tracking_number,
        carrier_code=carrier_code,
        delivery_label=delivery_label,
    )
    _mark_sent(order, normalized_status, recipient)
    logger.info(
        "Shipping status email sent",
        extra={"orderId": normalized_order_id, "status": normalized_status, "recipient": recipient},
    )
    return True
