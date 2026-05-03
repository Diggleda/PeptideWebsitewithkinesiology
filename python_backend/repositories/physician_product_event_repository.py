from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..services import get_config


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _parse_json(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _format_datetime(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, datetime):
        normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return normalized.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _row_to_event(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": row.get("id"),
        "userId": row.get("user_id"),
        "eventType": row.get("event_type"),
        "wooProductId": row.get("woo_product_id"),
        "wooVariationId": row.get("woo_variation_id"),
        "sku": row.get("sku"),
        "quantity": int(row.get("quantity") or 1),
        "metadata": _parse_json(row.get("metadata_json")),
        "occurredAt": _format_datetime(row.get("occurred_at")),
        "createdAt": _format_datetime(row.get("created_at")),
    }


def insert_event(
    *,
    user_id: str,
    event_type: str,
    woo_product_id: Optional[int] = None,
    woo_variation_id: Optional[int] = None,
    sku: Optional[str] = None,
    quantity: int = 1,
    metadata: Optional[Dict[str, Any]] = None,
    occurred_at: Optional[datetime] = None,
) -> bool:
    if not _using_mysql():
        return False

    normalized_user_id = str(user_id or "").strip()
    normalized_event_type = str(event_type or "").strip()[:64]
    if not normalized_user_id or not normalized_event_type:
        return False

    try:
        qty = int(float(quantity or 1))
    except Exception:
        qty = 1
    qty = max(1, qty)

    occurred = occurred_at or datetime.now(timezone.utc)
    if occurred.tzinfo is not None:
        occurred = occurred.astimezone(timezone.utc).replace(tzinfo=None)

    mysql_client.execute(
        """
        INSERT INTO physician_product_events (
            user_id,
            event_type,
            woo_product_id,
            woo_variation_id,
            sku,
            quantity,
            metadata_json,
            occurred_at,
            created_at
        ) VALUES (
            %(user_id)s,
            %(event_type)s,
            %(woo_product_id)s,
            %(woo_variation_id)s,
            %(sku)s,
            %(quantity)s,
            %(metadata_json)s,
            %(occurred_at)s,
            NOW()
        )
        """,
        {
            "user_id": normalized_user_id,
            "event_type": normalized_event_type,
            "woo_product_id": woo_product_id,
            "woo_variation_id": woo_variation_id,
            "sku": str(sku or "").strip()[:128] or None,
            "quantity": qty,
            "metadata_json": json.dumps(metadata or {}, separators=(",", ":")),
            "occurred_at": occurred,
        },
    )
    return True


def find_recent_for_user(user_id: str, *, limit: int = 1000) -> List[Dict[str, Any]]:
    if not _using_mysql():
        return []
    normalized_user_id = str(user_id or "").strip()
    if not normalized_user_id:
        return []
    try:
        safe_limit = max(1, min(int(limit), 5000))
    except Exception:
        safe_limit = 1000
    rows = mysql_client.fetch_all(
        """
        SELECT *
        FROM physician_product_events
        WHERE user_id = %(user_id)s
        ORDER BY occurred_at DESC, id DESC
        LIMIT %(limit)s
        """,
        {"user_id": normalized_user_id, "limit": safe_limit},
    )
    return [_row_to_event(row) for row in rows or []]


def list_recent(*, days: int = 90, limit: int = 5000) -> List[Dict[str, Any]]:
    if not _using_mysql():
        return []
    try:
        safe_days = max(1, min(int(days), 365))
    except Exception:
        safe_days = 90
    try:
        safe_limit = max(1, min(int(limit), 20000))
    except Exception:
        safe_limit = 5000
    cutoff = datetime.now(timezone.utc) - timedelta(days=safe_days)
    rows = mysql_client.fetch_all(
        """
        SELECT *
        FROM physician_product_events
        WHERE occurred_at >= %(cutoff)s
        ORDER BY occurred_at DESC, id DESC
        LIMIT %(limit)s
        """,
        {"cutoff": cutoff.replace(tzinfo=None), "limit": safe_limit},
    )
    return [_row_to_event(row) for row in rows or []]
