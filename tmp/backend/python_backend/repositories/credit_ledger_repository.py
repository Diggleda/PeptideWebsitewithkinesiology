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
    store = storage.credit_ledger_store
    if store is None:
        raise RuntimeError("credit_ledger_store is not initialised")
    return store


def _ensure_defaults(entry: Dict) -> Dict:
    normalized = dict(entry)
    normalized.setdefault("id", entry.get("id") or _generate_id())
    normalized["currency"] = entry.get("currency") or "USD"
    normalized["direction"] = entry.get("direction") or "credit"
    normalized["reason"] = entry.get("reason") or "referral_bonus"
    normalized["amount"] = float(entry.get("amount") or 0)
    normalized["firstOrderBonus"] = bool(entry.get("firstOrderBonus"))
    normalized["issuedAt"] = entry.get("issuedAt") or _now()
    normalized["createdAt"] = entry.get("createdAt") or normalized["issuedAt"]
    normalized["updatedAt"] = entry.get("updatedAt") or normalized["createdAt"]
    metadata = entry.get("metadata")
    normalized["metadata"] = metadata if isinstance(metadata, dict) else {}
    return normalized


def _load() -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM credit_ledger")
        return [_row_to_entry(row) for row in rows]
    return [_ensure_defaults(entry) for entry in _get_store().read()]


def _save(entries: List[Dict]) -> None:
    if _using_mysql():
        raise RuntimeError("Direct save not available with MySQL backend")
    _get_store().write([_ensure_defaults(entry) for entry in entries])


def get_all() -> List[Dict]:
    return _load()


def find_by_id(entry_id: str) -> Optional[Dict]:
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM credit_ledger WHERE id = %(id)s", {"id": entry_id})
        return _row_to_entry(row)
    return next((entry for entry in _load() if entry.get("id") == entry_id), None)


def find_by_doctor(doctor_id: str) -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM credit_ledger WHERE doctor_id = %(doctor_id)s", {"doctor_id": doctor_id})
        return [_row_to_entry(row) for row in rows]
    return [entry for entry in _load() if entry.get("doctorId") == doctor_id]


def insert(entry: Dict) -> Dict:
    if _using_mysql():
        record = _ensure_defaults(entry)
        params = _to_db_params(record)
        mysql_client.execute(
            """
            INSERT INTO credit_ledger (
                id, doctor_id, sales_rep_id, referral_id, order_id,
                amount, currency, direction, reason, description,
                first_order_bonus, metadata, issued_at, created_at, updated_at
            ) VALUES (
                %(id)s, %(doctor_id)s, %(sales_rep_id)s, %(referral_id)s, %(order_id)s,
                %(amount)s, %(currency)s, %(direction)s, %(reason)s, %(description)s,
                %(first_order_bonus)s, %(metadata)s, %(issued_at)s, %(created_at)s, %(updated_at)s
            )
            ON DUPLICATE KEY UPDATE
                doctor_id = VALUES(doctor_id),
                sales_rep_id = VALUES(sales_rep_id),
                referral_id = VALUES(referral_id),
                order_id = VALUES(order_id),
                amount = VALUES(amount),
                currency = VALUES(currency),
                direction = VALUES(direction),
                reason = VALUES(reason),
                description = VALUES(description),
                first_order_bonus = VALUES(first_order_bonus),
                metadata = VALUES(metadata),
                issued_at = VALUES(issued_at),
                created_at = VALUES(created_at),
                updated_at = VALUES(updated_at)
            """,
            params,
        )
        return find_by_id(record["id"])

    entries = _load()
    normalized = _ensure_defaults(entry)
    entries.append(normalized)
    _save(entries)
    return normalized


def update(entry: Dict) -> Optional[Dict]:
    if _using_mysql():
        existing = find_by_id(entry.get("id"))
        if not existing:
            return None
        merged = _ensure_defaults({**existing, **entry, "updatedAt": _now()})
        params = _to_db_params(merged)
        mysql_client.execute(
            """
            UPDATE credit_ledger
            SET
                doctor_id = %(doctor_id)s,
                sales_rep_id = %(sales_rep_id)s,
                referral_id = %(referral_id)s,
                order_id = %(order_id)s,
                amount = %(amount)s,
                currency = %(currency)s,
                direction = %(direction)s,
                reason = %(reason)s,
                description = %(description)s,
                first_order_bonus = %(first_order_bonus)s,
                metadata = %(metadata)s,
                issued_at = %(issued_at)s,
                created_at = %(created_at)s,
                updated_at = %(updated_at)s
            WHERE id = %(id)s
            """,
            params,
        )
        return find_by_id(merged["id"])

    entries = _load()
    for index, existing in enumerate(entries):
        if existing.get("id") == entry.get("id"):
            updated = _ensure_defaults({**existing, **entry, "updatedAt": _now()})
            entries[index] = updated
            _save(entries)
            return updated
    return None


def summarize_credits(doctor_id: str) -> Dict[str, float]:
    entries = find_by_doctor(doctor_id)
    summary = {"total": 0.0, "firstOrderBonuses": 0.0}
    for entry in entries:
        sign = -1 if entry.get("direction") == "debit" else 1
        amount = float(entry.get("amount") or 0)
        summary["total"] += sign * amount
        if entry.get("firstOrderBonus") and entry.get("direction") == "credit":
            summary["firstOrderBonuses"] += amount
    return summary


def _row_to_entry(row: Optional[Dict]) -> Optional[Dict]:
    if not row:
        return None

    def parse_json(value):
        if not value:
            return {}
        try:
            return json.loads(value)
        except Exception:
            return {}

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    return _ensure_defaults(
        {
            "id": row.get("id"),
            "doctorId": row.get("doctor_id"),
            "salesRepId": row.get("sales_rep_id"),
            "referralId": row.get("referral_id"),
            "orderId": row.get("order_id"),
            "amount": float(row.get("amount") or 0),
            "currency": row.get("currency"),
            "direction": row.get("direction"),
            "reason": row.get("reason"),
            "description": row.get("description"),
            "firstOrderBonus": bool(row.get("first_order_bonus")),
            "metadata": parse_json(row.get("metadata")),
            "issuedAt": fmt_datetime(row.get("issued_at")),
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
    )


def _to_db_params(entry: Dict) -> Dict:
    def serialize_json(value):
        if not value:
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
        "id": entry.get("id"),
        "doctor_id": entry.get("doctorId"),
        "sales_rep_id": entry.get("salesRepId"),
        "referral_id": entry.get("referralId"),
        "order_id": entry.get("orderId"),
        "amount": float(entry.get("amount") or 0),
        "currency": entry.get("currency"),
        "direction": entry.get("direction"),
        "reason": entry.get("reason"),
        "description": entry.get("description"),
        "first_order_bonus": 1 if entry.get("firstOrderBonus") else 0,
        "metadata": serialize_json(entry.get("metadata")),
        "issued_at": parse_dt(entry.get("issuedAt")),
        "created_at": parse_dt(entry.get("createdAt")),
        "updated_at": parse_dt(entry.get("updatedAt")),
    }


def _generate_id() -> str:
    from time import time

    return str(int(time() * 1000))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
