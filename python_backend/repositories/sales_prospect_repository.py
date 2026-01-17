from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional
import uuid

from ..services import get_config
from ..database import mysql_client
from .. import storage

HOUSE_SALES_REP_ID = "house"


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


def _is_contact_form_prospect(record: Dict) -> bool:
    identifier = str(record.get("id") or "")
    if identifier.startswith("contact_form:"):
        return True
    return bool(record.get("contactFormId"))


def _ensure_defaults(record: Dict) -> Dict:
    normalized = dict(record)
    normalized.setdefault("id", normalized.get("id") or _generate_id())
    normalized.setdefault("salesRepId", normalized.get("salesRepId") or None)
    normalized.setdefault("doctorId", normalized.get("doctorId") or None)
    normalized.setdefault("referralId", normalized.get("referralId") or None)
    normalized.setdefault("contactFormId", normalized.get("contactFormId") or None)
    if _is_contact_form_prospect(normalized) and not normalized.get("salesRepId"):
        normalized["salesRepId"] = HOUSE_SALES_REP_ID
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


def find_by_contact_email(email: str) -> Optional[Dict]:
    if not email:
        return None
    email_norm = str(email).strip().lower()
    if not email_norm:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT * FROM sales_prospects WHERE LOWER(contact_email) = %(email)s LIMIT 1",
            {"email": email_norm},
        )
        return _row_to_record(row)
    return next(
        (
            _ensure_defaults(item)
            for item in _get_store().read()
            if str(item.get("contactEmail") or "").strip().lower() == email_norm
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
    if not sales_rep_id and _is_contact_form_prospect(incoming):
        sales_rep_id = HOUSE_SALES_REP_ID
    incoming["salesRepId"] = sales_rep_id
    if not sales_rep_id:
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


def ensure_house_sales_rep_for_contact_forms() -> int:
    """
    Ensure every contact-form prospect has a sales rep assignment.

    The requested default is the special "house" rep.
    """
    if _using_mysql():
        return mysql_client.execute(
            """
            UPDATE sales_prospects
            SET sales_rep_id = %(house)s,
                updated_at = UTC_TIMESTAMP()
            WHERE contact_form_id IS NOT NULL
              AND (sales_rep_id IS NULL OR sales_rep_id = '')
            """,
            {"house": HOUSE_SALES_REP_ID},
        )

    records = [_ensure_defaults(item) for item in _get_store().read()]
    updated = 0
    next_records: List[Dict] = []
    for record in records:
        if not _is_contact_form_prospect(record):
            next_records.append(record)
            continue
        if str(record.get("salesRepId") or "").strip():
            next_records.append(record)
            continue
        next_records.append({**record, "salesRepId": HOUSE_SALES_REP_ID, "updatedAt": _now()})
        updated += 1

    if updated > 0:
        _get_store().write(next_records)
    return updated


def sync_contact_for_doctor(
    *,
    doctor_id: str,
    name: Optional[str],
    email: Optional[str],
    phone: Optional[str],
    previous_email: Optional[str] = None,
) -> int:
    """
    Keep sales_prospects contact fields aligned with the canonical users table.

    - Updates rows linked to doctor_id
    - Also "claims" rows by matching contact_email when doctor_id is missing (common for contact-form prospects)
    """
    normalized_doctor_id = str(doctor_id or "").strip()
    if not normalized_doctor_id:
        return 0

    next_email = (str(email or "").strip().lower() or None)
    prev_email = (str(previous_email or "").strip().lower() or None)
    next_name = (str(name or "").strip() or None)
    next_phone = (str(phone or "").strip() or None)

    email_candidates = {e for e in (next_email, prev_email) if e and "@" in e}

    if _using_mysql():
        # Update by doctor id (always), and also by email when the row has no doctor_id yet.
        updated = 0
        updated += int(
            mysql_client.execute(
                """
                UPDATE sales_prospects
                SET contact_name = %(contact_name)s,
                    contact_email = %(contact_email)s,
                    contact_phone = %(contact_phone)s,
                    updated_at = UTC_TIMESTAMP()
                WHERE doctor_id = %(doctor_id)s
                """,
                {
                    "doctor_id": normalized_doctor_id,
                    "contact_name": next_name,
                    "contact_email": next_email,
                    "contact_phone": next_phone,
                },
            )
            or 0
        )
        for candidate_email in email_candidates:
            updated += int(
                mysql_client.execute(
                    """
                    UPDATE sales_prospects
                    SET doctor_id = %(doctor_id)s,
                        contact_name = %(contact_name)s,
                        contact_email = %(contact_email)s,
                        contact_phone = %(contact_phone)s,
                        updated_at = UTC_TIMESTAMP()
                    WHERE (doctor_id IS NULL OR doctor_id = '')
                      AND LOWER(TRIM(contact_email)) = %(email)s
                    """,
                    {
                        "doctor_id": normalized_doctor_id,
                        "email": candidate_email,
                        "contact_name": next_name,
                        "contact_email": next_email or candidate_email,
                        "contact_phone": next_phone,
                    },
                )
                or 0
            )
        return updated

    records = [_ensure_defaults(item) for item in _get_store().read()]
    updated_count = 0
    next_records: List[Dict] = []
    for record in records:
        record_doctor_id = str(record.get("doctorId") or "").strip()
        record_email = str(record.get("contactEmail") or "").strip().lower()

        match_doctor = bool(record_doctor_id and record_doctor_id == normalized_doctor_id)
        match_email_unclaimed = bool((not record_doctor_id) and record_email and record_email in email_candidates)
        if not match_doctor and not match_email_unclaimed:
            next_records.append(record)
            continue

        merged = dict(record)
        merged["doctorId"] = normalized_doctor_id
        merged["contactName"] = next_name or merged.get("contactName") or None
        merged["contactEmail"] = (next_email or merged.get("contactEmail") or record_email or None)
        merged["contactPhone"] = next_phone or merged.get("contactPhone") or None
        merged["updatedAt"] = _now()
        next_records.append(_ensure_defaults(merged))
        updated_count += 1

    if updated_count > 0:
        _get_store().write(next_records)
    return updated_count


def mark_doctor_as_nurturing_if_purchased(doctor_id: str) -> int:
    """
    Promote sales prospects for a doctor to `nurturing` once they've placed an order.

    We only auto-promote early-stage statuses to avoid overwriting manual workflow states.
    """
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return 0

    eligible_statuses = ("pending", "contact_form", "contacted", "account_created")

    if _using_mysql():
        placeholders = ", ".join([f"%(s{idx})s" for idx in range(len(eligible_statuses))])
        params: Dict[str, str] = {"doctor_id": doctor_id}
        for idx, status in enumerate(eligible_statuses):
            params[f"s{idx}"] = status
        return mysql_client.execute(
            f"""
            UPDATE sales_prospects
            SET status = 'nurturing',
                updated_at = UTC_TIMESTAMP()
            WHERE doctor_id = %(doctor_id)s
              AND LOWER(status) IN ({placeholders})
            """,
            params,
        )

    records = [_ensure_defaults(item) for item in _get_store().read()]
    updated = 0
    next_records: List[Dict] = []
    for record in records:
        if str(record.get("doctorId") or "").strip() != doctor_id:
            next_records.append(record)
            continue
        status = str(record.get("status") or "").strip().lower()
        if status and status not in eligible_statuses:
            next_records.append(record)
            continue
        next_records.append({**record, "status": "nurturing", "updatedAt": _now()})
        updated += 1

    if updated > 0:
        _get_store().write(next_records)
    return updated


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
