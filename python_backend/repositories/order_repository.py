from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from ..services import get_config
from ..database import mysql_client
from .. import storage
from ..utils.crypto_envelope import decrypt_json, encrypt_json

HAND_DELIVERY_SERVICE_LABEL = "Hand Delivered"
_ORDERS_COLUMNS_CACHE: Optional[set[str]] = None


def _normalize_optional_string(value: object) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _normalize_optional_string_max(value: object, max_len: int) -> Optional[str]:
    text = _normalize_optional_string(value)
    if text is None:
        return None
    if len(text) <= max_len:
        return text
    return text[:max_len].rstrip() or None


def _coerce_optional_bool(value: object) -> Optional[bool]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        try:
            if not float(value) == float(value):
                return None
        except Exception:
            return None
        return float(value) != 0.0
    normalized = str(value).strip().lower()
    if not normalized:
        return None
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return None


def _normalize_fulfillment_method(value: object, fallback: object = None) -> Optional[str]:
    raw = value if value not in (None, "") else fallback
    text = str(raw or "").strip()
    if not text:
        return None
    key = text.lower().replace("-", "_").replace(" ", "_")
    if key in {"facility_pickup", "fascility_pickup"}:
        return "hand_delivered"
    if key in {"hand_delivery", "hand_delivered", "local_hand_delivery", "local_delivery"}:
        return "hand_delivered"
    return text


def _normalize_ups_tracking_status(value: object) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    text = text.replace("-", "_").replace(" ", "_")
    while "__" in text:
        text = text.replace("__", "_")
    if not text or text == "unknown":
        return None
    if "delivered" in text:
        return "delivered"
    if "out_for_delivery" in text or "outfordelivery" in text:
        return "out_for_delivery"
    if "in_transit" in text or "intransit" in text or "on_the_way" in text or "ontheway" in text:
        return "in_transit"
    if text in {"shipped", "awaiting_shipment", "awaiting"}:
        return "awaiting_shipment" if text in {"awaiting_shipment", "awaiting"} else "shipped"
    if any(
        token in text
        for token in (
            "label_created",
            "shipment_ready_for_ups",
            "shipment_information_received",
            "information_received",
            "billing_information_received",
        )
    ):
        return "label_created"
    if any(token in text for token in ("exception", "delay", "held", "hold", "error")):
        return "exception"
    return text


def _coerce_object(value: object) -> Dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        return _parse_json(value, {})
    return {}


def _normalize_tracking_number(value: object) -> str:
    return "".join(ch for ch in str(value or "") if ch.isalnum()).upper()


def _looks_like_ups_order(order: Dict) -> bool:
    if not isinstance(order, dict):
        return False

    tracking_number = _normalize_tracking_number(
        order.get("trackingNumber") if order.get("trackingNumber") is not None else order.get("tracking_number")
    )
    if tracking_number.startswith("1Z"):
        return True

    shipping_estimate = _coerce_object(order.get("shippingEstimate") or order.get("shipping"))
    integrations = _coerce_object(order.get("integrationDetails") or order.get("integrations"))
    shipstation = _coerce_object(integrations.get("shipStation") or integrations.get("shipstation"))
    carrier_tracking = _coerce_object(integrations.get("carrierTracking") or integrations.get("carrier_tracking"))
    candidates = [
        order.get("shippingCarrier"),
        order.get("shipping_carrier"),
        order.get("shippingService"),
        order.get("shipping_service"),
        shipping_estimate.get("carrierId"),
        shipping_estimate.get("carrier_id"),
        shipping_estimate.get("serviceType"),
        shipping_estimate.get("service_type"),
        shipping_estimate.get("serviceCode"),
        shipping_estimate.get("service_code"),
        shipstation.get("carrierCode"),
        shipstation.get("carrier_code"),
        carrier_tracking.get("carrier"),
    ]
    for candidate in candidates:
        token = str(candidate or "").strip().lower().replace("-", "_").replace(" ", "_")
        if token == "ups" or token.startswith("ups_"):
            return True
    return False


def _resolve_persisted_ups_tracking_status(order: Dict) -> Optional[str]:
    if not isinstance(order, dict):
        return None

    shipping_estimate = _coerce_object(order.get("shippingEstimate") or order.get("shipping"))
    integrations = _coerce_object(order.get("integrationDetails") or order.get("integrations"))
    carrier_tracking = _coerce_object(integrations.get("carrierTracking") or integrations.get("carrier_tracking"))
    shipstation = _coerce_object(integrations.get("shipStation") or integrations.get("shipstation"))

    candidates = [
        order.get("upsTrackingStatus"),
        order.get("ups_tracking_status"),
    ]

    if _looks_like_ups_order(
        {
            **order,
            "shippingEstimate": shipping_estimate,
            "integrationDetails": integrations,
        }
    ):
        candidates.extend(
            [
                shipping_estimate.get("status"),
                carrier_tracking.get("trackingStatusRaw"),
                carrier_tracking.get("trackingStatus"),
                carrier_tracking.get("tracking_status"),
                carrier_tracking.get("status"),
                carrier_tracking.get("deliveryStatus"),
                carrier_tracking.get("delivery_status"),
                shipstation.get("trackingStatus"),
                shipstation.get("tracking_status"),
                shipstation.get("deliveryStatus"),
                shipstation.get("delivery_status"),
                shipstation.get("shipmentStatus"),
                shipstation.get("shipment_status"),
                shipstation.get("status"),
            ]
        )
        shipments = shipstation.get("shipments")
        if isinstance(shipments, list):
            for entry in shipments:
                if not isinstance(entry, dict) or entry.get("voided") is True:
                    continue
                candidates.extend(
                    [
                        entry.get("trackingStatus"),
                        entry.get("tracking_status"),
                        entry.get("deliveryStatus"),
                        entry.get("delivery_status"),
                        entry.get("shipmentStatus"),
                        entry.get("shipment_status"),
                        entry.get("status"),
                    ]
                )

    for candidate in candidates:
        normalized = _normalize_ups_tracking_status(candidate)
        if normalized:
            return normalized
    return None


def _resolve_persisted_delivery_date(order: Dict) -> Optional[str]:
    if not isinstance(order, dict):
        return None
    shipping_estimate = _coerce_object(order.get("shippingEstimate") or order.get("shipping"))
    candidates = [
        order.get("deliveryDate"),
        order.get("delivery_date"),
        order.get("upsDeliveredAt"),
        shipping_estimate.get("deliveredAt"),
        shipping_estimate.get("delivered_at"),
    ]
    for candidate in candidates:
        normalized = _normalize_optional_string(candidate)
        if normalized:
            return normalized
    return None


def _apply_ups_status_to_order(order: Dict, status: object) -> Dict:
    normalized = _normalize_ups_tracking_status(status)
    order["upsTrackingStatus"] = normalized
    shipping_estimate = order.get("shippingEstimate")
    if not isinstance(shipping_estimate, dict):
        shipping_estimate = {}
    delivered_at = _resolve_persisted_delivery_date(
        {
            **order,
            "shippingEstimate": shipping_estimate,
        }
    )
    order["deliveryDate"] = delivered_at
    order["upsDeliveredAt"] = delivered_at
    if not normalized:
        raw_estimate_status = str(shipping_estimate.get("status") or "").strip().lower().replace("-", "_").replace(" ", "_")
        if raw_estimate_status == "unknown":
            shipping_estimate.pop("status", None)
        order["shippingEstimate"] = shipping_estimate
        return order
    shipping_estimate["status"] = normalized
    if normalized == "delivered" and delivered_at:
        shipping_estimate["deliveredAt"] = delivered_at
    if normalized == "delivered":
        shipping_estimate.pop("estimatedArrivalDate", None)
        shipping_estimate.pop("deliveryDateGuaranteed", None)
        order["expectedShipmentWindow"] = None
    else:
        shipping_estimate.pop("deliveredAt", None)
        order["deliveryDate"] = None
        order["upsDeliveredAt"] = None
    order["shippingEstimate"] = shipping_estimate
    return order

_SALES_TRACKING_SELECT_COLUMNS = """
    id,
    user_id,
    as_delegate,
    pricing_mode,
    is_tax_exempt,
    tax_exempt_source,
    tax_exempt_reason,
    reseller_permit_file_path,
    reseller_permit_file_name,
    reseller_permit_uploaded_at,
    items,
    items_subtotal,
    total,
    shipping_total,
    fulfillment_method,
    shipping_rate,
    shipping_carrier,
    shipping_service,
    tracking_number,
    ups_tracking_status,
    delivery_date,
    shipped_at,
    physician_certified,
    referral_code,
    status,
    integrations,
    expected_shipment_window,
    shipping_address,
    woo_order_id,
    woo_order_number,
    woo_order_key,
    created_at,
    updated_at
"""


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _orders_columns() -> set[str]:
    global _ORDERS_COLUMNS_CACHE
    if _ORDERS_COLUMNS_CACHE is not None:
        return _ORDERS_COLUMNS_CACHE
    if not _using_mysql():
        _ORDERS_COLUMNS_CACHE = set()
        return _ORDERS_COLUMNS_CACHE
    try:
        rows = mysql_client.fetch_all(
            """
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'orders'
            """,
        )
        cols = {str((row or {}).get("COLUMN_NAME") or "").strip() for row in (rows or [])}
        _ORDERS_COLUMNS_CACHE = {c for c in cols if c}
    except Exception:
        _ORDERS_COLUMNS_CACHE = {
            "tracking_number",
            "ups_tracking_status",
            "delivery_date",
            "shipping_rate",
            "expected_shipment_window",
            "updated_at",
        }
    return _ORDERS_COLUMNS_CACHE


def _sync_tracking_fields_after_fallback(params: Dict) -> None:
    if not _using_mysql():
        return
    columns = _orders_columns()
    ordered_columns = [
        "tracking_number",
        "ups_tracking_status",
        "delivery_date",
        "shipping_rate",
        "expected_shipment_window",
        "updated_at",
    ]
    assignments = [f"{column} = %({column})s" for column in ordered_columns if column in columns]
    if not assignments:
        return
    try:
        mysql_client.execute(
            f"UPDATE orders SET {', '.join(assignments)} WHERE id = %(id)s",
            params,
        )
        return
    except Exception:
        pass

    for column in ordered_columns:
        if column not in columns:
            continue
        try:
            mysql_client.execute(
                f"UPDATE orders SET {column} = %({column})s WHERE id = %(id)s",
                params,
            )
        except Exception:
            continue


def _is_hand_delivery_order(order: Dict) -> bool:
    if not isinstance(order, dict):
        return False

    if order.get("handDelivery") is True:
        return True

    candidates = [
        order.get("shippingService"),
        order.get("fulfillmentMethod"),
        order.get("fulfillment_method"),
    ]
    shipping_estimate = order.get("shippingEstimate")
    if isinstance(shipping_estimate, dict):
        candidates.extend(
            [
                shipping_estimate.get("serviceType"),
                shipping_estimate.get("serviceCode"),
                shipping_estimate.get("carrierId"),
            ]
        )

    normalized = {str(value or "").strip().lower() for value in candidates if str(value or "").strip()}
    return bool(
        {
            "hand delivery",
            "hand delivered",
            "hand_delivery",
            "hand_delivered",
            "hand-delivery",
            "hand-delivered",
            "local hand delivery",
            "local_hand_delivery",
            "local_delivery",
            "facility_pickup",
            "fascility_pickup",
        }
        & normalized
    )


def _get_store():
    store = storage.order_store
    if store is None:
        raise RuntimeError("order_store is not initialised")
    return store


def _order_field_aad(order_id: object, field: str) -> Dict[str, str]:
    return {
        "table": "orders",
        "record_ref": str(order_id or "pending"),
        "field": field,
    }


def _parse_json(value, default):
    if not value:
        return default
    try:
        return json.loads(value)
    except Exception:
        return default


def _read_order_json_field(row: Dict, field: str, default):
    try:
        decrypted = decrypt_json(row.get(field), aad=_order_field_aad(row.get("id"), field))
        if decrypted is not None:
            return decrypted
    except Exception:
        try:
            decrypted = decrypt_json(row.get(field))
            if decrypted is not None:
                return decrypted
        except Exception:
            pass
    return _parse_json(row.get(field), default)


def _load() -> List[Dict]:
    if _using_mysql():
        return _mysql_get_all()
    return list(_get_store().read())


def _save(orders: List[Dict]) -> None:
    if _using_mysql():
        raise RuntimeError("Direct save is not available with MySQL backend")
    _get_store().write(orders)


def get_all() -> List[Dict]:
    return _load()


def find_by_id(order_id: str) -> Optional[Dict]:
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM orders WHERE id = %(id)s", {"id": order_id})
        return _row_to_order(row)
    return next((order for order in _load() if order.get("id") == order_id), None)


def find_by_order_identifier(identifier: str) -> Optional[Dict]:
    normalized = str(identifier or "").strip()
    if not normalized:
        return None

    base = normalized[1:] if normalized.startswith("#") else normalized
    variants = []
    for candidate in (normalized, base, f"#{base}" if base else None):
        text = str(candidate or "").strip()
        if text and text not in variants:
            variants.append(text)
    if not variants:
        return None

    if _using_mysql():
        params = {f"value_{idx}": value for idx, value in enumerate(variants)}
        placeholders = ", ".join(f"%({name})s" for name in params)
        try:
            row = mysql_client.fetch_one(
                f"""
                SELECT * FROM orders
                WHERE id IN ({placeholders})
                   OR woo_order_id IN ({placeholders})
                   OR woo_order_number IN ({placeholders})
                ORDER BY updated_at DESC
                LIMIT 1
                """,
                params,
            )
            if row:
                return _row_to_order(row)
        except Exception:
            row = mysql_client.fetch_one(
                f"SELECT * FROM orders WHERE id IN ({placeholders}) ORDER BY updated_at DESC LIMIT 1",
                params,
            )
            if row:
                return _row_to_order(row)
        return None

    for order in _load():
        candidates = {
            str(order.get("id") or "").strip(),
            str(order.get("wooOrderId") or order.get("woo_order_id") or "").strip(),
            str(order.get("wooOrderNumber") or order.get("woo_order_number") or "").strip(),
        }
        candidates.discard("")
        if any(candidate in candidates for candidate in variants):
            return order
    return None


def find_by_user_id(user_id: str) -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM orders WHERE user_id = %(user_id)s", {"user_id": user_id})
        return [_row_to_order(row) for row in rows]
    return [order for order in _load() if order.get("userId") == user_id]


def list_user_overlay_fields(user_id: str) -> List[Dict]:
    """
    Lightweight fetch for per-user UI overlay fields (status/notes/addresses/etc).

    This avoids pulling large JSON payload columns for every request, which can be costly.
    Returns a list of dicts shaped similarly to `_row_to_order` for the fields we need.
    """
    if not user_id:
        return []
    if not _using_mysql():
        # Non-MySQL installs are small; fall back to full records.
        return find_by_user_id(user_id)

    try:
        rows = mysql_client.fetch_all(
            """
            SELECT
                id,
                as_delegate,
                pricing_mode,
                is_tax_exempt,
                tax_exempt_source,
                tax_exempt_reason,
                reseller_permit_file_path,
                reseller_permit_file_name,
                reseller_permit_uploaded_at,
                items,
                items_subtotal,
                total,
                shipping_total,
                fulfillment_method,
                tracking_number,
                ups_tracking_status,
                shipped_at,
                status,
                notes,
                shipping_address,
                expected_shipment_window,
                shipping_carrier,
                shipping_service,
                woo_order_id,
                woo_order_number,
                woo_order_key,
                payload,
                created_at,
                updated_at
            FROM orders
            WHERE user_id = %(user_id)s
            """,
            {"user_id": user_id},
        )
    except Exception:
        # Backwards compatibility with older schemas missing newer columns.
        rows = mysql_client.fetch_all(
            """
            SELECT
                id,
                as_delegate,
                pricing_mode,
                items,
                total,
                shipping_total,
                tracking_number,
                shipped_at,
                status,
                notes,
                shipping_address,
                expected_shipment_window,
                shipping_carrier,
                shipping_service,
                woo_order_id,
                woo_order_number,
                woo_order_key,
                created_at,
                updated_at
            FROM orders
            WHERE user_id = %(user_id)s
            """,
            {"user_id": user_id},
        )

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    result: List[Dict] = []
    for row in rows or []:
        payload = _read_order_json_field(row, "payload", {}) if row.get("payload") is not None else {}
        if not isinstance(payload, dict):
            payload = {}
        shipping_estimate = _parse_json(row.get("shipping_rate"), {})
        entry = {
            "id": row.get("id"),
            "items": _parse_json(row.get("items"), []) if row.get("items") is not None else [],
            # `total` is historically overloaded; treat it as "items subtotal" for UI overlays,
            # but also surface `grandTotal` when we can.
            "total": float(row.get("total") or 0),
            "itemsSubtotal": float(row.get("items_subtotal") or payload.get("itemsSubtotal") or row.get("total") or 0),
            "originalItemsSubtotal": float(payload.get("originalItemsSubtotal") or 0),
            "taxTotal": float(payload.get("taxTotal") or 0),
            "grandTotal": float(payload.get("grandTotal") or 0),
            "appliedReferralCredit": float(payload.get("appliedReferralCredit") or 0),
            "discountCode": payload.get("discountCode") or None,
            "discountCodeAmount": float(payload.get("discountCodeAmount") or 0),
            "isTaxExempt": (
                _coerce_optional_bool(row.get("is_tax_exempt"))
                if _coerce_optional_bool(row.get("is_tax_exempt")) is not None
                else (
                    bool(_coerce_optional_bool(payload.get("isTaxExempt")))
                    or bool(
                        row.get("tax_exempt_source")
                        or payload.get("taxExemptSource")
                        or payload.get("tax_exempt_source")
                    )
                )
            ),
            "taxExemptSource": (
                row.get("tax_exempt_source")
                or payload.get("taxExemptSource")
                or payload.get("tax_exempt_source")
                or None
            ),
            "taxExemptReason": (
                row.get("tax_exempt_reason")
                or payload.get("taxExemptReason")
                or payload.get("tax_exempt_reason")
                or None
            ),
            "resellerPermitFilePath": (
                row.get("reseller_permit_file_path")
                or payload.get("resellerPermitFilePath")
                or payload.get("reseller_permit_file_path")
                or None
            ),
            "resellerPermitFileName": (
                row.get("reseller_permit_file_name")
                or payload.get("resellerPermitFileName")
                or payload.get("reseller_permit_file_name")
                or None
            ),
            "resellerPermitUploadedAt": (
                fmt_datetime(row.get("reseller_permit_uploaded_at"))
                or payload.get("resellerPermitUploadedAt")
                or payload.get("reseller_permit_uploaded_at")
                or None
            ),
            "hasResellerPermitUploaded": bool(
                row.get("reseller_permit_file_path")
                or row.get("reseller_permit_file_name")
                or row.get("reseller_permit_uploaded_at")
                or payload.get("resellerPermitFilePath")
                or payload.get("reseller_permit_file_path")
                or payload.get("resellerPermitFileName")
                or payload.get("reseller_permit_file_name")
                or payload.get("resellerPermitUploadedAt")
                or payload.get("reseller_permit_uploaded_at")
            ),
            "pricingMode": row.get("pricing_mode") or "wholesale",
            "asDelegate": (
                row.get("as_delegate")
                if row.get("as_delegate") is not None
                else (
                    payload.get("asDelegate")
                    if payload.get("asDelegate") is not None
                    else payload.get("as_delegate")
                )
            ),
            "shippingTotal": float(row.get("shipping_total") or 0),
            "shippingEstimate": shipping_estimate,
            "handDelivery": bool(payload.get("handDelivery")),
            "fulfillmentMethod": _normalize_fulfillment_method(
                row.get("fulfillment_method"),
                payload.get("fulfillmentMethod"),
            )
            or ("hand_delivered" if bool(payload.get("handDelivery")) else "shipping"),
            "trackingNumber": row.get("tracking_number") or None,
            "upsTrackingStatus": _normalize_ups_tracking_status(
                row.get("ups_tracking_status")
                or payload.get("upsTrackingStatus")
                or payload.get("ups_tracking_status")
            ),
            "upsDeliveredAt": _normalize_optional_string(
                fmt_datetime(row.get("delivery_date"))
                or payload.get("upsDeliveredAt")
                or payload.get("delivery_date")
                or (shipping_estimate.get("deliveredAt") if isinstance(shipping_estimate, dict) else None)
                or (shipping_estimate.get("delivered_at") if isinstance(shipping_estimate, dict) else None)
            ),
            "deliveryDate": _normalize_optional_string(fmt_datetime(row.get("delivery_date"))),
            "shippedAt": fmt_datetime(row.get("shipped_at")) or None,
            "status": row.get("status"),
            "notes": row.get("notes") if row.get("notes") is not None else None,
            "shippingAddress": _read_order_json_field(row, "shipping_address", None),
            "expectedShipmentWindow": row.get("expected_shipment_window") or None,
            "shippingCarrier": row.get("shipping_carrier"),
            "shippingService": row.get("shipping_service"),
            "wooOrderId": row.get("woo_order_id") or None,
            "wooOrderNumber": row.get("woo_order_number") or None,
            "wooOrderKey": row.get("woo_order_key") or None,
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
        result.append(_apply_ups_status_to_order(entry, entry.get("upsTrackingStatus")))
    return result


def update_status_fields(
    order_id: str,
    *,
    status: str | None,
    woo_order_id: Optional[str] = None,
    woo_order_number: Optional[str] = None,
    woo_order_key: Optional[str] = None,
) -> None:
    """
    Lightweight MySQL update for webhook-driven status changes.
    Avoids rewriting the full `payload` column.
    Safe on older schemas for optional Woo columns (no-op if columns are missing).
    """
    if not order_id:
        return
    if not _using_mysql():
        # Non-MySQL installs store full dicts; callers can fall back to update().
        return
    try:
        mysql_client.execute(
            """
            UPDATE orders
            SET
                status = %(status)s,
                woo_order_id = COALESCE(%(woo_order_id)s, woo_order_id),
                woo_order_number = COALESCE(%(woo_order_number)s, woo_order_number),
                woo_order_key = COALESCE(%(woo_order_key)s, woo_order_key),
                updated_at = NOW()
            WHERE id = %(id)s
            """,
            {
                "id": order_id,
                "status": status,
                "woo_order_id": woo_order_id,
                "woo_order_number": woo_order_number,
                "woo_order_key": woo_order_key,
            },
        )
    except Exception:
        # Optional columns might not exist on older installs; ignore.
        try:
            mysql_client.execute(
                "UPDATE orders SET status = %(status)s, updated_at = NOW() WHERE id = %(id)s",
                {"id": order_id, "status": status},
            )
        except Exception:
            return


def update_ups_tracking_status(
    order_id: str,
    *,
    ups_tracking_status: str | None,
    delivered_at: str | None = None,
    estimated_arrival_date: str | None = None,
    delivery_date_guaranteed: str | None = None,
    expected_shipment_window: str | None = None,
) -> Optional[Dict]:
    normalized = _normalize_ups_tracking_status(ups_tracking_status)
    normalized_delivered_at = _normalize_optional_string(delivered_at)
    normalized_estimated_arrival_date = _normalize_optional_string(estimated_arrival_date)
    normalized_delivery_date_guaranteed = _normalize_optional_string(delivery_date_guaranteed)
    normalized_expected_shipment_window = _normalize_optional_string_max(expected_shipment_window, 64)
    if not order_id:
        return None

    existing = find_by_id(order_id)
    if not existing:
        return None
    updated = dict(existing)
    updated["upsTrackingStatus"] = normalized
    existing_delivery_date = _normalize_optional_string(
        updated.get("deliveryDate")
        or updated.get("delivery_date")
        or updated.get("upsDeliveredAt")
    )
    estimate = updated.get("shippingEstimate")
    if not isinstance(estimate, dict):
        estimate = {}
    if normalized:
        estimate["status"] = normalized
    elif "status" in estimate:
        estimate.pop("status", None)
    if normalized == "delivered":
        if normalized_delivered_at:
            estimate["deliveredAt"] = normalized_delivered_at
        elif existing_delivery_date:
            estimate["deliveredAt"] = existing_delivery_date
        elif _normalize_optional_string(estimate.get("deliveredAt")):
            pass
        estimate.pop("estimatedArrivalDate", None)
        estimate.pop("deliveryDateGuaranteed", None)
        updated["expectedShipmentWindow"] = None
    else:
        estimate.pop("deliveredAt", None)
        if normalized_estimated_arrival_date:
            estimate["estimatedArrivalDate"] = normalized_estimated_arrival_date
        if normalized_delivery_date_guaranteed:
            estimate["deliveryDateGuaranteed"] = normalized_delivery_date_guaranteed
        if normalized_expected_shipment_window:
            updated["expectedShipmentWindow"] = normalized_expected_shipment_window
    updated["shippingEstimate"] = estimate
    resolved_delivery_date = (
        normalized_delivered_at
        if normalized == "delivered" and normalized_delivered_at
        else (
            _normalize_optional_string(estimate.get("deliveredAt"))
            or existing_delivery_date
        )
        if normalized == "delivered"
        else None
    )
    updated["upsDeliveredAt"] = resolved_delivery_date
    updated["deliveryDate"] = resolved_delivery_date
    updated["updatedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return update(updated)


def find_by_user_ids(user_ids: List[str]) -> List[Dict]:
    ids = [str(uid).strip() for uid in (user_ids or []) if str(uid).strip()]
    if not ids:
        return []
    if _using_mysql():
        results: List[Dict] = []
        chunk_size = 500
        for offset in range(0, len(ids), chunk_size):
            chunk = ids[offset : offset + chunk_size]
            placeholders = ", ".join([f"%(user_id_{idx})s" for idx in range(len(chunk))])
            params = {f"user_id_{idx}": user_id for idx, user_id in enumerate(chunk)}
            rows = mysql_client.fetch_all(
                f"SELECT * FROM orders WHERE user_id IN ({placeholders})",
                params,
            )
            for row in rows or []:
                mapped = _row_to_order(row)
                if mapped:
                    results.append(mapped)
        return results
    id_set = set(ids)
    return [order for order in _load() if str(order.get("userId") or "") in id_set]


def find_sales_tracking_by_user_ids(user_ids: List[str]) -> List[Dict]:
    ids = [str(uid).strip() for uid in (user_ids or []) if str(uid).strip()]
    if not ids:
        return []
    if _using_mysql():
        results: List[Dict] = []
        chunk_size = 500
        for offset in range(0, len(ids), chunk_size):
            chunk = ids[offset : offset + chunk_size]
            placeholders = ", ".join([f"%(user_id_{idx})s" for idx in range(len(chunk))])
            params = {f"user_id_{idx}": user_id for idx, user_id in enumerate(chunk)}
            rows = mysql_client.fetch_all(
                f"""
                SELECT {_SALES_TRACKING_SELECT_COLUMNS}
                FROM orders
                WHERE user_id IN ({placeholders})
                ORDER BY created_at DESC
                """,
                params,
            )
            for row in rows or []:
                mapped = _row_to_order(row)
                if mapped:
                    results.append(mapped)
        return results
    return find_by_user_ids(ids)


def list_recent(limit: int = 500) -> List[Dict]:
    try:
        limit_value = int(limit)
    except Exception:
        limit_value = 500
    limit_value = max(1, min(limit_value, 5000))
    if _using_mysql():
        rows = mysql_client.fetch_all(
            "SELECT * FROM orders ORDER BY created_at DESC LIMIT %(limit)s",
            {"limit": limit_value},
        )
        return [_row_to_order(row) for row in rows]
    orders = list(_load())
    orders.sort(key=lambda o: str(o.get("createdAt") or ""), reverse=True)
    return orders[:limit_value]


def list_recent_sales_tracking(limit: int = 500) -> List[Dict]:
    try:
        limit_value = int(limit)
    except Exception:
        limit_value = 500
    limit_value = max(1, min(limit_value, 5000))
    if _using_mysql():
        rows = mysql_client.fetch_all(
            f"""
            SELECT {_SALES_TRACKING_SELECT_COLUMNS}
            FROM orders
            ORDER BY created_at DESC
            LIMIT %(limit)s
            """,
            {"limit": limit_value},
        )
        return [_row_to_order(row) for row in rows]
    return list_recent(limit_value)


def list_for_commission(start_utc: datetime, end_utc: datetime) -> List[Dict]:
    """
    Return orders within the [start_utc, end_utc] window.
    Uses SQL when available; falls back to in-memory filtering otherwise.
    """
    if not start_utc or not end_utc:
        return []

    def normalize_dt(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    start_value = normalize_dt(start_utc)
    end_value = normalize_dt(end_utc)

    if _using_mysql():
        start_naive = start_value.replace(tzinfo=None)
        end_naive = end_value.replace(tzinfo=None)
        rows = mysql_client.fetch_all(
            """
            SELECT *
            FROM orders
            WHERE created_at >= %(start)s AND created_at <= %(end)s
            ORDER BY created_at DESC
            """,
            {"start": start_naive, "end": end_naive},
        )
        return [_row_to_order(row) for row in rows or []]

    def parse_dt(value: object) -> Optional[datetime]:
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc)
        text = str(value).strip()
        if not text:
            return None
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except Exception:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed

    results: List[Dict] = []
    for order in _load():
        created_at = parse_dt(order.get("createdAt") or order.get("created_at"))
        if not created_at:
            continue
        created_at = created_at.astimezone(timezone.utc)
        if created_at < start_value or created_at > end_value:
            continue
        results.append(order)
    return results


def get_pricing_mode_lookup_by_woo(
    woo_order_ids: List[str] | None = None, woo_order_numbers: List[str] | None = None
) -> Dict[str, str]:
    """
    Return a lookup of Woo order id/number -> pricing mode ("wholesale"|"retail").

    Keys are normalized order tokens with leading '#' removed and whitespace trimmed.
    When MySQL is disabled or no matches are found, returns an empty dict.
    """

    if not _using_mysql():
        return {}

    def normalize_token(value: object) -> str:
        if value is None:
            return ""
        text = str(value).strip()
        if not text:
            return ""
        return text[1:] if text.startswith("#") else text

    def normalize_mode(value: object) -> str:
        mode = str(value or "").strip().lower()
        return "retail" if mode == "retail" else "wholesale"

    ids = [normalize_token(v) for v in (woo_order_ids or [])]
    nums = [normalize_token(v) for v in (woo_order_numbers or [])]
    ids = [v for v in ids if v]
    nums = [v for v in nums if v]

    if not ids and not nums:
        return {}

    lookup: Dict[str, str] = {}

    def _run_in_chunks(values: List[str], column: str) -> None:
        chunk_size = 500
        for offset in range(0, len(values), chunk_size):
            chunk = values[offset : offset + chunk_size]
            placeholders = ", ".join([f"%({column}_{idx})s" for idx in range(len(chunk))])
            params = {f"{column}_{idx}": value for idx, value in enumerate(chunk)}
            rows = mysql_client.fetch_all(
                f"SELECT {column}, pricing_mode FROM orders WHERE {column} IN ({placeholders})",
                params,
            )
            for row in rows or []:
                token = normalize_token(row.get(column))
                if not token:
                    continue
                lookup[token] = normalize_mode(row.get("pricing_mode"))

    def expand_query_values(values: List[str]) -> List[str]:
        expanded = set()
        for value in values:
            token = normalize_token(value)
            if not token:
                continue
            expanded.add(token)
            expanded.add(f"#{token}")
        return list(expanded)

    try:
        if ids:
            _run_in_chunks(expand_query_values(ids), "woo_order_id")
        if nums:
            _run_in_chunks(expand_query_values(nums), "woo_order_number")
    except Exception:
        # Older installs may be missing Woo columns; treat as unknown.
        return {}

    return lookup


def get_total_lookup_by_woo(
    woo_order_ids: List[str] | None = None, woo_order_numbers: List[str] | None = None
) -> Dict[str, float]:
    """
    Return a lookup of Woo order id/number -> order grand total.

    This is sourced from the local MySQL `orders.total` column, which is treated as the
    full amount paid (subtotal - discounts + shipping + tax).

    Keys are normalized order tokens with leading '#' removed and whitespace trimmed.
    When MySQL is disabled or no matches are found, returns an empty dict.
    """

    if not _using_mysql():
        return {}

    def normalize_token(value: object) -> str:
        if value is None:
            return ""
        text = str(value).strip()
        if not text:
            return ""
        return text[1:] if text.startswith("#") else text

    def normalize_total(value: object) -> float:
        try:
            return max(0.0, float(value or 0.0))
        except Exception:
            try:
                return max(0.0, float(str(value).strip() or 0.0))
            except Exception:
                return 0.0

    ids = [normalize_token(v) for v in (woo_order_ids or [])]
    nums = [normalize_token(v) for v in (woo_order_numbers or [])]
    ids = [v for v in ids if v]
    nums = [v for v in nums if v]

    if not ids and not nums:
        return {}

    lookup: Dict[str, float] = {}

    def _run_in_chunks(values: List[str], column: str) -> None:
        chunk_size = 500
        for offset in range(0, len(values), chunk_size):
            chunk = values[offset : offset + chunk_size]
            placeholders = ", ".join([f"%({column}_{idx})s" for idx in range(len(chunk))])
            params = {f"{column}_{idx}": value for idx, value in enumerate(chunk)}
            rows = mysql_client.fetch_all(
                f"SELECT {column}, total FROM orders WHERE {column} IN ({placeholders})",
                params,
            )
            for row in rows or []:
                token = normalize_token(row.get(column))
                if not token:
                    continue
                lookup[token] = normalize_total(row.get("total"))

    def expand_query_values(values: List[str]) -> List[str]:
        expanded = set()
        for value in values:
            token = normalize_token(value)
            if not token:
                continue
            expanded.add(token)
            expanded.add(f"#{token}")
        return list(expanded)

    try:
        if ids:
            _run_in_chunks(expand_query_values(ids), "woo_order_id")
        if nums:
            _run_in_chunks(expand_query_values(nums), "woo_order_number")
    except Exception:
        # Older installs may be missing Woo columns; treat as unknown.
        return {}

    return lookup


def get_items_subtotal_lookup_by_woo(
    woo_order_ids: List[str] | None = None, woo_order_numbers: List[str] | None = None
) -> Dict[str, float]:
    """
    Return a lookup of Woo order id/number -> items subtotal.

    Prefer the dedicated MySQL `orders.items_subtotal` column when available.
    Fall back to parsing `orders.payload` and extracting `itemsSubtotal`.

    Keys are normalized order tokens with leading '#' removed and whitespace trimmed.
    When MySQL is disabled or no matches are found, returns an empty dict.
    """

    if not _using_mysql():
        return {}

    def normalize_token(value: object) -> str:
        if value is None:
            return ""
        text = str(value).strip()
        if not text:
            return ""
        return text[1:] if text.startswith("#") else text

    def normalize_amount(value: object) -> float:
        try:
            return max(0.0, float(value or 0.0))
        except Exception:
            try:
                return max(0.0, float(str(value).strip() or 0.0))
            except Exception:
                return 0.0

    ids = [normalize_token(v) for v in (woo_order_ids or [])]
    nums = [normalize_token(v) for v in (woo_order_numbers or [])]
    ids = [v for v in ids if v]
    nums = [v for v in nums if v]

    if not ids and not nums:
        return {}

    lookup: Dict[str, float] = {}

    def parse_payload_items_subtotal(value: object) -> float:
        if not value:
            return 0.0
        payload = decrypt_json(value)
        if payload is None:
            try:
                payload = json.loads(value) if isinstance(value, str) else value
            except Exception:
                return 0.0
        if not isinstance(payload, dict):
            return 0.0
        # Python backend stores the order dict directly; tolerate nested shapes.
        order = payload.get("order") if isinstance(payload.get("order"), dict) else payload
        if not isinstance(order, dict):
            return 0.0
        return normalize_amount(
            order.get("itemsSubtotal")
            or order.get("subtotal")
            or order.get("items_subtotal")
            or order.get("itemsTotal")
            or order.get("items_total")
        )

    def _run_in_chunks(values: List[str], column: str) -> None:
        chunk_size = 500
        for offset in range(0, len(values), chunk_size):
            chunk = values[offset : offset + chunk_size]
            placeholders = ", ".join([f"%({column}_{idx})s" for idx in range(len(chunk))])
            params = {f"{column}_{idx}": value for idx, value in enumerate(chunk)}
            try:
                rows = mysql_client.fetch_all(
                    f"SELECT {column}, items_subtotal, payload FROM orders WHERE {column} IN ({placeholders})",
                    params,
                )
            except Exception:
                # Older installs may not have `items_subtotal` yet; fall back to payload-only parsing.
                rows = mysql_client.fetch_all(
                    f"SELECT {column}, payload FROM orders WHERE {column} IN ({placeholders})",
                    params,
                )
            for row in rows or []:
                token = normalize_token(row.get(column))
                if not token:
                    continue
                items_subtotal = normalize_amount(row.get("items_subtotal"))
                if items_subtotal <= 0:
                    items_subtotal = parse_payload_items_subtotal(row.get("payload"))
                if items_subtotal > 0:
                    lookup[token] = items_subtotal

    def expand_query_values(values: List[str]) -> List[str]:
        expanded = set()
        for value in values:
            token = normalize_token(value)
            if not token:
                continue
            expanded.add(token)
            expanded.add(f"#{token}")
        return list(expanded)

    try:
        if ids:
            _run_in_chunks(expand_query_values(ids), "woo_order_id")
        if nums:
            _run_in_chunks(expand_query_values(nums), "woo_order_number")
    except Exception:
        # Older installs may be missing Woo columns; treat as unknown.
        return {}

    return lookup


def count_by_user_id(user_id: str) -> int:
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT COUNT(*) AS count FROM orders WHERE user_id = %(user_id)s",
            {"user_id": user_id},
        )
        return int(row.get("count") or 0) if row else 0
    return len(find_by_user_id(user_id))


def count_by_user_ids(user_ids: List[str]) -> Dict[str, int]:
    """
    Return mapping user_id -> order count.
    Used to avoid N+1 COUNT queries when enriching dashboards.
    """
    ids = [str(uid).strip() for uid in (user_ids or []) if str(uid).strip()]
    if not ids:
        return {}

    if _using_mysql():
        counts: Dict[str, int] = {}
        chunk_size = 500
        for offset in range(0, len(ids), chunk_size):
            chunk = ids[offset : offset + chunk_size]
            placeholders = ", ".join([f"%(user_id_{idx})s" for idx in range(len(chunk))])
            params = {f"user_id_{idx}": user_id for idx, user_id in enumerate(chunk)}
            rows = mysql_client.fetch_all(
                f"""
                SELECT user_id, COUNT(*) AS count
                FROM orders
                WHERE user_id IN ({placeholders})
                GROUP BY user_id
                """,
                params,
            )
            for row in rows or []:
                uid = row.get("user_id")
                if uid is None:
                    continue
                counts[str(uid)] = int(row.get("count") or 0)
        for uid in ids:
            counts.setdefault(uid, 0)
        return counts

    # JSON-store mode: count in memory
    counts: Dict[str, int] = {uid: 0 for uid in ids}
    for order in _load():
        uid = order.get("userId")
        if uid is None:
            continue
        key = str(uid)
        if key in counts:
            counts[key] += 1
    return counts


def insert(order: Dict) -> Dict:
    if _using_mysql():
        order.setdefault("id", order.get("id") or _generate_id())
        params = _to_db_params(order)
        try:
            mysql_client.execute(
                """
                INSERT INTO orders (
                    id, user_id, as_delegate, pricing_mode, is_tax_exempt, tax_exempt_source, tax_exempt_reason,
                    reseller_permit_file_path, reseller_permit_file_name, reseller_permit_uploaded_at,
                    items, items_subtotal, total, shipping_total, shipping_carrier, shipping_service,
                    facility_pickup, fulfillment_method,
                    tracking_number, ups_tracking_status, delivery_date, shipped_at,
                    physician_certified, referral_code, status,
                    referrer_bonus, first_order_bonus, integrations, shipping_rate, expected_shipment_window, notes, shipping_address, payload,
                    created_at, updated_at
                ) VALUES (
                    %(id)s, %(user_id)s, %(as_delegate)s, %(pricing_mode)s, %(is_tax_exempt)s, %(tax_exempt_source)s, %(tax_exempt_reason)s,
                    %(reseller_permit_file_path)s, %(reseller_permit_file_name)s, %(reseller_permit_uploaded_at)s,
                    %(items)s, %(items_subtotal)s, %(total)s, %(shipping_total)s, %(shipping_carrier)s, %(shipping_service)s,
                    %(facility_pickup)s, %(fulfillment_method)s,
                    %(tracking_number)s, %(ups_tracking_status)s, %(delivery_date)s, %(shipped_at)s,
                    %(physician_certified)s, %(referral_code)s, %(status)s,
                    %(referrer_bonus)s, %(first_order_bonus)s, %(integrations)s, %(shipping_rate)s, %(expected_shipment_window)s, %(notes)s, %(shipping_address)s, %(payload)s,
                    %(created_at)s, %(updated_at)s
                )
                ON DUPLICATE KEY UPDATE
                    user_id = VALUES(user_id),
                    as_delegate = VALUES(as_delegate),
                    pricing_mode = VALUES(pricing_mode),
                    is_tax_exempt = VALUES(is_tax_exempt),
                    tax_exempt_source = VALUES(tax_exempt_source),
                    tax_exempt_reason = VALUES(tax_exempt_reason),
                    reseller_permit_file_path = VALUES(reseller_permit_file_path),
                    reseller_permit_file_name = VALUES(reseller_permit_file_name),
                    reseller_permit_uploaded_at = VALUES(reseller_permit_uploaded_at),
                    items = VALUES(items),
                    items_subtotal = VALUES(items_subtotal),
                    total = VALUES(total),
                    shipping_total = VALUES(shipping_total),
                    shipping_carrier = VALUES(shipping_carrier),
                    shipping_service = VALUES(shipping_service),
                    facility_pickup = VALUES(facility_pickup),
                    fulfillment_method = VALUES(fulfillment_method),
                    tracking_number = VALUES(tracking_number),
                    ups_tracking_status = VALUES(ups_tracking_status),
                    delivery_date = VALUES(delivery_date),
                    shipped_at = CASE
                        WHEN VALUES(shipped_at) IS NOT NULL THEN VALUES(shipped_at)
                        ELSE shipped_at
                    END,
                    physician_certified = VALUES(physician_certified),
                    referral_code = VALUES(referral_code),
                    status = VALUES(status),
                    referrer_bonus = VALUES(referrer_bonus),
                    first_order_bonus = VALUES(first_order_bonus),
                    integrations = VALUES(integrations),
                    shipping_rate = VALUES(shipping_rate),
                    expected_shipment_window = VALUES(expected_shipment_window),
                    notes = VALUES(notes),
                    shipping_address = VALUES(shipping_address),
                    payload = VALUES(payload),
                    created_at = VALUES(created_at),
                    updated_at = VALUES(updated_at)
                """,
                params,
            )
        except Exception:
            # Backwards compatibility with older schemas.
            mysql_client.execute(
                """
                INSERT INTO orders (
                    id, user_id, as_delegate, pricing_mode, items, total, shipping_total, shipping_carrier, shipping_service,
                    tracking_number, shipped_at,
                    physician_certified, referral_code, status,
                    referrer_bonus, first_order_bonus, integrations, shipping_rate, expected_shipment_window, notes, shipping_address, payload,
                    created_at, updated_at
                ) VALUES (
                    %(id)s, %(user_id)s, %(as_delegate)s, %(pricing_mode)s, %(items)s, %(total)s, %(shipping_total)s, %(shipping_carrier)s, %(shipping_service)s,
                    %(tracking_number)s, %(shipped_at)s,
                    %(physician_certified)s, %(referral_code)s, %(status)s,
                    %(referrer_bonus)s, %(first_order_bonus)s, %(integrations)s, %(shipping_rate)s, %(expected_shipment_window)s, %(notes)s, %(shipping_address)s, %(payload)s,
                    %(created_at)s, %(updated_at)s
                )
                ON DUPLICATE KEY UPDATE
                    user_id = VALUES(user_id),
                    as_delegate = VALUES(as_delegate),
                    pricing_mode = VALUES(pricing_mode),
                    items = VALUES(items),
                    total = VALUES(total),
                    shipping_total = VALUES(shipping_total),
                    shipping_carrier = VALUES(shipping_carrier),
                    shipping_service = VALUES(shipping_service),
                    tracking_number = VALUES(tracking_number),
                    shipped_at = CASE
                        WHEN VALUES(shipped_at) IS NOT NULL THEN VALUES(shipped_at)
                        ELSE shipped_at
                    END,
                    physician_certified = VALUES(physician_certified),
                    referral_code = VALUES(referral_code),
                    status = VALUES(status),
                    referrer_bonus = VALUES(referrer_bonus),
                    first_order_bonus = VALUES(first_order_bonus),
                    integrations = VALUES(integrations),
                    shipping_rate = VALUES(shipping_rate),
                    expected_shipment_window = VALUES(expected_shipment_window),
                    notes = VALUES(notes),
                    shipping_address = VALUES(shipping_address),
                    payload = VALUES(payload),
                    created_at = VALUES(created_at),
                    updated_at = VALUES(updated_at)
                """,
                params,
            )
            _sync_tracking_fields_after_fallback(params)
        return find_by_id(order["id"])

    orders = _load()
    orders.append(dict(order))
    _save(orders)
    return order


def update(order: Dict) -> Optional[Dict]:
    if _using_mysql():
        params = _to_db_params(order)
        try:
            mysql_client.execute(
                """
                UPDATE orders
                SET
                    user_id = %(user_id)s,
                    as_delegate = %(as_delegate)s,
                    pricing_mode = %(pricing_mode)s,
                    is_tax_exempt = %(is_tax_exempt)s,
                    tax_exempt_source = %(tax_exempt_source)s,
                    tax_exempt_reason = %(tax_exempt_reason)s,
                    reseller_permit_file_path = %(reseller_permit_file_path)s,
                    reseller_permit_file_name = %(reseller_permit_file_name)s,
                    reseller_permit_uploaded_at = %(reseller_permit_uploaded_at)s,
                    items = %(items)s,
                    items_subtotal = %(items_subtotal)s,
                    total = %(total)s,
                    shipping_total = %(shipping_total)s,
                    shipping_carrier = %(shipping_carrier)s,
                    shipping_service = %(shipping_service)s,
                    facility_pickup = %(facility_pickup)s,
                    fulfillment_method = %(fulfillment_method)s,
                    tracking_number = %(tracking_number)s,
                    ups_tracking_status = %(ups_tracking_status)s,
                    delivery_date = %(delivery_date)s,
                    shipped_at = CASE
                        WHEN %(shipped_at)s IS NOT NULL THEN %(shipped_at)s
                        ELSE shipped_at
                    END,
                    referral_code = %(referral_code)s,
                    status = %(status)s,
                    referrer_bonus = %(referrer_bonus)s,
                    first_order_bonus = %(first_order_bonus)s,
                    integrations = %(integrations)s,
                    shipping_rate = %(shipping_rate)s,
                    expected_shipment_window = %(expected_shipment_window)s,
                    notes = %(notes)s,
                    shipping_address = %(shipping_address)s,
                    payload = %(payload)s,
                    updated_at = %(updated_at)s
                WHERE id = %(id)s
                """,
                params,
            )
        except Exception:
            mysql_client.execute(
                """
                UPDATE orders
                SET
                    user_id = %(user_id)s,
                    as_delegate = %(as_delegate)s,
                    pricing_mode = %(pricing_mode)s,
                    items = %(items)s,
                    total = %(total)s,
                    shipping_total = %(shipping_total)s,
                    shipping_carrier = %(shipping_carrier)s,
                    shipping_service = %(shipping_service)s,
                    tracking_number = %(tracking_number)s,
                    shipped_at = CASE
                        WHEN %(shipped_at)s IS NOT NULL THEN %(shipped_at)s
                        ELSE shipped_at
                    END,
                    referral_code = %(referral_code)s,
                    status = %(status)s,
                    referrer_bonus = %(referrer_bonus)s,
                    first_order_bonus = %(first_order_bonus)s,
                    integrations = %(integrations)s,
                    shipping_rate = %(shipping_rate)s,
                    expected_shipment_window = %(expected_shipment_window)s,
                    notes = %(notes)s,
                    shipping_address = %(shipping_address)s,
                    payload = %(payload)s,
                    updated_at = %(updated_at)s
                WHERE id = %(id)s
                """,
                params,
            )
            _sync_tracking_fields_after_fallback(params)
        return find_by_id(order.get("id"))

    orders = _load()
    for index, existing in enumerate(orders):
        if existing.get("id") == order.get("id"):
            merged = {**existing, **order}
            orders[index] = merged
            _save(orders)
            return merged
    return None


def update_woo_fields(order_id: str, woo_order_id: Optional[str], woo_order_number: Optional[str], woo_order_key: Optional[str]) -> None:
    """
    Best-effort: store Woo order identifiers in dedicated SQL columns for easy querying.
    Safe on older schemas (no-op if columns are missing).
    """
    if not order_id:
        return
    if not _using_mysql():
        return
    try:
        mysql_client.execute(
            """
            UPDATE orders
            SET
                woo_order_id = %(woo_order_id)s,
                woo_order_number = %(woo_order_number)s,
                woo_order_key = %(woo_order_key)s
            WHERE id = %(id)s
            """,
            {
                "id": order_id,
                "woo_order_id": woo_order_id,
                "woo_order_number": woo_order_number,
                "woo_order_key": woo_order_key,
            },
        )
    except Exception:
        # Columns might not exist on older installs; ignore.
        return


def _generate_id() -> str:
    from time import time

    return str(int(time() * 1000))


def _mysql_get_all() -> List[Dict]:
    rows = mysql_client.fetch_all("SELECT * FROM orders")
    return [_row_to_order(row) for row in rows]


def _row_to_order(row: Optional[Dict]) -> Optional[Dict]:
    if not row:
        return None

    try:
        local_tz = ZoneInfo(os.environ.get("ORDER_TIMEZONE") or "America/Los_Angeles")
    except Exception:
        local_tz = timezone.utc

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            parsed = value
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=local_tz)
            else:
                parsed = parsed.astimezone(local_tz)
            return parsed.isoformat()
        return str(value)

    payload = _read_order_json_field(row, "payload", {})
    integrations_payload = _parse_json(row.get("integrations"), {})
    payload_order = payload.get("order") if isinstance(payload, dict) and isinstance(payload.get("order"), dict) else None
    shipping_estimate = _parse_json(
        row.get("shipping_rate"),
        integrations_payload.get("shippingRate", {}) if isinstance(integrations_payload, dict) else {},
    )
    tax_exempt_source = _normalize_optional_string(
        row.get("tax_exempt_source")
        or (payload_order.get("taxExemptSource") if isinstance(payload_order, dict) else None)
        or (payload_order.get("tax_exempt_source") if isinstance(payload_order, dict) else None)
        or (payload.get("taxExemptSource") if isinstance(payload, dict) else None)
        or (payload.get("tax_exempt_source") if isinstance(payload, dict) else None)
    )
    tax_exempt_reason = _normalize_optional_string(
        row.get("tax_exempt_reason")
        or (payload_order.get("taxExemptReason") if isinstance(payload_order, dict) else None)
        or (payload_order.get("tax_exempt_reason") if isinstance(payload_order, dict) else None)
        or (payload.get("taxExemptReason") if isinstance(payload, dict) else None)
        or (payload.get("tax_exempt_reason") if isinstance(payload, dict) else None)
    )
    reseller_permit_file_path = _normalize_optional_string(
        row.get("reseller_permit_file_path")
        or (payload_order.get("resellerPermitFilePath") if isinstance(payload_order, dict) else None)
        or (payload_order.get("reseller_permit_file_path") if isinstance(payload_order, dict) else None)
        or (payload.get("resellerPermitFilePath") if isinstance(payload, dict) else None)
        or (payload.get("reseller_permit_file_path") if isinstance(payload, dict) else None)
    )
    reseller_permit_file_name = _normalize_optional_string(
        row.get("reseller_permit_file_name")
        or (payload_order.get("resellerPermitFileName") if isinstance(payload_order, dict) else None)
        or (payload_order.get("reseller_permit_file_name") if isinstance(payload_order, dict) else None)
        or (payload.get("resellerPermitFileName") if isinstance(payload, dict) else None)
        or (payload.get("reseller_permit_file_name") if isinstance(payload, dict) else None)
    )
    reseller_permit_uploaded_at = fmt_datetime(
        row.get("reseller_permit_uploaded_at")
        or (payload_order.get("resellerPermitUploadedAt") if isinstance(payload_order, dict) else None)
        or (payload_order.get("reseller_permit_uploaded_at") if isinstance(payload_order, dict) else None)
        or (payload.get("resellerPermitUploadedAt") if isinstance(payload, dict) else None)
        or (payload.get("reseller_permit_uploaded_at") if isinstance(payload, dict) else None)
    )
    explicit_is_tax_exempt = _coerce_optional_bool(
        row.get("is_tax_exempt")
        if row.get("is_tax_exempt") is not None
        else (
            payload_order.get("isTaxExempt")
            if isinstance(payload_order, dict) and payload_order.get("isTaxExempt") is not None
            else (
                payload_order.get("is_tax_exempt")
                if isinstance(payload_order, dict) and payload_order.get("is_tax_exempt") is not None
                else (
                    payload.get("isTaxExempt")
                    if isinstance(payload, dict) and payload.get("isTaxExempt") is not None
                    else payload.get("is_tax_exempt") if isinstance(payload, dict) else None
                )
            )
        )
    )
    order: Dict = {
        "id": row.get("id"),
        "userId": row.get("user_id"),
        "asDelegate": row.get("as_delegate"),
        "pricingMode": row.get("pricing_mode") or "wholesale",
        "isTaxExempt": explicit_is_tax_exempt is True or bool(tax_exempt_source),
        "taxExemptSource": tax_exempt_source,
        "taxExemptReason": tax_exempt_reason,
        "resellerPermitFilePath": reseller_permit_file_path,
        "resellerPermitFileName": reseller_permit_file_name,
        "resellerPermitUploadedAt": reseller_permit_uploaded_at,
        "hasResellerPermitUploaded": bool(
            reseller_permit_file_path or reseller_permit_file_name or reseller_permit_uploaded_at
        ),
        "items": _parse_json(row.get("items"), []),
        "total": float(row.get("total") or 0),
        "itemsSubtotal": float(row.get("items_subtotal") or 0) if row.get("items_subtotal") is not None else None,
        "shippingTotal": float(row.get("shipping_total") or 0),
        "shippingEstimate": shipping_estimate,
        "shippingAddress": _read_order_json_field(row, "shipping_address", None),
        "handDelivery": bool(payload.get("handDelivery")) if isinstance(payload, dict) else False,
        "fulfillmentMethod": row.get("fulfillment_method"),
        "shippingCarrier": row.get("shipping_carrier"),
        "shippingService": row.get("shipping_service"),
        "trackingNumber": row.get("tracking_number") or None,
        "upsTrackingStatus": _normalize_ups_tracking_status(
            row.get("ups_tracking_status")
            or (payload_order.get("upsTrackingStatus") if isinstance(payload_order, dict) else None)
            or (payload_order.get("ups_tracking_status") if isinstance(payload_order, dict) else None)
            or (payload.get("upsTrackingStatus") if isinstance(payload, dict) else None)
            or (payload.get("ups_tracking_status") if isinstance(payload, dict) else None)
        ),
        "upsDeliveredAt": _normalize_optional_string(
            fmt_datetime(row.get("delivery_date"))
            or (payload_order.get("upsDeliveredAt") if isinstance(payload_order, dict) else None)
            or (payload_order.get("delivery_date") if isinstance(payload_order, dict) else None)
            or (payload.get("upsDeliveredAt") if isinstance(payload, dict) else None)
            or (payload.get("delivery_date") if isinstance(payload, dict) else None)
            or (shipping_estimate.get("deliveredAt") if isinstance(shipping_estimate, dict) else None)
            or (shipping_estimate.get("delivered_at") if isinstance(shipping_estimate, dict) else None)
        ),
        "deliveryDate": _normalize_optional_string(fmt_datetime(row.get("delivery_date"))),
        "shippedAt": fmt_datetime(row.get("shipped_at")) or None,
        "physicianCertificationAccepted": bool(row.get("physician_certified")),
        "referralCode": row.get("referral_code"),
        "status": row.get("status"),
        "referrerBonus": _parse_json(row.get("referrer_bonus"), None),
        "firstOrderBonus": _parse_json(row.get("first_order_bonus"), None),
        "integrations": integrations_payload,
        "expectedShipmentWindow": row.get("expected_shipment_window") or None,
        "notes": row.get("notes") if row.get("notes") is not None else None,
        "wooOrderId": row.get("woo_order_id") or None,
        "wooOrderNumber": row.get("woo_order_number") or None,
        "wooOrderKey": row.get("woo_order_key") or None,
        "createdAt": fmt_datetime(row.get("created_at")),
        "updatedAt": fmt_datetime(row.get("updated_at")),
    }
    order["upsTrackingStatus"] = _resolve_persisted_ups_tracking_status(order)
    if isinstance(payload, dict) and payload:
        if payload.get("handDelivery") is not None:
            order["handDelivery"] = bool(payload.get("handDelivery"))
        if not order.get("fulfillmentMethod") and payload.get("fulfillmentMethod"):
            order["fulfillmentMethod"] = _normalize_fulfillment_method(payload.get("fulfillmentMethod"))
        payload_items = None
        if isinstance(payload_order, dict):
            payload_items = payload_order.get("items")
        if payload_items is None:
            payload_items = payload.get("items")
        if isinstance(payload_items, list) and not order.get("items"):
            order["items"] = payload_items
        payload_subtotal = (
            (payload_order.get("itemsSubtotal") if isinstance(payload_order, dict) else None)
            or (payload_order.get("subtotal") if isinstance(payload_order, dict) else None)
            or (payload_order.get("items_subtotal") if isinstance(payload_order, dict) else None)
            or (payload_order.get("itemsTotal") if isinstance(payload_order, dict) else None)
            or (payload_order.get("items_total") if isinstance(payload_order, dict) else None)
            or payload.get("itemsSubtotal")
            or payload.get("subtotal")
            or payload.get("items_subtotal")
            or payload.get("itemsTotal")
            or payload.get("items_total")
        )
        try:
            payload_subtotal_value = float(payload_subtotal)
        except Exception:
            payload_subtotal_value = None
        current_subtotal = order.get("itemsSubtotal")
        current_value = None
        try:
            current_value = float(current_subtotal) if current_subtotal is not None else None
        except Exception:
            current_value = None
        if payload_subtotal_value is not None and payload_subtotal_value > 0:
            # For commission math, payload is the source of truth when it includes an explicit subtotal.
            if current_value is None or current_value <= 0 or abs(current_value - payload_subtotal_value) > 0.009:
                order["itemsSubtotal"] = payload_subtotal_value
    if isinstance(payload, dict) and payload:
        for key, value in payload.items():
            if key not in order:
                order[key] = value
    if not order.get("fulfillmentMethod"):
        order["fulfillmentMethod"] = "hand_delivered" if bool(order.get("handDelivery")) else "shipping"
    return _apply_ups_status_to_order(order, order.get("upsTrackingStatus"))


def _to_db_params(order: Dict) -> Dict:
    def serialize_json(value):
        if value is None:
            return None
        return json.dumps(value)

    def parse_dt(value):
        if not value:
            return None
        try:
            pacific = ZoneInfo(os.environ.get("ORDER_TIMEZONE") or "America/Los_Angeles")
        except Exception:
            pacific = timezone.utc

        if isinstance(value, datetime):
            parsed = value
        else:
            text = str(value).strip()
            if not text:
                return None
            # Handle `...Z` and space-separated timestamps.
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            if " " in text and "T" not in text:
                text = text.replace(" ", "T", 1)
            try:
                parsed = datetime.fromisoformat(text)
            except Exception:
                return None

        # If a timestamp is naive, treat it as Pacific (historically some clients sent local time).
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=pacific)

        # Persist MySQL DATETIME values as Pacific local time (no timezone component).
        local = parsed.astimezone(pacific)
        return local.replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")

    def _num(val, fallback: float = 0.0) -> float:
        try:
            return float(val)
        except Exception:
            return fallback

    def _resolve_tracking_number(value: Dict) -> Optional[str]:
        direct = value.get("trackingNumber") or value.get("tracking_number") or value.get("tracking")
        if isinstance(direct, (str, int, float)):
            text = str(direct).strip()
            return text or None
        # common locations
        integrations = value.get("integrationDetails") or value.get("integrations") or {}
        if isinstance(integrations, str):
            try:
                integrations = json.loads(integrations)
            except Exception:
                integrations = {}
        if isinstance(integrations, dict):
            shipstation = integrations.get("shipStation") or integrations.get("shipstation") or {}
            if isinstance(shipstation, str):
                try:
                    shipstation = json.loads(shipstation)
                except Exception:
                    shipstation = {}
            if isinstance(shipstation, dict):
                candidate = shipstation.get("trackingNumber") or shipstation.get("tracking_number") or shipstation.get("tracking")
                if isinstance(candidate, (str, int, float)):
                    text = str(candidate).strip()
                    if text:
                        return text
        shipping = value.get("shippingEstimate") or value.get("shipping") or {}
        if isinstance(shipping, dict):
            candidate = shipping.get("trackingNumber") or shipping.get("tracking_number") or shipping.get("tracking")
            if isinstance(candidate, (str, int, float)):
                text = str(candidate).strip()
                if text:
                    return text
        return None

    def _resolve_shipped_at(value: Dict) -> Optional[str]:
        explicit_candidates = [
            value.get("shippedAt"),
            value.get("shipped_at"),
        ]

        shipping = value.get("shippingEstimate") or value.get("shipping") or {}
        if isinstance(shipping, dict):
            explicit_candidates.extend(
                [
                    shipping.get("shipDate"),
                    shipping.get("shippedAt"),
                    shipping.get("shipped_at"),
                ]
            )

        integrations = value.get("integrationDetails") or value.get("integrations") or {}
        if isinstance(integrations, str):
            try:
                integrations = json.loads(integrations)
            except Exception:
                integrations = {}
        if isinstance(integrations, dict):
            shipstation = integrations.get("shipStation") or integrations.get("shipstation") or {}
            if isinstance(shipstation, str):
                try:
                    shipstation = json.loads(shipstation)
                except Exception:
                    shipstation = {}
            if isinstance(shipstation, dict):
                explicit_candidates.extend(
                    [
                        shipstation.get("shipDate"),
                        shipstation.get("shippedAt"),
                        shipstation.get("shipped_at"),
                    ]
                )

        for candidate in explicit_candidates:
            parsed = parse_dt(candidate)
            if parsed:
                return parsed
        return None

    # Commission reporting must never derive subtotal from order totals.
    items_subtotal = _num(order.get("itemsSubtotal"), 0.0)
    shipping_total = _num(order.get("shippingTotal"), 0.0)
    tax_total = _num(order.get("taxTotal"), 0.0)
    discount_total = _num(order.get("discountTotal"), _num(order.get("appliedReferralCredit"), 0.0) + _num(order.get("discountCodeAmount"), 0.0))
    grand_total = _num(order.get("grandTotal"), items_subtotal - discount_total + shipping_total + tax_total)
    grand_total = max(0.0, grand_total)
    tracking_number = _resolve_tracking_number(order)
    ups_tracking_status = _resolve_persisted_ups_tracking_status(order)
    hand_delivery = bool(order.get("handDelivery") is True)
    fulfillment_method = _normalize_fulfillment_method(
        order.get("fulfillmentMethod"),
        order.get("fulfillment_method"),
    )
    if hand_delivery:
        fulfillment_method = "hand_delivered"
    elif fulfillment_method not in ("shipping", "hand_delivered"):
        fulfillment_method = "shipping"

    return {
        "id": order.get("id"),
        "user_id": order.get("userId"),
        "as_delegate": (
            str(order.get("asDelegate") or order.get("as_delegate")).strip()
            if str(order.get("asDelegate") or order.get("as_delegate") or "").strip()
            else None
        ),
        "pricing_mode": (str(order.get("pricingMode") or "").strip().lower() or "wholesale")
        if str(order.get("pricingMode") or "").strip().lower() in ("wholesale", "retail")
        else "wholesale",
        "is_tax_exempt": 1
        if _coerce_optional_bool(order.get("isTaxExempt") if order.get("isTaxExempt") is not None else order.get("is_tax_exempt")) is True
        else 0,
        "tax_exempt_source": _normalize_optional_string(
            order.get("taxExemptSource") if order.get("taxExemptSource") is not None else order.get("tax_exempt_source")
        ),
        "tax_exempt_reason": _normalize_optional_string(
            order.get("taxExemptReason") if order.get("taxExemptReason") is not None else order.get("tax_exempt_reason")
        ),
        "reseller_permit_file_path": _normalize_optional_string(
            order.get("resellerPermitFilePath")
            if order.get("resellerPermitFilePath") is not None
            else order.get("reseller_permit_file_path")
        ),
        "reseller_permit_file_name": _normalize_optional_string(
            order.get("resellerPermitFileName")
            if order.get("resellerPermitFileName") is not None
            else order.get("reseller_permit_file_name")
        ),
        "reseller_permit_uploaded_at": parse_dt(
            order.get("resellerPermitUploadedAt")
            if order.get("resellerPermitUploadedAt") is not None
            else order.get("reseller_permit_uploaded_at")
        ),
        "items": serialize_json(order.get("items")),
        "items_subtotal": float(max(0.0, items_subtotal)),
        # `orders.total` should reflect the full amount paid (subtotal - discounts + shipping + tax).
        "total": float(grand_total),
        "shipping_total": 0.0 if hand_delivery else float(order.get("shippingTotal") or 0),
        "fulfillment_method": fulfillment_method,
        "shipping_carrier": order.get("shippingCarrier")
        or order.get("shippingEstimate", {}).get("carrierId")
        or order.get("shippingEstimate", {}).get("carrier_id"),
        "shipping_service": HAND_DELIVERY_SERVICE_LABEL
        if _is_hand_delivery_order(order)
        else (
            order.get("shippingService")
            or order.get("shippingEstimate", {}).get("serviceType")
            or order.get("shippingEstimate", {}).get("serviceCode")
        ),
        "tracking_number": tracking_number,
        "ups_tracking_status": ups_tracking_status,
        "delivery_date": parse_dt(_resolve_persisted_delivery_date(order)),
        "shipped_at": _resolve_shipped_at(order),
        "physician_certified": 1 if order.get("physicianCertificationAccepted") else 0,
        "referral_code": order.get("referralCode"),
        "status": order.get("status") or "pending",
        "referrer_bonus": serialize_json(order.get("referrerBonus")),
        "first_order_bonus": serialize_json(order.get("firstOrderBonus")),
        "integrations": serialize_json(order.get("integrations")),
        "shipping_rate": serialize_json(order.get("shippingEstimate")),
        "expected_shipment_window": (order.get("expectedShipmentWindow") or None),
        "notes": order.get("notes") if order.get("notes") is not None else None,
        "shipping_address": encrypt_json(
            order.get("shippingAddress"),
            aad=_order_field_aad(order.get("id"), "shipping_address"),
        ),
        "payload": encrypt_json(order, aad=_order_field_aad(order.get("id"), "payload")),
        "created_at": parse_dt(order.get("createdAt")),
        "updated_at": parse_dt(order.get("updatedAt") or datetime.now(timezone.utc)),
    }
