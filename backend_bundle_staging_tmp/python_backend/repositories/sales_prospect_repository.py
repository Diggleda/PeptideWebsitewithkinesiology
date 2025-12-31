from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional
import uuid

from ..services import get_config
from ..database import mysql_client
from .. import storage


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _get_store():
    store = storage.sales_prospect_store
    if store is None:
        raise RuntimeError("sales_prospect_store is not initialised")
    return store


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_id() -> str:
    return uuid.uuid4().hex


def _ensure_defaults(record: Dict) -> Dict:
    normalized = dict(record)
    normalized.setdefault("id", normalized.get("id") or _generate_id())
    normalized.setdefault("salesRepId", normalized.get("salesRepId") or None)
    normalized.setdefault("doctorId", normalized.get("doctorId") or None)
    normalized.setdefault("referralId", normalized.get("referralId") or None)
    normalized.setdefault("contactFormId", normalized.get("contactFormId") or None)
    normalized.setdefault("status", normalized.get("status") or "pending")
    normalized.setdefault("notes", normalized.get("notes") or None)
    normalized.setdefault("isManual", bool(normalized.get("isManual")) if "isManual" in normalized else False)
    normalized.setdefault(
        "resellerPermitExempt",
        bool(normalized.get("resellerPermitExempt")) if "resellerPermitExempt" in normalized else False,
    )
    normalized.setdefault("resellerPermitFilePath", normalized.get("resellerPermitFilePath") or None)
    normalized.setdefault("resellerPermitFileName", normalized.get("resellerPermitFileName") or None)
    normalized.setdefault("resellerPermitUploadedAt", normalized.get("resellerPermitUploadedAt") or None)
    normalized.setdefault("contactName", normalized.get("contactName") or None)
    normalized.setdefault("contactEmail", normalized.get("contactEmail") or None)
    normalized.setdefault("contactPhone", normalized.get("contactPhone") or None)
    created_at = normalized.get("createdAt") or _now()
    normalized["createdAt"] = created_at
    normalized["updatedAt"] = normalized.get("updatedAt") or created_at
    return normalized


def get_all() -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM sales_prospects")
        return [_row_to_record(row) for row in rows]
    return [_ensure_defaults(item) for item in _get_store().read()]


def find_by_id(prospect_id: str) -> Optional[Dict]:
    if not prospect_id:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT * FROM sales_prospects WHERE id = %(id)s",
            {"id": str(prospect_id)},
        )
        return _row_to_record(row)
    return next((record for record in _get_store().read() if record.get("id") == prospect_id), None)


def find_by_sales_rep(sales_rep_id: str) -> List[Dict]:
    if not sales_rep_id:
        return []
    if _using_mysql():
        rows = mysql_client.fetch_all(
            "SELECT * FROM sales_prospects WHERE sales_rep_id = %(sales_rep_id)s",
            {"sales_rep_id": str(sales_rep_id)},
        )
        return [_row_to_record(row) for row in rows]
    return [
        _ensure_defaults(item)
        for item in _get_store().read()
        if str(item.get("salesRepId") or "") == str(sales_rep_id)
    ]


def find_by_sales_rep_and_doctor(sales_rep_id: str, doctor_id: str) -> Optional[Dict]:
    if not sales_rep_id or not doctor_id:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT * FROM sales_prospects
            WHERE sales_rep_id = %(sales_rep_id)s AND doctor_id = %(doctor_id)s
            """,
            {"sales_rep_id": str(sales_rep_id), "doctor_id": str(doctor_id)},
        )
        return _row_to_record(row)
    return next(
        (
            _ensure_defaults(item)
            for item in _get_store().read()
            if str(item.get("salesRepId") or "") == str(sales_rep_id)
            and str(item.get("doctorId") or "") == str(doctor_id)
        ),
        None,
    )


def find_by_sales_rep_and_referral(sales_rep_id: str, referral_id: str) -> Optional[Dict]:
    if not sales_rep_id or not referral_id:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT * FROM sales_prospects
            WHERE sales_rep_id = %(sales_rep_id)s AND referral_id = %(referral_id)s
            """,
            {"sales_rep_id": str(sales_rep_id), "referral_id": str(referral_id)},
        )
        return _row_to_record(row)
    return next(
        (
            _ensure_defaults(item)
            for item in _get_store().read()
            if str(item.get("salesRepId") or "") == str(sales_rep_id)
            and str(item.get("referralId") or "") == str(referral_id)
        ),
        None,
    )


def find_by_sales_rep_and_contact_form(sales_rep_id: str, contact_form_id: str) -> Optional[Dict]:
    if not sales_rep_id or not contact_form_id:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT * FROM sales_prospects
            WHERE sales_rep_id = %(sales_rep_id)s AND contact_form_id = %(contact_form_id)s
            """,
            {"sales_rep_id": str(sales_rep_id), "contact_form_id": str(contact_form_id)},
        )
        return _row_to_record(row)
    return next(
        (
            _ensure_defaults(item)
            for item in _get_store().read()
            if str(item.get("salesRepId") or "") == str(sales_rep_id)
            and str(item.get("contactFormId") or "") == str(contact_form_id)
        ),
        None,
    )


def find_all_by_referral_id(referral_id: str) -> List[Dict]:
    if not referral_id:
        return []
    if _using_mysql():
        rows = mysql_client.fetch_all(
            "SELECT * FROM sales_prospects WHERE referral_id = %(referral_id)s",
            {"referral_id": str(referral_id)},
        )
        return [_row_to_record(row) for row in rows]
    return [
        _ensure_defaults(item)
        for item in _get_store().read()
        if str(item.get("referralId") or "") == str(referral_id)
    ]


def delete(prospect_id: str) -> bool:
    if not prospect_id:
        return False
    if _using_mysql():
        result = mysql_client.execute(
            "DELETE FROM sales_prospects WHERE id = %(id)s",
            {"id": str(prospect_id)},
        )
        return result > 0
    records = list(_get_store().read())
    filtered = [record for record in records if record.get("id") != prospect_id]
    if len(filtered) == len(records):
        return False
    _get_store().write(filtered)
    return True


def upsert(record: Dict) -> Dict:
    incoming = dict(record or {})

    existing = None
    if incoming.get("id"):
        existing = find_by_id(incoming.get("id"))

    sales_rep_id = incoming.get("salesRepId") or (existing.get("salesRepId") if existing else None)
    incoming["salesRepId"] = sales_rep_id
    if not sales_rep_id:
        # Allow unassigned contact form prospects to exist before being claimed by a rep/admin.
        identifier = str(incoming.get("id") or "")
        if not (identifier.startswith("contact_form:") and incoming.get("contactFormId")):
            raise RuntimeError("salesRepId is required for sales prospects")

    if not existing and sales_rep_id and incoming.get("doctorId"):
        existing = find_by_sales_rep_and_doctor(sales_rep_id, incoming.get("doctorId"))
    if not existing and sales_rep_id and incoming.get("referralId"):
        existing = find_by_sales_rep_and_referral(sales_rep_id, incoming.get("referralId"))
    if not existing and sales_rep_id and incoming.get("contactFormId"):
        existing = find_by_sales_rep_and_contact_form(sales_rep_id, incoming.get("contactFormId"))

    merged = _ensure_defaults({**(existing or {}), **incoming, "updatedAt": _now()})

    if _using_mysql():
        params = _to_db_params(merged)
        if existing:
            mysql_client.execute(
                """
                UPDATE sales_prospects
                SET
                    sales_rep_id = %(sales_rep_id)s,
                    doctor_id = %(doctor_id)s,
                    referral_id = %(referral_id)s,
                    contact_form_id = %(contact_form_id)s,
                    status = %(status)s,
                    notes = %(notes)s,
                    is_manual = %(is_manual)s,
                    reseller_permit_exempt = %(reseller_permit_exempt)s,
                    reseller_permit_file_path = %(reseller_permit_file_path)s,
                    reseller_permit_file_name = %(reseller_permit_file_name)s,
                    reseller_permit_uploaded_at = %(reseller_permit_uploaded_at)s,
                    contact_name = %(contact_name)s,
                    contact_email = %(contact_email)s,
                    contact_phone = %(contact_phone)s,
                    updated_at = %(updated_at)s
                WHERE id = %(id)s
                """,
                params,
            )
            return find_by_id(merged.get("id")) or merged
        mysql_client.execute(
            """
            INSERT INTO sales_prospects (
                id, sales_rep_id, doctor_id, referral_id, contact_form_id,
                status, notes, is_manual,
                reseller_permit_exempt, reseller_permit_file_path, reseller_permit_file_name, reseller_permit_uploaded_at,
                contact_name, contact_email, contact_phone,
                created_at, updated_at
            ) VALUES (
                %(id)s, %(sales_rep_id)s, %(doctor_id)s, %(referral_id)s, %(contact_form_id)s,
                %(status)s, %(notes)s, %(is_manual)s,
                %(reseller_permit_exempt)s, %(reseller_permit_file_path)s, %(reseller_permit_file_name)s, %(reseller_permit_uploaded_at)s,
                %(contact_name)s, %(contact_email)s, %(contact_phone)s,
                %(created_at)s, %(updated_at)s
            )
            """,
            params,
        )
        return find_by_id(merged.get("id")) or merged

    records = [_ensure_defaults(item) for item in _get_store().read()]
    updated = False
    for idx, rec in enumerate(records):
        if rec.get("id") == merged.get("id"):
            records[idx] = merged
            updated = True
            break
    if not updated:
        records.append(merged)
    _get_store().write(records)
    return merged


def _row_to_record(row: Optional[Dict]) -> Optional[Dict]:
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
            "salesRepId": row.get("sales_rep_id"),
            "doctorId": row.get("doctor_id"),
            "referralId": row.get("referral_id"),
            "contactFormId": row.get("contact_form_id"),
            "status": row.get("status"),
            "notes": row.get("notes"),
            "isManual": bool(row.get("is_manual") or 0),
            "resellerPermitExempt": bool(row.get("reseller_permit_exempt") or 0),
            "resellerPermitFilePath": row.get("reseller_permit_file_path"),
            "resellerPermitFileName": row.get("reseller_permit_file_name"),
            "resellerPermitUploadedAt": fmt_datetime(row.get("reseller_permit_uploaded_at")),
            "contactName": row.get("contact_name"),
            "contactEmail": row.get("contact_email"),
            "contactPhone": row.get("contact_phone"),
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
    )


def _to_db_params(record: Dict) -> Dict:
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
        "doctor_id": record.get("doctorId"),
        "referral_id": record.get("referralId"),
        "contact_form_id": record.get("contactFormId"),
        "status": record.get("status"),
        "notes": record.get("notes"),
        "is_manual": 1 if record.get("isManual") else 0,
        "reseller_permit_exempt": 1 if record.get("resellerPermitExempt") else 0,
        "reseller_permit_file_path": record.get("resellerPermitFilePath"),
        "reseller_permit_file_name": record.get("resellerPermitFileName"),
        "reseller_permit_uploaded_at": parse_dt(record.get("resellerPermitUploadedAt")),
        "contact_name": record.get("contactName"),
        "contact_email": record.get("contactEmail"),
        "contact_phone": record.get("contactPhone"),
        "created_at": parse_dt(record.get("createdAt")),
        "updated_at": parse_dt(record.get("updatedAt")),
    }
