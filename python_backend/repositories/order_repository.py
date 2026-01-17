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
                id, user_id, items, total, shipping_total, shipping_carrier, shipping_service,
                physician_certified, referral_code, status,
                referrer_bonus, first_order_bonus, integrations, shipping_rate, expected_shipment_window, notes, shipping_address, payload,
                created_at, updated_at
            ) VALUES (
                %(id)s, %(user_id)s, %(items)s, %(total)s, %(shipping_total)s, %(shipping_carrier)s, %(shipping_service)s,
                %(physician_certified)s, %(referral_code)s, %(status)s,
                %(referrer_bonus)s, %(first_order_bonus)s, %(integrations)s, %(shipping_rate)s, %(expected_shipment_window)s, %(notes)s, %(shipping_address)s, %(payload)s,
                %(created_at)s, %(updated_at)s
            )
            ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id),
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

    return {
        "id": order.get("id"),
        "user_id": order.get("userId"),
        "items": serialize_json(order.get("items")),
        "total": float(order.get("total") or 0),
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
