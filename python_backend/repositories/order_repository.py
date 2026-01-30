from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional

from ..services import get_config
from ..database import mysql_client
from .. import storage


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _get_store():
    store = storage.order_store
    if store is None:
        raise RuntimeError("order_store is not initialised")
    return store


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

    rows = mysql_client.fetch_all(
        """
        SELECT
            id,
            pricing_mode,
            items,
            total,
            shipping_total,
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

    def parse_json(value, default=None):
        if not value:
            return default
        try:
            return json.loads(value)
        except Exception:
            return default

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    result: List[Dict] = []
    for row in rows or []:
        result.append(
            {
                "id": row.get("id"),
                "items": parse_json(row.get("items"), []) if row.get("items") is not None else [],
                "total": float(row.get("total") or 0),
                "pricingMode": row.get("pricing_mode") or "wholesale",
                "shippingTotal": float(row.get("shipping_total") or 0),
                "status": row.get("status"),
                "notes": row.get("notes") if row.get("notes") is not None else None,
                "shippingAddress": parse_json(row.get("shipping_address")),
                "expectedShipmentWindow": row.get("expected_shipment_window") or None,
                "shippingCarrier": row.get("shipping_carrier"),
                "shippingService": row.get("shipping_service"),
                "wooOrderId": row.get("woo_order_id") or None,
                "wooOrderNumber": row.get("woo_order_number") or None,
                "wooOrderKey": row.get("woo_order_key") or None,
                "createdAt": fmt_datetime(row.get("created_at")),
                "updatedAt": fmt_datetime(row.get("updated_at")),
            }
        )
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
        mysql_client.execute(
            """
            INSERT INTO orders (
                id, user_id, pricing_mode, items, total, shipping_total, shipping_carrier, shipping_service,
                physician_certified, referral_code, status,
                referrer_bonus, first_order_bonus, integrations, shipping_rate, expected_shipment_window, notes, shipping_address, payload,
                created_at, updated_at
            ) VALUES (
                %(id)s, %(user_id)s, %(pricing_mode)s, %(items)s, %(total)s, %(shipping_total)s, %(shipping_carrier)s, %(shipping_service)s,
                %(physician_certified)s, %(referral_code)s, %(status)s,
                %(referrer_bonus)s, %(first_order_bonus)s, %(integrations)s, %(shipping_rate)s, %(expected_shipment_window)s, %(notes)s, %(shipping_address)s, %(payload)s,
                %(created_at)s, %(updated_at)s
            )
            ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id),
                pricing_mode = VALUES(pricing_mode),
                items = VALUES(items),
                total = VALUES(total),
                shipping_total = VALUES(shipping_total),
                shipping_carrier = VALUES(shipping_carrier),
                shipping_service = VALUES(shipping_service),
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
        return find_by_id(order["id"])

    orders = _load()
    orders.append(dict(order))
    _save(orders)
    return order


def update(order: Dict) -> Optional[Dict]:
    if _using_mysql():
        params = _to_db_params(order)
        mysql_client.execute(
            """
            UPDATE orders
            SET
                user_id = %(user_id)s,
                pricing_mode = %(pricing_mode)s,
                items = %(items)s,
                total = %(total)s,
                shipping_total = %(shipping_total)s,
                shipping_carrier = %(shipping_carrier)s,
                shipping_service = %(shipping_service)s,
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

    def parse_json(value, default):
        if not value:
            return default
        try:
            return json.loads(value)
        except Exception:
            return default

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    payload = parse_json(row.get("payload"), {})
    order: Dict = {
        "id": row.get("id"),
        "userId": row.get("user_id"),
        "pricingMode": row.get("pricing_mode") or "wholesale",
        "items": parse_json(row.get("items"), []),
        "total": float(row.get("total") or 0),
        "shippingTotal": float(row.get("shipping_total") or 0),
        "shippingEstimate": parse_json(row.get("shipping_rate"), parse_json(row.get("integrations"), {}).get("shippingRate", {})),
        "shippingAddress": parse_json(row.get("shipping_address"), None),
        "shippingCarrier": row.get("shipping_carrier"),
        "shippingService": row.get("shipping_service"),
        "physicianCertificationAccepted": bool(row.get("physician_certified")),
        "referralCode": row.get("referral_code"),
        "status": row.get("status"),
        "referrerBonus": parse_json(row.get("referrer_bonus"), None),
        "firstOrderBonus": parse_json(row.get("first_order_bonus"), None),
        "integrations": parse_json(row.get("integrations"), {}),
        "expectedShipmentWindow": row.get("expected_shipment_window") or None,
        "notes": row.get("notes") if row.get("notes") is not None else None,
        "wooOrderId": row.get("woo_order_id") or None,
        "wooOrderNumber": row.get("woo_order_number") or None,
        "wooOrderKey": row.get("woo_order_key") or None,
        "createdAt": fmt_datetime(row.get("created_at")),
        "updatedAt": fmt_datetime(row.get("updated_at")),
    }
    if isinstance(payload, dict) and payload:
        for key, value in payload.items():
            if key not in order:
                order[key] = value
    return order


def _to_db_params(order: Dict) -> Dict:
    def serialize_json(value):
        if value is None:
            return None
        return json.dumps(value)

    def parse_dt(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=None)
        value = str(value)
        if value.endswith("Z"):
            value = value[:-1]
        value = value.replace("T", " ")
        return value[:26]

    def _num(val, fallback: float = 0.0) -> float:
        try:
            return float(val)
        except Exception:
            return fallback

    items_subtotal = _num(order.get("itemsSubtotal"), _num(order.get("total"), 0.0))
    shipping_total = _num(order.get("shippingTotal"), 0.0)
    tax_total = _num(order.get("taxTotal"), 0.0)
    discount_total = _num(order.get("appliedReferralCredit"), 0.0)
    grand_total = _num(order.get("grandTotal"), items_subtotal - discount_total + shipping_total + tax_total)
    grand_total = max(0.0, grand_total)

    return {
        "id": order.get("id"),
        "user_id": order.get("userId"),
        "pricing_mode": (str(order.get("pricingMode") or "").strip().lower() or "wholesale")
        if str(order.get("pricingMode") or "").strip().lower() in ("wholesale", "retail")
        else "wholesale",
        "items": serialize_json(order.get("items")),
        # `orders.total` should reflect the full amount paid (subtotal - discounts + shipping + tax).
        "total": float(grand_total),
        "shipping_total": float(order.get("shippingTotal") or 0),
        "shipping_carrier": order.get("shippingCarrier")
        or order.get("shippingEstimate", {}).get("carrierId")
        or order.get("shippingEstimate", {}).get("carrier_id"),
        "shipping_service": order.get("shippingService")
        or order.get("shippingEstimate", {}).get("serviceType")
        or order.get("shippingEstimate", {}).get("serviceCode"),
        "physician_certified": 1 if order.get("physicianCertificationAccepted") else 0,
        "referral_code": order.get("referralCode"),
        "status": order.get("status") or "pending",
        "referrer_bonus": serialize_json(order.get("referrerBonus")),
        "first_order_bonus": serialize_json(order.get("firstOrderBonus")),
        "integrations": serialize_json(order.get("integrations")),
        "shipping_rate": serialize_json(order.get("shippingEstimate")),
        "expected_shipment_window": (order.get("expectedShipmentWindow") or None),
        "notes": order.get("notes") if order.get("notes") is not None else None,
        "shipping_address": serialize_json(order.get("shippingAddress")),
        "payload": serialize_json(order),
        "created_at": parse_dt(order.get("createdAt")),
        "updated_at": parse_dt(order.get("updatedAt") or datetime.now(timezone.utc)),
    }
