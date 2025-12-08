from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional

from ..services import get_config
from ..database import mysql_client
from .. import storage


def _using_mysql() -> bool:
    if not get_config().mysql.get("enabled"):
        raise RuntimeError("MySQL must be enabled for referral code repository access")
    return True


def _get_store():
    store = storage.referral_code_store
    if store is None:
        raise RuntimeError("referral_code_store is not initialised")
    return store


def _normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def _ensure_defaults(record: Dict) -> Dict:
    normalized = dict(record)
    normalized.setdefault("id", record.get("id") or _generate_id())
    normalized["code"] = _normalize_code(record.get("code"))
    normalized.setdefault("status", record.get("status") or "available")
    normalized.setdefault("createdAt", record.get("createdAt") or _now())
    normalized["updatedAt"] = record.get("updatedAt") or normalized["createdAt"]
    history = record.get("history")
    normalized["history"] = history if isinstance(history, list) else []
    return normalized


def _load() -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM referral_codes")
        return [_row_to_record(row) for row in rows]
    return [_ensure_defaults(record) for record in _get_store().read()]


def _save(records: List[Dict]) -> None:
    if _using_mysql():
        raise RuntimeError("Direct save not available with MySQL backend")
    _get_store().write([_ensure_defaults(record) for record in records])


def get_all() -> List[Dict]:
    return _load()


def find_by_id(record_id: str) -> Optional[Dict]:
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM referral_codes WHERE id = %(id)s", {"id": record_id})
        return _row_to_record(row)
    return next((record for record in _load() if record.get("id") == record_id), None)


def find_by_code(code: str) -> Optional[Dict]:
    candidate = _normalize_code(code)
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM referral_codes WHERE code = %(code)s", {"code": candidate})
        return _row_to_record(row)
    return next((record for record in _load() if record.get("code") == candidate), None)


def find_available_by_rep(sales_rep_id: str) -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all(
            "SELECT * FROM referral_codes WHERE sales_rep_id = %(sales_rep_id)s AND status = 'available'",
            {"sales_rep_id": sales_rep_id},
        )
        return [_row_to_record(row) for row in rows]
    return [
        record
        for record in _load()
        if record.get("salesRepId") == sales_rep_id and record.get("status") == "available"
    ]


def insert(record: Dict) -> Dict:
    if _using_mysql():
        normalized = _ensure_defaults(record)
        params = _to_db_params(normalized)
        mysql_client.execute(
            """
            INSERT INTO referral_codes (
                id, sales_rep_id, referrer_doctor_id, referral_id, doctor_id,
                code, status, issued_at, redeemed_at, history, created_at, updated_at
            ) VALUES (
                %(id)s, %(sales_rep_id)s, %(referrer_doctor_id)s, %(referral_id)s, %(doctor_id)s,
                %(code)s, %(status)s, %(issued_at)s, %(redeemed_at)s, %(history)s, %(created_at)s, %(updated_at)s
            )
            ON DUPLICATE KEY UPDATE
                sales_rep_id = VALUES(sales_rep_id),
                referrer_doctor_id = VALUES(referrer_doctor_id),
                referral_id = VALUES(referral_id),
                doctor_id = VALUES(doctor_id),
                status = VALUES(status),
                issued_at = VALUES(issued_at),
                redeemed_at = VALUES(redeemed_at),
                history = VALUES(history),
                updated_at = VALUES(updated_at)
            """,
            params,
        )
        return find_by_id(normalized["id"])

    records = _load()
    normalized = _ensure_defaults(record)
    normalized["updatedAt"] = _now()
    records.append(normalized)
    _save(records)
    return normalized


def update(record: Dict) -> Optional[Dict]:
    if _using_mysql():
        existing = find_by_id(record.get("id"))
        if not existing:
            return None
        merged = _ensure_defaults({**existing, **record, "updatedAt": _now()})
        params = _to_db_params(merged)
        mysql_client.execute(
            """
            UPDATE referral_codes
            SET
                sales_rep_id = %(sales_rep_id)s,
                referrer_doctor_id = %(referrer_doctor_id)s,
                referral_id = %(referral_id)s,
                doctor_id = %(doctor_id)s,
                code = %(code)s,
                status = %(status)s,
                issued_at = %(issued_at)s,
                redeemed_at = %(redeemed_at)s,
                history = %(history)s,
                updated_at = %(updated_at)s
            WHERE id = %(id)s
            """,
            params,
        )
        return find_by_id(merged["id"])

    records = _load()
    for index, existing in enumerate(records):
        if existing.get("id") == record.get("id"):
            updated = _ensure_defaults({**existing, **record, "updatedAt": _now()})
            records[index] = updated
            _save(records)
            return updated
    return None


def _row_to_record(row: Optional[Dict]) -> Optional[Dict]:
    if not row:
        return None

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    def parse_json(value):
        if not value:
            return []
        try:
            return json.loads(value)
        except Exception:
            return []

    return _ensure_defaults(
        {
            "id": row.get("id"),
            "salesRepId": row.get("sales_rep_id"),
            "referrerDoctorId": row.get("referrer_doctor_id"),
            "referralId": row.get("referral_id"),
            "doctorId": row.get("doctor_id"),
            "code": row.get("code"),
            "status": row.get("status"),
            "issuedAt": fmt_datetime(row.get("issued_at")),
            "redeemedAt": fmt_datetime(row.get("redeemed_at")),
            "history": parse_json(row.get("history")),
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
    )


def _to_db_params(record: Dict) -> Dict:
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
        "id": record.get("id"),
        "sales_rep_id": record.get("salesRepId"),
        "referrer_doctor_id": record.get("referrerDoctorId"),
        "referral_id": record.get("referralId"),
        "doctor_id": record.get("doctorId"),
        "code": record.get("code"),
        "status": record.get("status"),
        "issued_at": parse_dt(record.get("issuedAt")),
        "redeemed_at": parse_dt(record.get("redeemedAt")),
        "history": serialize_json(record.get("history")),
        "created_at": parse_dt(record.get("createdAt")),
        "updated_at": parse_dt(record.get("updatedAt")),
    }


def _generate_id() -> str:
    from time import time

    return str(int(time() * 1000))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
