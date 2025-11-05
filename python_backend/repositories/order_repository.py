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


def insert(order: Dict) -> Dict:
    if _using_mysql():
        order.setdefault("id", order.get("id") or _generate_id())
        params = _to_db_params(order)
        mysql_client.execute(
            """
            INSERT INTO orders (
                id, user_id, items, total, referral_code, status,
                referrer_bonus, first_order_bonus, integrations, shipping_address, created_at
            ) VALUES (
                %(id)s, %(user_id)s, %(items)s, %(total)s, %(referral_code)s, %(status)s,
                %(referrer_bonus)s, %(first_order_bonus)s, %(integrations)s, %(shipping_address)s, %(created_at)s
            )
            ON DUPLICATE KEY UPDATE
                user_id = VALUES(user_id),
                items = VALUES(items),
                total = VALUES(total),
                referral_code = VALUES(referral_code),
                status = VALUES(status),
                referrer_bonus = VALUES(referrer_bonus),
                first_order_bonus = VALUES(first_order_bonus),
                integrations = VALUES(integrations),
                shipping_address = VALUES(shipping_address),
                created_at = VALUES(created_at)
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
                referral_code = %(referral_code)s,
                status = %(status)s,
                referrer_bonus = %(referrer_bonus)s,
                first_order_bonus = %(first_order_bonus)s,
                integrations = %(integrations)s,
                shipping_address = %(shipping_address)s,
                created_at = %(created_at)s
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

    return {
        "id": row.get("id"),
        "userId": row.get("user_id"),
        "items": parse_json(row.get("items"), []),
        "total": float(row.get("total") or 0),
        "referralCode": row.get("referral_code"),
        "status": row.get("status"),
        "referrerBonus": parse_json(row.get("referrer_bonus"), None),
        "firstOrderBonus": parse_json(row.get("first_order_bonus"), None),
        "integrations": parse_json(row.get("integrations"), {}),
        "shippingAddress": parse_json(row.get("shipping_address"), None),
        "createdAt": fmt_datetime(row.get("created_at")),
    }


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
        "referral_code": order.get("referralCode"),
        "status": order.get("status") or "pending",
        "referrer_bonus": serialize_json(order.get("referrerBonus")),
        "first_order_bonus": serialize_json(order.get("firstOrderBonus")),
        "integrations": serialize_json(order.get("integrations")),
        "shipping_address": serialize_json(order.get("shippingAddress")),
        "created_at": parse_dt(order.get("createdAt")),
    }
