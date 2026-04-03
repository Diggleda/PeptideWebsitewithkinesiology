from __future__ import annotations

from datetime import datetime, timezone
import json
import re
from typing import Dict, List, Optional
import uuid

from ..services import get_config
from ..database import mysql_client
from .. import storage
from ..utils.http import utc_now_iso as _now
from ._mysql_datetime import to_mysql_datetime

HOUSE_SALES_REP_ID = "house"
DELETED_USER_ID = "0000000000000"

_supports_office_address_columns: Optional[bool] = None


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _get_store():
    store = storage.sales_prospect_store
    if store is None:
        raise RuntimeError("sales_prospect_store is not initialised")
    return store


def _generate_id() -> str:
    return uuid.uuid4().hex


def _has_key(record: Optional[Dict], key: str) -> bool:
    return isinstance(record, dict) and key in record


def _parse_json_list(value: object) -> List[object]:
    if isinstance(value, list):
        return list(value)
    if isinstance(value, tuple):
        return list(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return []
        if isinstance(parsed, list):
            return parsed
    return []


def _normalize_email_list(value: object) -> List[str]:
    items = value if isinstance(value, (list, tuple)) else [value]
    normalized: List[str] = []
    for item in items:
        email = str(item or "").strip().lower()
        if email and email not in normalized:
            normalized.append(email)
    return normalized


def _normalize_phone_list(value: object) -> List[str]:
    items = value if isinstance(value, (list, tuple)) else [value]
    normalized: List[str] = []
    for item in items:
        phone = str(item or "").strip()
        if phone and phone not in normalized:
            normalized.append(phone)
    return normalized


def _normalize_contact_fields(record: Optional[Dict]) -> Dict:
    record = dict(record or {})
    raw_email_list_provided = _has_key(record, "contactEmails") or _has_key(record, "contact_emails_json")
    raw_phone_list_provided = _has_key(record, "contactPhones") or _has_key(record, "contact_phones_json")
    raw_email_list = (
        record.get("contactEmails")
        if _has_key(record, "contactEmails")
        else record.get("contact_emails_json")
    )
    raw_phone_list = (
        record.get("contactPhones")
        if _has_key(record, "contactPhones")
        else record.get("contact_phones_json")
    )
    raw_email = record.get("contactEmail") if _has_key(record, "contactEmail") else record.get("contact_email")
    raw_phone = record.get("contactPhone") if _has_key(record, "contactPhone") else record.get("contact_phone")
    contact_emails = (
        _normalize_email_list(_parse_json_list(raw_email_list))
        if raw_email_list_provided
        else _normalize_email_list(raw_email)
    )
    contact_phones = (
        _normalize_phone_list(_parse_json_list(raw_phone_list))
        if raw_phone_list_provided
        else _normalize_phone_list(raw_phone)
    )
    return {
        "contactEmails": contact_emails,
        "contactPhones": contact_phones,
        "contactEmail": contact_emails[0] if contact_emails else (None if raw_email_list_provided else (str(raw_email).strip() or None) if raw_email else None),
        "contactPhone": contact_phones[0] if contact_phones else (None if raw_phone_list_provided else (str(raw_phone).strip() or None) if raw_phone else None),
    }


def _resolve_contact_patch(existing: Optional[Dict], incoming: Optional[Dict]) -> Dict:
    base = _normalize_contact_fields(existing)
    payload = dict(incoming or {})
    incoming_has_email_list = _has_key(payload, "contactEmails") or _has_key(payload, "contact_emails_json")
    incoming_has_phone_list = _has_key(payload, "contactPhones") or _has_key(payload, "contact_phones_json")
    incoming_has_email = _has_key(payload, "contactEmail") or _has_key(payload, "contact_email")
    incoming_has_phone = _has_key(payload, "contactPhone") or _has_key(payload, "contact_phone")

    contact_emails = (
        _normalize_email_list(
            _parse_json_list(
                payload.get("contactEmails")
                if _has_key(payload, "contactEmails")
                else payload.get("contact_emails_json")
            )
        )
        if incoming_has_email_list
        else _normalize_email_list(payload.get("contactEmail") if _has_key(payload, "contactEmail") else payload.get("contact_email"))
        if incoming_has_email
        else base.get("contactEmails") or []
    )
    contact_phones = (
        _normalize_phone_list(
            _parse_json_list(
                payload.get("contactPhones")
                if _has_key(payload, "contactPhones")
                else payload.get("contact_phones_json")
            )
        )
        if incoming_has_phone_list
        else _normalize_phone_list(payload.get("contactPhone") if _has_key(payload, "contactPhone") else payload.get("contact_phone"))
        if incoming_has_phone
        else base.get("contactPhones") or []
    )
    return {
        "contactEmails": contact_emails,
        "contactPhones": contact_phones,
        "contactEmail": contact_emails[0] if contact_emails else None,
        "contactPhone": contact_phones[0] if contact_phones else None,
    }


def _normalize_phone_digits(value: object) -> str:
    if value is None:
        return ""
    return re.sub(r"[^0-9]", "", str(value))


def _record_has_email(record: Dict, email: str) -> bool:
    if not email:
        return False
    contacts = _normalize_contact_fields(record)
    return email in contacts.get("contactEmails", [])


def _record_has_phone(record: Dict, phone_digits: str) -> bool:
    if not phone_digits:
        return False
    contacts = _normalize_contact_fields(record)
    return any(_normalize_phone_digits(value) == phone_digits for value in contacts.get("contactPhones", []))


def _is_contact_form_prospect(record: Dict) -> bool:
    identifier = str(record.get("id") or "")
    if identifier.startswith("contact_form:"):
        return True
    return bool(record.get("contactFormId"))

def _sales_prospects_supports_office_address() -> bool:
    """
    Backwards-compatible feature detection for MySQL deployments.

    Some environments may not yet have office address columns on `sales_prospects`.
    """
    global _supports_office_address_columns
    if _supports_office_address_columns is not None:
        return _supports_office_address_columns
    if not _using_mysql():
        _supports_office_address_columns = False
        return False
    try:
        rows = mysql_client.fetch_all(
            "SHOW COLUMNS FROM sales_prospects LIKE 'office_address_line1'",
            {},
        )
        _supports_office_address_columns = bool(rows)
    except Exception:
        _supports_office_address_columns = False
    return _supports_office_address_columns


def _ensure_defaults(record: Dict) -> Dict:
    normalized = dict(record)
    contact_fields = _normalize_contact_fields(normalized)
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
    normalized["contactEmails"] = list(contact_fields.get("contactEmails") or [])
    normalized["contactPhones"] = list(contact_fields.get("contactPhones") or [])
    normalized["contactEmail"] = contact_fields.get("contactEmail")
    normalized["contactPhone"] = contact_fields.get("contactPhone")
    normalized.setdefault("officeAddressLine1", normalized.get("officeAddressLine1") or None)
    normalized.setdefault("officeAddressLine2", normalized.get("officeAddressLine2") or None)
    normalized.setdefault("officeCity", normalized.get("officeCity") or None)
    normalized.setdefault("officeState", normalized.get("officeState") or None)
    normalized.setdefault("officePostalCode", normalized.get("officePostalCode") or None)
    normalized.setdefault("officeCountry", normalized.get("officeCountry") or None)
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


def find_by_doctor_id(doctor_id: str) -> Optional[Dict]:
    if not doctor_id:
        return None
    normalized = str(doctor_id).strip()
    if not normalized:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT *
            FROM sales_prospects
            WHERE doctor_id = %(doctor_id)s
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            {"doctor_id": normalized},
        )
        return _row_to_record(row)
    for record in _get_store().read():
        if str(record.get("doctorId") or "").strip() == normalized:
            return _ensure_defaults(record)
    return None


def find_contact_form_by_doctor_id(doctor_id: str) -> Optional[Dict]:
    """
    Find a sales prospect record that indicates the doctor originated from a contact form.

    We treat any row with `contact_form_id` (or an id prefixed with `contact_form:`) as contact-form sourced.
    """
    normalized = str(doctor_id or "").strip()
    if not normalized:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT *
            FROM sales_prospects
            WHERE doctor_id = %(doctor_id)s
              AND (
                (contact_form_id IS NOT NULL AND contact_form_id <> '')
                OR id LIKE 'contact_form:%'
              )
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            {"doctor_id": normalized},
        )
        return _row_to_record(row)
    for record in _get_store().read():
        if str(record.get("doctorId") or "").strip() != normalized:
            continue
        ensured = _ensure_defaults(record)
        if _is_contact_form_prospect(ensured):
            return ensured
    return None


def find_by_contact_email(email: str) -> Optional[Dict]:
    if not email:
        return None
    email_norm = str(email).strip().lower()
    if not email_norm:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT *
            FROM sales_prospects
            WHERE JSON_SEARCH(contact_emails_json, 'one', %(email)s) IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            {"email": email_norm},
        )
        return _row_to_record(row)
    return next(
        (
            _ensure_defaults(item)
            for item in _get_store().read()
            if _record_has_email(item, email_norm)
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


def find_by_sales_rep_and_contact_email(sales_rep_id: str, contact_email: str) -> Optional[Dict]:
    if not sales_rep_id or not contact_email:
        return None
    email_norm = str(contact_email).strip().lower()
    if not email_norm:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT *
            FROM sales_prospects
            WHERE sales_rep_id = %(sales_rep_id)s
              AND JSON_SEARCH(contact_emails_json, 'one', %(email)s) IS NOT NULL
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            {"sales_rep_id": str(sales_rep_id), "email": email_norm},
        )
        return _row_to_record(row)
    matches = [
        _ensure_defaults(item)
        for item in _get_store().read()
        if str(item.get("salesRepId") or "") == str(sales_rep_id)
        and _record_has_email(item, email_norm)
    ]
    if not matches:
        return None
    matches.sort(
        key=lambda rec: str(rec.get("updatedAt") or rec.get("createdAt") or ""),
        reverse=True,
    )
    return matches[0]


def find_by_contact_phone(phone: str) -> Optional[Dict]:
    if not phone:
        return None
    phone_digits = _normalize_phone_digits(phone)
    if not phone_digits:
        return None
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT *
            FROM sales_prospects
            WHERE contact_phones_json IS NOT NULL
            """,
            {},
        )
        matches = []
        for row in rows:
            normalized = _row_to_record(row)
            if normalized and _record_has_phone(normalized, phone_digits):
                matches.append(normalized)
        matches.sort(
            key=lambda rec: str(rec.get("updatedAt") or rec.get("createdAt") or ""),
            reverse=True,
        )
        return matches[0] if matches else None
    matches = [
        _ensure_defaults(item)
        for item in _get_store().read()
        if _record_has_phone(item, phone_digits)
    ]
    if not matches:
        return None
    matches.sort(
        key=lambda rec: str(rec.get("updatedAt") or rec.get("createdAt") or ""),
        reverse=True,
    )
    return matches[0]


def find_all_by_referral_id(referral_id: str) -> List[Dict]:
    if not referral_id:
        return []
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT *
            FROM sales_prospects
            WHERE referral_id = %(referral_id)s
               OR id = %(referral_id)s
            """,
            {"referral_id": str(referral_id)},
        )
        return [_row_to_record(row) for row in rows]
    return [
        _ensure_defaults(item)
        for item in _get_store().read()
        if str(item.get("referralId") or "") == str(referral_id) or str(item.get("id") or "") == str(referral_id)
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


def delete_by_referral_id(referral_id: str) -> bool:
    if not referral_id:
        return False
    target = str(referral_id)
    if _using_mysql():
        result = mysql_client.execute(
            """
            DELETE FROM sales_prospects
            WHERE referral_id = %(referral_id)s OR id = %(referral_id)s
            """,
            {"referral_id": target},
        )
        return result > 0
    records = list(_get_store().read())
    filtered = [
        record
        for record in records
        if str(record.get("id") or "") != target and str(record.get("referralId") or "") != target
    ]
    if len(filtered) == len(records):
        return False
    _get_store().write(filtered)
    return True


def delete_by_contact_form_id(contact_form_id: str) -> bool:
    if not contact_form_id:
        return False
    target = str(contact_form_id).strip()
    if not target:
        return False
    canonical_id = f"contact_form:{target}"
    if _using_mysql():
        result = mysql_client.execute(
            """
            DELETE FROM sales_prospects
            WHERE contact_form_id = %(contact_form_id)s
               OR id = %(canonical_id)s
               OR id = %(contact_form_id)s
            """,
            {"contact_form_id": target, "canonical_id": canonical_id},
        )
        return result > 0
    records = list(_get_store().read())
    filtered = [
        record
        for record in records
        if str(record.get("contactFormId") or "").strip() != target
        and str(record.get("id") or "").strip() not in {target, canonical_id}
    ]
    if len(filtered) == len(records):
        return False
    _get_store().write(filtered)
    return True


def upsert(record: Dict) -> Dict:
    incoming = dict(record or {})

    existing = None
    if incoming.get("id"):
        existing = find_by_id(incoming.get("id"))

    contact_patch = _resolve_contact_patch(existing, incoming)
    for email in contact_patch.get("contactEmails", []):
        if existing:
            break
        existing = find_by_contact_email(email)
    for phone in contact_patch.get("contactPhones", []):
        if existing:
            break
        existing = find_by_contact_phone(phone)

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

    contact_patch = _resolve_contact_patch(existing, incoming)
    merged = _ensure_defaults({**(existing or {}), **incoming, **contact_patch, "updatedAt": _now()})

    if _using_mysql():
        params = _to_db_params(merged)
        supports_office_address = _sales_prospects_supports_office_address()
        if existing:
            if supports_office_address:
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
                        contact_emails_json = %(contact_emails_json)s,
                        contact_phones_json = %(contact_phones_json)s,
                        office_address_line1 = %(office_address_line1)s,
                        office_address_line2 = %(office_address_line2)s,
                        office_city = %(office_city)s,
                        office_state = %(office_state)s,
                        office_postal_code = %(office_postal_code)s,
                        office_country = %(office_country)s,
                        updated_at = %(updated_at)s
                    WHERE id = %(id)s
                    """,
                    params,
                )
                return find_by_id(merged.get("id")) or merged
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
                    contact_emails_json = %(contact_emails_json)s,
                    contact_phones_json = %(contact_phones_json)s,
                    updated_at = %(updated_at)s
                WHERE id = %(id)s
                """,
                params,
            )
            return find_by_id(merged.get("id")) or merged
        if supports_office_address:
            mysql_client.execute(
                """
                INSERT INTO sales_prospects (
                    id, sales_rep_id, doctor_id, referral_id, contact_form_id,
                    status, notes, is_manual,
                    reseller_permit_exempt, reseller_permit_file_path, reseller_permit_file_name, reseller_permit_uploaded_at,
                    contact_name,
                    contact_emails_json, contact_phones_json,
                    office_address_line1, office_address_line2, office_city, office_state, office_postal_code, office_country,
                    created_at, updated_at
                ) VALUES (
                    %(id)s, %(sales_rep_id)s, %(doctor_id)s, %(referral_id)s, %(contact_form_id)s,
                    %(status)s, %(notes)s, %(is_manual)s,
                    %(reseller_permit_exempt)s, %(reseller_permit_file_path)s, %(reseller_permit_file_name)s, %(reseller_permit_uploaded_at)s,
                    %(contact_name)s,
                    %(contact_emails_json)s, %(contact_phones_json)s,
                    %(office_address_line1)s, %(office_address_line2)s, %(office_city)s, %(office_state)s, %(office_postal_code)s, %(office_country)s,
                    %(created_at)s, %(updated_at)s
                )
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
                contact_name,
                contact_emails_json, contact_phones_json,
                created_at, updated_at
            ) VALUES (
                %(id)s, %(sales_rep_id)s, %(doctor_id)s, %(referral_id)s, %(contact_form_id)s,
                %(status)s, %(notes)s, %(is_manual)s,
                %(reseller_permit_exempt)s, %(reseller_permit_file_path)s, %(reseller_permit_file_name)s, %(reseller_permit_uploaded_at)s,
                %(contact_name)s,
                %(contact_emails_json)s, %(contact_phones_json)s,
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
    - Also "claims" rows by matching contact_emails_json when doctor_id is missing
    """
    normalized_doctor_id = str(doctor_id or "").strip()
    if not normalized_doctor_id:
        return 0

    next_email = (str(email or "").strip().lower() or None)
    prev_email = (str(previous_email or "").strip().lower() or None)
    next_name = (str(name or "").strip() or None)
    next_phone = (str(phone or "").strip() or None)

    email_candidates = {e for e in (next_email, prev_email) if e and "@" in e}
    next_contact_emails_json = json.dumps([next_email]) if next_email else None
    next_contact_phones_json = json.dumps([next_phone]) if next_phone else None

    if _using_mysql():
        # Update by doctor id (always), and also by email when the row has no doctor_id yet.
        updated = 0
        updated += int(
            mysql_client.execute(
                """
                UPDATE sales_prospects
                SET contact_name = %(contact_name)s,
                    contact_emails_json = %(contact_emails_json)s,
                    contact_phones_json = %(contact_phones_json)s,
                    updated_at = UTC_TIMESTAMP()
                WHERE doctor_id = %(doctor_id)s
                """,
                {
                    "doctor_id": normalized_doctor_id,
                    "contact_name": next_name,
                    "contact_emails_json": next_contact_emails_json,
                    "contact_phones_json": next_contact_phones_json,
                },
            )
            or 0
        )
        for candidate_email in email_candidates:
            updated += int(
                mysql_client.execute(
                    """
                    UPDATE sales_prospects
                    SET id = CASE
                            WHEN id LIKE 'doctor:%%' THEN CONCAT('doctor:', %(doctor_id)s)
                            ELSE id
                        END,
                        doctor_id = %(doctor_id)s,
                        contact_name = %(contact_name)s,
                        contact_emails_json = %(contact_emails_json)s,
                        contact_phones_json = %(contact_phones_json)s,
                        updated_at = UTC_TIMESTAMP()
                    WHERE (doctor_id IS NULL OR doctor_id = '' OR doctor_id = %(deleted_doctor_id)s)
                      AND JSON_SEARCH(contact_emails_json, 'one', %(email)s) IS NOT NULL
                    """,
                    {
                        "doctor_id": normalized_doctor_id,
                        "deleted_doctor_id": DELETED_USER_ID,
                        "email": candidate_email,
                        "contact_name": next_name,
                        "contact_emails_json": next_contact_emails_json or json.dumps([candidate_email]),
                        "contact_phones_json": next_contact_phones_json,
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
        match_email_deleted = bool(
            record_doctor_id == DELETED_USER_ID
            and record_email
            and record_email in email_candidates
        )
        if not match_doctor and not match_email_unclaimed and not match_email_deleted:
            next_records.append(record)
            continue

        merged = dict(record)
        if str(merged.get("id") or "").startswith("doctor:") and (match_email_unclaimed or match_email_deleted):
            merged["id"] = f"doctor:{normalized_doctor_id}"
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


def mark_doctor_as_nurturing_after_credit(doctor_id: str) -> int:
    """
    Promote sales prospects for a doctor to `nuture` after the referrer has been credited.

    This differs from `mark_doctor_as_nurturing_if_purchased` which intentionally does NOT
    move `converted` prospects automatically (reps/admins use Converted as a holding
    stage until credit is issued).
    """
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return 0

    eligible_statuses = ("pending", "contact_form", "contacted", "account_created", "converted")

    if _using_mysql():
        placeholders = ", ".join([f"%(s{idx})s" for idx in range(len(eligible_statuses))])
        params: Dict[str, str] = {"doctor_id": doctor_id}
        for idx, status in enumerate(eligible_statuses):
            params[f"s{idx}"] = status
        return mysql_client.execute(
            f"""
            UPDATE sales_prospects
            SET status = 'nuture',
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
        next_records.append({**record, "status": "nuture", "updatedAt": _now()})
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
            "contact_emails_json": row.get("contact_emails_json"),
            "contact_phones_json": row.get("contact_phones_json"),
            "officeAddressLine1": row.get("office_address_line1"),
            "officeAddressLine2": row.get("office_address_line2"),
            "officeCity": row.get("office_city"),
            "officeState": row.get("office_state"),
            "officePostalCode": row.get("office_postal_code"),
            "officeCountry": row.get("office_country"),
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
    )


def _to_db_params(record: Dict) -> Dict:
    def parse_dt(value):
        return to_mysql_datetime(value)

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
        "contact_emails_json": json.dumps(record.get("contactEmails")) if record.get("contactEmails") else None,
        "contact_phones_json": json.dumps(record.get("contactPhones")) if record.get("contactPhones") else None,
        "office_address_line1": record.get("officeAddressLine1"),
        "office_address_line2": record.get("officeAddressLine2"),
        "office_city": record.get("officeCity"),
        "office_state": record.get("officeState"),
        "office_postal_code": record.get("officePostalCode"),
        "office_country": record.get("officeCountry"),
        "created_at": parse_dt(record.get("createdAt")),
        "updated_at": parse_dt(record.get("updatedAt")),
    }
