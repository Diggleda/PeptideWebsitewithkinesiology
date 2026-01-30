from __future__ import annotations

import json
from typing import Any, Dict, Optional

from python_backend.database import mysql_client


def _safe_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _parse_json(value: Any) -> Any:
    if not value:
        return None
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str):
        return None
    try:
        return json.loads(value)
    except Exception:
        return None


def _resolve_tracking(payload: Dict[str, Any]) -> Optional[str]:
    direct = payload.get("trackingNumber") or payload.get("tracking_number") or payload.get("tracking")
    tracking = _safe_str(direct)
    if tracking:
        return tracking

    integrations = payload.get("integrationDetails") or payload.get("integrations") or {}
    integrations = _parse_json(integrations) or {}
    if isinstance(integrations, dict):
        shipstation = integrations.get("shipStation") or integrations.get("shipstation") or {}
        shipstation = _parse_json(shipstation) or {}
        if isinstance(shipstation, dict):
            tracking = _safe_str(
                shipstation.get("trackingNumber")
                or shipstation.get("tracking_number")
                or shipstation.get("tracking")
            )
            if tracking:
                return tracking

    shipping = payload.get("shippingEstimate") or payload.get("shipping") or {}
    shipping = _parse_json(shipping) or shipping
    if isinstance(shipping, dict):
        tracking = _safe_str(
            shipping.get("trackingNumber")
            or shipping.get("tracking_number")
            or shipping.get("tracking")
        )
        if tracking:
            return tracking

    return None


def main(limit: int = 2000) -> None:
    rows = mysql_client.fetch_all(
        """
        SELECT id, woo_order_number, payload
        FROM orders
        WHERE tracking_number IS NULL
          AND payload IS NOT NULL
        ORDER BY updated_at DESC
        LIMIT %(limit)s
        """,
        {"limit": int(limit)},
    )
    updated = 0
    scanned = 0
    for row in rows or []:
        scanned += 1
        order_id = _safe_str(row.get("id"))
        payload_raw = row.get("payload")
        if not order_id or not payload_raw:
            continue
        payload = _parse_json(payload_raw)
        if not isinstance(payload, dict):
            continue
        tracking = _resolve_tracking(payload)
        if not tracking:
            continue
        mysql_client.execute(
            "UPDATE orders SET tracking_number = %(tracking)s WHERE id = %(id)s AND tracking_number IS NULL",
            {"tracking": tracking, "id": order_id},
        )
        updated += 1

    print(json.dumps({"scanned": scanned, "updated": updated}, indent=2))


if __name__ == "__main__":
    main()

