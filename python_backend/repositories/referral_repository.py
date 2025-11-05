from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional

from ..services import get_config
from ..database import mysql_client
from .. import storage


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _get_store():
    store = storage.referral_store
    if store is None:
        raise RuntimeError("referral_store is not initialised")
    return store


def _ensure_defaults(referral: Dict) -> Dict:
    normalized = dict(referral)
    normalized.setdefault("id", referral.get("id") or _generate_id())
    normalized.setdefault("status", referral.get("status") or "pending")
    normalized.setdefault("referralCodeId", referral.get("referralCodeId") or None)
    normalized.setdefault("salesRepId", referral.get("salesRepId") or None)
    normalized.setdefault("referrerDoctorId", referral.get("referrerDoctorId") or None)
    created_at = normalized.get("createdAt") or _now()
    normalized["createdAt"] = created_at
    normalized["updatedAt"] = normalized.get("updatedAt") or created_at
    return normalized


def _load() -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM referrals")
        return [_row_to_referral(row) for row in rows]
    return [_ensure_defaults(record) for record in _get_store().read()]


def _save(records: List[Dict]) -> None:
    if _using_mysql():
        raise RuntimeError("Direct save not available with MySQL backend")
    _get_store().write([_ensure_defaults(record) for record in records])


def get_all() -> List[Dict]:
    return _load()


def find_by_id(referral_id: str) -> Optional[Dict]:
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM referrals WHERE id = %(id)s", {"id": referral_id})
        return _row_to_referral(row)
    return next((record for record in _load() if record.get("id") == referral_id), None)


def find_by_code_id(code_id: str) -> Optional[Dict]:
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM referrals WHERE referral_code_id = %(code_id)s", {"code_id": code_id})
        return _row_to_referral(row)
    return next((record for record in _load() if record.get("referralCodeId") == code_id), None)


def find_by_referrer(referrer_id: str) -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all(
            "SELECT * FROM referrals WHERE referrer_doctor_id = %(referrer_id)s",
            {"referrer_id": referrer_id},
        )
        return [_row_to_referral(row) for row in rows]
    return [record for record in _load() if record.get("referrerDoctorId") == referrer_id]


def insert(referral: Dict) -> Dict:
    if _using_mysql():
        record = _ensure_defaults(referral)
        params = _to_db_params(record)
        mysql_client.execute(
            """
            INSERT INTO referrals (
                id, referrer_doctor_id, sales_rep_id, referral_code_id,
                referred_contact_name, referred_contact_email, referred_contact_phone,
                status, notes, converted_doctor_id, converted_at, created_at, updated_at
            ) VALUES (
                %(id)s, %(referrer_doctor_id)s, %(sales_rep_id)s, %(referral_code_id)s,
                %(referred_contact_name)s, %(referred_contact_email)s, %(referred_contact_phone)s,
                %(status)s, %(notes)s, %(converted_doctor_id)s, %(converted_at)s, %(created_at)s, %(updated_at)s
            )
            ON DUPLICATE KEY UPDATE
                referrer_doctor_id = VALUES(referrer_doctor_id),
                sales_rep_id = VALUES(sales_rep_id),
                referral_code_id = VALUES(referral_code_id),
                referred_contact_name = VALUES(referred_contact_name),
                referred_contact_email = VALUES(referred_contact_email),
                referred_contact_phone = VALUES(referred_contact_phone),
                status = VALUES(status),
                notes = VALUES(notes),
                converted_doctor_id = VALUES(converted_doctor_id),
                converted_at = VALUES(converted_at),
                updated_at = VALUES(updated_at)
            """,
            params,
        )
        return find_by_id(record["id"])

    records = _load()
    normalized = _ensure_defaults(referral)
    records.append(normalized)
    _save(records)
    return normalized


def update(referral: Dict) -> Optional[Dict]:
    if _using_mysql():
        existing = find_by_id(referral.get("id"))
        if not existing:
            return None
        merged = _ensure_defaults({**existing, **referral, "updatedAt": _now()})
        params = _to_db_params(merged)
        mysql_client.execute(
            """
            UPDATE referrals
            SET
                referrer_doctor_id = %(referrer_doctor_id)s,
                sales_rep_id = %(sales_rep_id)s,
                referral_code_id = %(referral_code_id)s,
                referred_contact_name = %(referred_contact_name)s,
                referred_contact_email = %(referred_contact_email)s,
                referred_contact_phone = %(referred_contact_phone)s,
                status = %(status)s,
                notes = %(notes)s,
                converted_doctor_id = %(converted_doctor_id)s,
                converted_at = %(converted_at)s,
                updated_at = %(updated_at)s
            WHERE id = %(id)s
            """,
            params,
        )
        return find_by_id(merged["id"])

    records = _load()
    for index, existing in enumerate(records):
        if existing.get("id") == referral.get("id"):
            merged = _ensure_defaults({**existing, **referral, "updatedAt": _now()})
            records[index] = merged
            _save(records)
            return merged
    return None


def _row_to_referral(row: Optional[Dict]) -> Optional[Dict]:
    if not row:
        return None

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    return _ensure_defaults(
        {
            "id": row.get("id"),
            "referrerDoctorId": row.get("referrer_doctor_id"),
            "salesRepId": row.get("sales_rep_id"),
            "referralCodeId": row.get("referral_code_id"),
            "referredContactName": row.get("referred_contact_name"),
            "referredContactEmail": row.get("referred_contact_email"),
            "referredContactPhone": row.get("referred_contact_phone"),
            "status": row.get("status"),
            "notes": row.get("notes"),
            "convertedDoctorId": row.get("converted_doctor_id"),
            "convertedAt": fmt_datetime(row.get("converted_at")),
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
    )


def _to_db_params(referral: Dict) -> Dict:
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
        "id": referral.get("id"),
        "referrer_doctor_id": referral.get("referrerDoctorId"),
        "sales_rep_id": referral.get("salesRepId"),
        "referral_code_id": referral.get("referralCodeId"),
        "referred_contact_name": referral.get("referredContactName"),
        "referred_contact_email": referral.get("referredContactEmail"),
        "referred_contact_phone": referral.get("referredContactPhone"),
        "status": referral.get("status"),
        "notes": referral.get("notes"),
        "converted_doctor_id": referral.get("convertedDoctorId"),
        "converted_at": parse_dt(referral.get("convertedAt")),
        "created_at": parse_dt(referral.get("createdAt")),
        "updated_at": parse_dt(referral.get("updatedAt")),
    }


def _generate_id() -> str:
    from time import time

    return str(int(time() * 1000))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
