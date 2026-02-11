from __future__ import annotations

import logging
import os
import re
import secrets
import threading
from datetime import datetime
from pathlib import Path
from time import time
from typing import Dict, List, Optional

from ..repositories import (
    contact_form_status_repository,
    credit_ledger_repository,
    order_repository,
    referral_code_repository,
    referral_repository,
    sales_prospect_repository,
    sales_rep_repository,
    user_repository,
)
from ..database import mysql_client
from ..integrations import woo_commerce
from . import get_config
logger = logging.getLogger(__name__)

_supports_sales_prospect_office_address_columns: Optional[bool] = None

ALLOWED_SUFFIX_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
REFERRAL_STATUS_CHOICES = [
    "pending",
    "contacted",
    "verified",
    "account_created",
    "nuture",
    "converted",
    "contact_form",
]

LEAD_TYPE_CHOICES = ("referral", "contact_form", "manual")

LEGACY_STATUS_ALIASES = {
    "follow_up": "nuture",
    "nurture": "nuture",
    "code_issued": "account_created",
    "account_created": "account_created",
    "closed": "pending",
    "not_interested": "pending",
    "disqualified": "pending",
    "rejected": "pending",
    "in_review": "account_created",
    "verifying": "verified",
}

_WOO_ORDER_PRESENCE_TTL_SECONDS = 60
_woo_order_presence_cache_lock = threading.Lock()
_woo_order_presence_cache: Dict[str, Dict[str, object]] = {}


def _has_woo_order_for_email(email: str) -> bool:
    normalized = _sanitize_email(email) or None
    if not normalized:
        return False
    if not woo_commerce.is_configured():
        return False

    now = time()
    with _woo_order_presence_cache_lock:
        cached = _woo_order_presence_cache.get(normalized)
        if cached and float(cached.get("expiresAt") or 0) > now:
            return bool(cached.get("hasOrder"))

    has_order = False
    try:
        orders = woo_commerce.fetch_orders_by_email(normalized, per_page=1)
        has_order = isinstance(orders, list) and len(orders) > 0
    except Exception:
        has_order = False

    with _woo_order_presence_cache_lock:
        _woo_order_presence_cache[normalized] = {
            "hasOrder": has_order,
            "expiresAt": now + _WOO_ORDER_PRESENCE_TTL_SECONDS,
        }
    return has_order


def _sanitize_text(value: Optional[str], max_length: int = 190) -> Optional[str]:
    if value is None:
        return None
    text = re.sub(r"[\r\n\t]+", " ", str(value)).strip()
    if not text:
        return None
    return text[:max_length]


def _sanitize_email(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    candidate = re.sub(r"\s+", "", str(value).lower())
    if re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", candidate or ""):
        return candidate
    return None


def _sanitize_phone(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    cleaned = re.sub(r"[^0-9+()\-\s]", "", str(value)).strip()
    return cleaned[:32] if cleaned else None

def _sanitize_address_field(value: Optional[str], max_length: int = 190) -> Optional[str]:
    return _sanitize_text(value, max_length=max_length)

def _sales_prospects_support_office_address_columns() -> bool:
    """
    Backwards-compatible feature detection for MySQL deployments.

    The sales_prospects table may not have address columns yet.
    """
    global _supports_sales_prospect_office_address_columns
    if _supports_sales_prospect_office_address_columns is not None:
        return _supports_sales_prospect_office_address_columns
    try:
        if not bool(get_config().mysql.get("enabled")):
            _supports_sales_prospect_office_address_columns = False
            return False
        rows = mysql_client.fetch_all(
            "SHOW COLUMNS FROM sales_prospects LIKE 'office_address_line1'",
            {},
        )
        _supports_sales_prospect_office_address_columns = bool(rows)
    except Exception:
        _supports_sales_prospect_office_address_columns = False
    return _supports_sales_prospect_office_address_columns


def _sanitize_notes(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    # Preserve newlines/indentation; only normalize line endings for portability.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\x00", "")
    if not text.strip():
        return None
    # Notes can contain serialized JSON (timestamped logs) and may grow over time.
    # Keep a reasonable upper bound to avoid truncating JSON mid-string.
    return text[:4000]


def _normalize_status_candidate(status: Optional[str]) -> Optional[str]:
    if status is None:
        return None
    normalized = (status or "").strip().lower()
    if not normalized:
        return None
    return LEGACY_STATUS_ALIASES.get(normalized, normalized)


def _sanitize_referral_status(status: Optional[str], fallback: str) -> str:
    candidate = _normalize_status_candidate(status)
    normalized_fallback = _normalize_status_candidate(fallback) or "pending"
    if candidate is None:
        return normalized_fallback
    if candidate in REFERRAL_STATUS_CHOICES:
        return candidate
    return normalized_fallback


def _normalize_initials(initials: str) -> str:
    letters = "".join(ch for ch in (initials or "") if ch.isalpha())
    return (letters[:2].upper() or "XX").ljust(2, "X")[:2]


def _random_suffix() -> str:
    suffix = []
    for byte in secrets.token_bytes(3):
        suffix.append(ALLOWED_SUFFIX_CHARS[byte % len(ALLOWED_SUFFIX_CHARS)])
    return "".join(suffix)


def _collect_existing_codes() -> set[str]:
    existing = set()
    for rep in sales_rep_repository.get_all():
        code = rep.get("salesCode")
        if code:
            existing.add(str(code).upper())
    return existing


def list_accounts_for_sales_rep(sales_rep_id: str, scope_all: bool = False) -> List[Dict]:
    """
    Return user/account records to help clients detect account creation for referrals.
    """
    all_users = user_repository.get_all()
    if scope_all:
        doctors = [u for u in all_users if (u.get("role") or "").lower() in ("doctor", "test_doctor")]
        updated_doctors = backfill_lead_types_for_doctors(doctors)
        doctor_by_id = {str(d.get("id")): d for d in updated_doctors if isinstance(d, dict) and d.get("id")}
        if doctor_by_id:
            all_users = [doctor_by_id.get(str(u.get("id")), u) for u in all_users]
        doctor_ids = [str(d.get("id")) for d in updated_doctors if isinstance(d, dict) and d.get("id")]
        try:
            counts = order_repository.count_by_user_ids(doctor_ids)
        except Exception:
            counts = {}
        with_counts = []
        for user in all_users:
            uid = str(user.get("id")) if user and user.get("id") is not None else None
            total_orders = int(counts.get(uid, 0)) if uid else 0
            with_counts.append({**user, "totalOrders": total_orders})
        return with_counts
    target = str(sales_rep_id)
    scoped = [
        user
        for user in all_users
        if str(user.get("salesRepId") or user.get("sales_rep_id")) == target
    ]
    doctors = [u for u in scoped if (u.get("role") or "").lower() in ("doctor", "test_doctor")]
    updated_doctors = backfill_lead_types_for_doctors(doctors)
    doctor_by_id = {str(d.get("id")): d for d in updated_doctors if isinstance(d, dict) and d.get("id")}
    if doctor_by_id:
        scoped = [doctor_by_id.get(str(u.get("id")), u) for u in scoped]
    doctor_ids = [str(d.get("id")) for d in updated_doctors if isinstance(d, dict) and d.get("id")]
    try:
        counts = order_repository.count_by_user_ids(doctor_ids)
    except Exception:
        counts = {}
    with_counts = []
    for user in scoped:
        uid = str(user.get("id")) if user and user.get("id") is not None else None
        total_orders = int(counts.get(uid, 0)) if uid else 0
        with_counts.append({**user, "totalOrders": total_orders})
    return with_counts


def _is_contact_form_id(referral_id: str) -> bool:
    return isinstance(referral_id, str) and referral_id.startswith("contact_form:")


def _normalize_lead_type(value: Optional[str]) -> Optional[str]:
    normalized = (value or "").strip().lower()
    return normalized if normalized in LEAD_TYPE_CHOICES else None

def _fetch_contact_form_ids_by_email(emails: List[str]) -> Dict[str, str]:
    """Return mapping of normalized email -> contact_form:<id> for the earliest submission."""
    normalized = sorted({(_sanitize_email(e) or "") for e in emails if e})
    normalized = [e for e in normalized if e]
    if not normalized:
        return {}
    try:
        placeholders = ", ".join([f"%(email_{idx})s" for idx in range(len(normalized))])
    except Exception:
        placeholders = ""
    params = {f"email_{idx}": email for idx, email in enumerate(normalized)}
    if not placeholders:
        return {}
    try:
        rows = mysql_client.fetch_all(
            f"""
            SELECT id, email, created_at
            FROM contact_forms
            WHERE LOWER(email) IN ({placeholders})
            ORDER BY created_at ASC
            """,
            params,
        )
    except Exception:
        return {}
    mapping: Dict[str, str] = {}
    for row in rows or []:
        email = _sanitize_email(row.get("email"))
        if not email or email in mapping:
            continue
        if row.get("id") is None:
            continue
        mapping[email] = f"contact_form:{row.get('id')}"
    return mapping


def _fetch_manual_prospect_ids_by_email(emails: List[str]) -> Dict[str, str]:
    """Return mapping of normalized email -> manual referral id (manual:...) if present."""
    normalized = {(_sanitize_email(e) or "") for e in emails if e}
    normalized = {e for e in normalized if e}
    if not normalized:
        return {}
    mapping: Dict[str, str] = {}
    try:
        # Prefer MySQL for efficiency.
        placeholders = ", ".join([f"%(email_{idx})s" for idx in range(len(normalized))])
        params = {f"email_{idx}": email for idx, email in enumerate(sorted(normalized))}
        rows = mysql_client.fetch_all(
            f"""
            SELECT id, referred_contact_email
            FROM referrals
            WHERE id LIKE 'manual:%'
              AND LOWER(referred_contact_email) IN ({placeholders})
            """,
            params,
        )
        for row in rows or []:
            email = _sanitize_email(row.get("referred_contact_email"))
            rid = row.get("id")
            if email and rid and email not in mapping:
                mapping[email] = str(rid)
        return mapping
    except Exception:
        # Fall back to repository scan (JSON-store mode or older schema).
        for record in referral_repository.get_all():
            rid = str(record.get("id") or "")
            if not rid.startswith("manual:"):
                continue
            email = _sanitize_email(record.get("referredContactEmail"))
            if email and email in normalized and email not in mapping:
                mapping[email] = rid
        return mapping


def lock_lead_type_for_doctor(
    doctor: Dict,
    *,
    lead_type: str,
    source: Optional[str] = None,
    locked_at: Optional[str] = None,
) -> Optional[Dict]:
    """Set lead type once (never overwrite)."""
    if not isinstance(doctor, dict) or not doctor.get("id"):
        return None
    existing = _normalize_lead_type(doctor.get("leadType"))
    if existing:
        return doctor
    normalized = _normalize_lead_type(lead_type)
    if not normalized:
        return doctor
    update = {
        **doctor,
        "leadType": normalized,
        "leadTypeSource": _sanitize_text(source, 64) if source else doctor.get("leadTypeSource") or None,
        "leadTypeLockedAt": locked_at or doctor.get("leadTypeLockedAt") or _now(),
    }
    return user_repository.update(update) or update


def backfill_lead_types_for_doctors(doctors: List[Dict]) -> List[Dict]:
    """Best-effort: ensure every doctor has a lead type set, without ever overwriting."""
    if not isinstance(doctors, list) or not doctors:
        return doctors or []

    pending: List[Dict] = []
    updated: Dict[str, Dict] = {}
    for doctor in doctors:
        if not isinstance(doctor, dict) or not doctor.get("id"):
            continue
        if _normalize_lead_type(doctor.get("leadType")):
            continue
        # Quick deterministic case.
        if doctor.get("referrerDoctorId"):
            saved = lock_lead_type_for_doctor(
                doctor,
                lead_type="referral",
                source=f"referrerDoctorId:{doctor.get('referrerDoctorId')}",
            )
            if saved:
                updated[str(doctor.get("id"))] = saved
            continue
        pending.append(doctor)

    if not pending:
        return [updated.get(str(d.get("id")), d) for d in doctors]

    emails = [d.get("email") for d in pending if d.get("email")]
    contact_form_map = _fetch_contact_form_ids_by_email(emails)
    manual_map = _fetch_manual_prospect_ids_by_email(emails)

    for doctor in pending:
        email = _sanitize_email(doctor.get("email"))
        if not email:
            saved = lock_lead_type_for_doctor(doctor, lead_type="manual", source="default")
            if saved:
                updated[str(doctor.get("id"))] = saved
            continue
        if email in contact_form_map:
            saved = lock_lead_type_for_doctor(
                doctor,
                lead_type="contact_form",
                source=contact_form_map[email],
            )
            if saved:
                updated[str(doctor.get("id"))] = saved
            continue
        if email in manual_map:
            saved = lock_lead_type_for_doctor(
                doctor,
                lead_type="manual",
                source=manual_map[email],
            )
            if saved:
                updated[str(doctor.get("id"))] = saved
            continue
        saved = lock_lead_type_for_doctor(doctor, lead_type="manual", source="default")
        if saved:
            updated[str(doctor.get("id"))] = saved

    return [updated.get(str(d.get("id")), d) for d in doctors]


def _enrich_referral(referral: Dict) -> Dict:
    enriched = dict(referral)
    doctor = user_repository.find_by_id(referral.get("referrerDoctorId")) if referral.get("referrerDoctorId") else None
    if doctor:
        enriched["referrerDoctorName"] = doctor.get("name")
        enriched["referrerDoctorEmail"] = doctor.get("email")
        enriched["referrerDoctorPhone"] = doctor.get("phone")
    else:
        enriched["referrerDoctorName"] = None
        enriched["referrerDoctorEmail"] = None
        enriched["referrerDoctorPhone"] = None
    enriched["notes"] = referral.get("notes") or None
    sales_rep_id = referral.get("salesRepId") or referral.get("sales_rep_id")
    prospect = None
    if sales_rep_id and referral.get("id"):
        prospect = sales_prospect_repository.find_by_sales_rep_and_referral(
            str(sales_rep_id),
            str(referral.get("id")),
        )
    enriched["salesRepNotes"] = (prospect.get("notes") if prospect else None) or None
    enriched["isManual"] = bool(prospect.get("isManual")) if prospect else False
    enriched["status"] = prospect.get("status") if prospect and prospect.get("status") else "pending"
    enriched["resellerPermitExempt"] = bool(prospect.get("resellerPermitExempt")) if prospect else False
    enriched["resellerPermitFilePath"] = prospect.get("resellerPermitFilePath") if prospect else None
    enriched["resellerPermitFileName"] = prospect.get("resellerPermitFileName") if prospect else None
    enriched["resellerPermitUploadedAt"] = prospect.get("resellerPermitUploadedAt") if prospect else None
    enriched["officeAddressLine1"] = prospect.get("officeAddressLine1") if prospect else None
    enriched["officeAddressLine2"] = prospect.get("officeAddressLine2") if prospect else None
    enriched["officeCity"] = prospect.get("officeCity") if prospect else None
    enriched["officeState"] = prospect.get("officeState") if prospect else None
    enriched["officePostalCode"] = prospect.get("officePostalCode") if prospect else None
    enriched["officeCountry"] = prospect.get("officeCountry") if prospect else None

    contact_account, contact_order_count = _resolve_referred_contact_account(referral)
    enriched["referredContactHasAccount"] = bool(contact_account)
    enriched["referredContactAccountId"] = contact_account.get("id") if contact_account else None
    enriched["referredContactAccountName"] = contact_account.get("name") if contact_account else None
    enriched["referredContactAccountEmail"] = contact_account.get("email") if contact_account else None
    enriched["referredContactAccountCreatedAt"] = (
        contact_account.get("createdAt") or contact_account.get("created_at")
        if contact_account
        else None
    )
    enriched["referredContactTotalOrders"] = contact_order_count
    enriched["referredContactEligibleForCredit"] = contact_order_count > 0
    # Address priority: prefer the users table address when the referred contact has an account
    # and that account has address data.
    if contact_account:
        user_line1 = (contact_account.get("officeAddressLine1") or contact_account.get("office_address_line1") or "").strip()
        user_line2 = (contact_account.get("officeAddressLine2") or contact_account.get("office_address_line2") or "").strip()
        user_city = (contact_account.get("officeCity") or contact_account.get("office_city") or "").strip()
        user_state = (contact_account.get("officeState") or contact_account.get("office_state") or "").strip()
        user_postal = (contact_account.get("officePostalCode") or contact_account.get("office_postal_code") or "").strip()
        user_country = (contact_account.get("officeCountry") or contact_account.get("office_country") or "").strip()
        if any([user_line1, user_line2, user_city, user_state, user_postal, user_country]):
            enriched["officeAddressLine1"] = user_line1 or None
            enriched["officeAddressLine2"] = user_line2 or None
            enriched["officeCity"] = user_city or None
            enriched["officeState"] = user_state or None
            enriched["officePostalCode"] = user_postal or None
            enriched["officeCountry"] = user_country or None
    # Promote prospect status to account_created when an account exists but status is still early-stage.
    status = (enriched.get("status") or "").lower()
    if enriched["referredContactHasAccount"] and status in ("pending", "contact_form", "contacted"):
        enriched["status"] = "account_created"
        if prospect and sales_rep_id:
            try:
                sales_prospect_repository.upsert(
                    {
                        "id": str(prospect.get("id")),
                        "salesRepId": str(sales_rep_id),
                        "doctorId": str(contact_account.get("id")),
                        "status": "account_created",
                    }
                )
            except Exception:
                pass
    elif prospect and sales_rep_id and contact_account and contact_account.get("id") and not prospect.get("doctorId"):
        try:
            sales_prospect_repository.upsert(
                {
                    "id": str(prospect.get("id")),
                    "salesRepId": str(sales_rep_id),
                    "doctorId": str(contact_account.get("id")),
                }
            )
        except Exception:
            pass

    # Promote prospect status to nurturing once the referred contact has placed an order.
    # This is derived from the `orders` table (PepPro checkout), not Woo.
    if contact_account and contact_account.get("id") and contact_order_count > 0:
        current = (enriched.get("status") or "").lower()
        if current in ("pending", "contact_form", "contacted", "account_created"):
            enriched["status"] = "nurturing"
            if prospect and sales_rep_id:
                try:
                    sales_prospect_repository.upsert(
                        {
                            "id": str(prospect.get("id")),
                            "salesRepId": str(sales_rep_id),
                            "doctorId": str(contact_account.get("id")),
                            "status": "nurturing",
                        }
                    )
                except Exception:
                    pass
            try:
                sales_prospect_repository.mark_doctor_as_nurturing_if_purchased(str(contact_account.get("id")))
            except Exception:
                pass

    return enriched


def _resolve_referred_contact_account(referral: Dict):
    email = _sanitize_email(
        referral.get("referredContactEmail")
        or referral.get("referred_contact_email")
        or referral.get("referredContactAccountEmail")
        or referral.get("referred_contact_account_email")
        or referral.get("contactEmail")
        or referral.get("contact_email")
        or referral.get("email")
    )
    contact_account = user_repository.find_by_email(email) if email else None
    order_count = 0
    if contact_account and contact_account.get("id"):
        try:
            order_count = count_orders_for_doctor(contact_account.get("id"))
        except Exception:
            order_count = 0
    return contact_account, order_count


def _apply_referred_contact_account_fields(record: Dict) -> Dict:
    contact_account, contact_order_count = _resolve_referred_contact_account(record)
    record["referredContactHasAccount"] = bool(contact_account)
    record["referredContactAccountId"] = contact_account.get("id") if contact_account else None
    record["referredContactAccountName"] = contact_account.get("name") if contact_account else None
    record["referredContactAccountEmail"] = contact_account.get("email") if contact_account else None
    record["referredContactAccountCreatedAt"] = (
        (contact_account.get("createdAt") or contact_account.get("created_at")) if contact_account else None
    )
    record["referredContactTotalOrders"] = contact_order_count
    record["referredContactEligibleForCredit"] = contact_order_count > 0
    # Address priority: if the referred contact has an account and *that* account already
    # has address data, prefer it over any sales_prospects stored address.
    if contact_account:
        user_line1 = (contact_account.get("officeAddressLine1") or contact_account.get("office_address_line1") or "").strip()
        user_line2 = (contact_account.get("officeAddressLine2") or contact_account.get("office_address_line2") or "").strip()
        user_city = (contact_account.get("officeCity") or contact_account.get("office_city") or "").strip()
        user_state = (contact_account.get("officeState") or contact_account.get("office_state") or "").strip()
        user_postal = (contact_account.get("officePostalCode") or contact_account.get("office_postal_code") or "").strip()
        user_country = (contact_account.get("officeCountry") or contact_account.get("office_country") or "").strip()
        if any([user_line1, user_line2, user_city, user_state, user_postal, user_country]):
            record["officeAddressLine1"] = user_line1 or None
            record["officeAddressLine2"] = user_line2 or None
            record["officeCity"] = user_city or None
            record["officeState"] = user_state or None
            record["officePostalCode"] = user_postal or None
            record["officeCountry"] = user_country or None
    return record


def _ensure_sales_rep(sales_rep_id: Optional[str]) -> Dict:
    if not sales_rep_id:
        raise _service_error("SALES_REP_REQUIRED", 400)
    rep = sales_rep_repository.find_by_id(sales_rep_id)
    if rep:
        return rep

    user = user_repository.find_by_id(sales_rep_id)
    if user and user.get("role") == "sales_rep":
        return sales_rep_repository.insert(
            {
                "id": sales_rep_id,
                "name": user.get("name"),
                "email": user.get("email"),
                "phone": user.get("phone"),
            }
        )
    raise _service_error("SALES_REP_NOT_FOUND", 404)


def _generate_unique_code(sales_rep_id: str) -> str:
    rep = _ensure_sales_rep(sales_rep_id)
    initials = _normalize_initials(rep.get("initials") or rep.get("name"))
    existing = _collect_existing_codes()
    for _ in range(200):
        candidate = f"{initials}{_random_suffix()}"
        if candidate not in existing:
            return candidate
    raise _service_error("UNABLE_TO_GENERATE_CODE", 500)


def create_onboarding_code(data: Dict) -> Dict:
    sales_rep_id = data.get("salesRepId")
    rep = _ensure_sales_rep(sales_rep_id)
    existing = (rep.get("salesCode") or "").strip().upper()
    if existing:
        return referral_code_repository.find_by_code(existing) or {"code": existing, "salesRepId": rep.get("id")}

    code = _generate_unique_code(sales_rep_id)
    sales_rep_repository.update({"id": rep.get("id"), "salesCode": code})
    return referral_code_repository.find_by_code(code) or {"code": code, "salesRepId": rep.get("id")}


def regenerate_sales_rep_code(sales_rep_id: str, created_by: str = "system") -> Dict:
    rep = _ensure_sales_rep(sales_rep_id)
    code = _generate_unique_code(sales_rep_id)
    sales_rep_repository.update({"id": rep.get("id"), "salesCode": code})
    record = referral_code_repository.find_by_code(code) or {"code": code, "salesRepId": rep.get("id")}
    history = record.get("history", []) if isinstance(record, dict) else []
    if isinstance(record, dict):
        record["history"] = [
            *history,
            {"action": "rotated", "at": _now(), "by": created_by},
        ]
    return record


def redeem_onboarding_code(payload: Dict) -> Dict:
    code = (payload.get("code") or "").strip().upper()
    record = referral_code_repository.find_by_code(code)
    if not record:
        raise _service_error("REFERRAL_CODE_UNKNOWN", 404)
    return record


def get_onboarding_code(code: str) -> Optional[Dict]:
    return referral_code_repository.find_by_code(code)


def record_referral_submission(data: Dict) -> Dict:
    timestamp = _now()
    referral = referral_repository.insert(
        {
            "referrerDoctorId": data.get("referrerDoctorId"),
            "salesRepId": data.get("salesRepId"),
            "referredContactName": data.get("contactName"),
            "referredContactEmail": data.get("contactEmail"),
            "referredContactPhone": data.get("contactPhone"),
            "notes": data.get("notes"),
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }
    )
    # Status lives in sales_prospects; create a prospect row for this referral.
    try:
        sales_rep_id = data.get("salesRepId") or referral.get("salesRepId")
        if sales_rep_id and referral and referral.get("id"):
            sales_prospect_repository.upsert(
                {
                    "id": str(referral.get("id")),
                    "salesRepId": str(sales_rep_id),
                    "referralId": str(referral.get("id")),
                    "status": "pending",
                    "isManual": False,
                    "contactName": referral.get("referredContactName"),
                    "contactEmail": referral.get("referredContactEmail"),
                    "contactPhone": referral.get("referredContactPhone"),
                }
            )
    except Exception:
        pass
    return referral


def create_manual_prospect(data: Dict) -> Dict:
    sales_rep_id = (data.get("salesRepId") or "").strip()
    if not sales_rep_id:
        raise _service_error("SALES_REP_REQUIRED", 400)

    resolved_sales_rep_id = (
        _resolve_sales_rep_id(sales_rep_id)
        or _resolve_sales_rep_id(_resolve_user_id(sales_rep_id))
        or sales_rep_id
    )

    contact_name = _sanitize_text(data.get("name"))
    if not contact_name:
        raise _service_error("CONTACT_NAME_REQUIRED", 400)

    contact_email = _sanitize_email(data.get("email"))
    contact_phone = _sanitize_phone(data.get("phone"))
    notes = _sanitize_notes(data.get("notes"))
    status = _sanitize_referral_status(data.get("status"), "pending")
    has_account = bool(data.get("hasAccount")) if "hasAccount" in data else False
    office_address_line1 = _sanitize_address_field(data.get("officeAddressLine1"))
    office_address_line2 = _sanitize_address_field(data.get("officeAddressLine2"))
    office_city = _sanitize_address_field(data.get("officeCity"))
    office_state = _sanitize_address_field(data.get("officeState"))
    office_postal_code = _sanitize_address_field(data.get("officePostalCode"))
    office_country = _sanitize_address_field(data.get("officeCountry"))

    if contact_email:
        if user_repository.find_by_email(contact_email):
            raise _service_error("EMAIL_ALREADY_EXISTS", 400)
        if sales_rep_repository.find_by_email(contact_email):
            raise _service_error("EMAIL_ALREADY_EXISTS", 400)
        try:
            for referral in referral_repository.get_all():
                if (referral.get("referredContactEmail") or "").strip().lower() == contact_email:
                    raise _service_error("EMAIL_ALREADY_EXISTS", 400)
        except Exception:
            pass
        try:
            for prospect in sales_prospect_repository.get_all():
                if (prospect.get("contactEmail") or "").strip().lower() == contact_email:
                    raise _service_error("EMAIL_ALREADY_EXISTS", 400)
        except Exception:
            pass
        try:
            if get_config().mysql.get("enabled"):
                row = mysql_client.fetch_one(
                    "SELECT id FROM contact_forms WHERE LOWER(email) = %(email)s LIMIT 1",
                    {"email": contact_email},
                )
                if row:
                    raise _service_error("EMAIL_ALREADY_EXISTS", 400)
        except Exception:
            pass

    prospect_id = _generate_manual_id()
    record = sales_prospect_repository.upsert(
        {
            "id": prospect_id,
            "salesRepId": resolved_sales_rep_id,
            "doctorId": None,
            "referralId": None,
            "contactFormId": None,
            "status": status,
            "notes": notes,
            "isManual": True,
            "contactName": contact_name,
            "contactEmail": contact_email,
            "contactPhone": contact_phone,
            "officeAddressLine1": office_address_line1,
            "officeAddressLine2": office_address_line2,
            "officeCity": office_city,
            "officeState": office_state,
            "officePostalCode": office_postal_code,
            "officeCountry": office_country,
        }
    )
    return {
        "id": record.get("id"),
        "referrerDoctorId": None,
        "salesRepId": record.get("salesRepId"),
        "referredContactName": record.get("contactName"),
        "referredContactEmail": record.get("contactEmail"),
        "referredContactPhone": record.get("contactPhone"),
        "status": record.get("status") or "pending",
        "salesRepNotes": record.get("notes") or None,
        "notes": record.get("notes") or None,
        "createdAt": record.get("createdAt"),
        "updatedAt": record.get("updatedAt"),
        "convertedDoctorId": None,
        "convertedAt": None,
        "referredContactHasAccount": bool(has_account),
        "referredContactAccountId": None,
        "referredContactAccountName": None,
        "referredContactAccountEmail": None,
        "referredContactAccountCreatedAt": None,
        "referredContactTotalOrders": 0,
        "referredContactEligibleForCredit": False,
        "isManual": True,
    }


def delete_manual_prospect(referral_id: str, sales_rep_id: str) -> None:
    if not referral_id:
        raise _service_error("REFERRAL_NOT_FOUND", 404)
    if not str(referral_id or "").startswith("manual:"):
        raise _service_error("NOT_MANUAL_PROSPECT", 400)
    resolved_sales_rep_id = (
        _resolve_sales_rep_id(sales_rep_id)
        or _resolve_sales_rep_id(_resolve_user_id(sales_rep_id))
        or _resolve_user_id(sales_rep_id)
        or sales_rep_id
    )
    prospect = sales_prospect_repository.find_by_id(referral_id)
    if not prospect:
        raise _service_error("REFERRAL_NOT_FOUND", 404)
    record_sales_rep_id = prospect.get("salesRepId")
    normalized_record = (
        _resolve_sales_rep_id(record_sales_rep_id)
        or _resolve_sales_rep_id(_resolve_user_id(record_sales_rep_id))
        or _resolve_user_id(record_sales_rep_id)
        or record_sales_rep_id
    )
    if str(record_sales_rep_id or "").strip() != str(resolved_sales_rep_id or "").strip() and str(normalized_record or "").strip() != str(resolved_sales_rep_id or "").strip():
        raise _service_error("REFERRAL_NOT_FOUND", 404)
    if not prospect.get("isManual"):
        raise _service_error("NOT_MANUAL_PROSPECT", 400)
    sales_prospect_repository.delete(referral_id)

def _resolve_sales_rep_id(identifier: Optional[str]) -> Optional[str]:
    """
    Resolve an identifier to a canonical `sales_reps.id` when possible.

    - Accepts sales_reps.id directly.
    - Maps legacy ids via `sales_reps.legacyUserId`.
    - Maps sales-rep users via `users.salesRepId` or email lookup.
    """
    if not identifier:
        return None
    candidate = str(identifier or "").strip()
    if not candidate:
        return None

    try:
        rep = sales_rep_repository.find_by_id(candidate)
    except Exception:
        rep = None
    if rep and rep.get("id") is not None:
        rid = str(rep.get("id") or "").strip()
        return rid or None

    try:
        reps = sales_rep_repository.get_all() or []
    except Exception:
        reps = []
    for record in reps:
        if not isinstance(record, dict):
            continue
        legacy = str(record.get("legacyUserId") or record.get("legacy_user_id") or "").strip()
        if legacy and legacy == candidate:
            rid = str(record.get("id") or "").strip()
            return rid or None

    try:
        user = user_repository.find_by_id(candidate)
    except Exception:
        user = None
    if user and isinstance(user, dict):
        role = (user.get("role") or "").lower()
        if role in ("sales_rep", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
            rep_id = str(user.get("salesRepId") or "").strip()
            if rep_id:
                return rep_id
        email = _sanitize_email(user.get("email"))
        if email:
            try:
                rep = sales_rep_repository.find_by_email(email)
            except Exception:
                rep = None
            if rep and rep.get("id") is not None:
                rid = str(rep.get("id") or "").strip()
                return rid or None

    if "@" in candidate:
        email = _sanitize_email(candidate)
        if email:
            try:
                rep = sales_rep_repository.find_by_email(email)
            except Exception:
                rep = None
            if rep and rep.get("id") is not None:
                rid = str(rep.get("id") or "").strip()
                return rid or None

    return None


def _resolve_user_id(identifier: Optional[str]) -> Optional[str]:
    """Resolve a caller-supplied identifier to a canonical user id.

    Identifiers may arrive as database ids, legacy JSON ids, or even emails
    (when older clients still send the email address). We always consult the
    primary user store so downstream calls rely on the authoritative user id
    when fetching referral records.
    """

    if not identifier:
        return None

    user = user_repository.find_by_id(identifier)
    if user:
        if (user.get("role") or "").lower() == "sales_rep" and user.get("salesRepId"):
            return user.get("salesRepId")
        return user.get("id")

    rep = sales_rep_repository.find_by_id(identifier)
    if rep:
        return rep.get("id")

    # Some clients still hand us an email address. Fall back to resolving
    # through the user table to obtain the correct id.
    if "@" in identifier:
        user = user_repository.find_by_email(identifier)
        if user:
            return user.get("id")
        rep = sales_rep_repository.find_by_email(identifier)
        if rep:
            return rep.get("id")

    return None


def list_referrals_for_doctor(doctor_identifier: str):
    doctor_id = _resolve_user_id(doctor_identifier)
    if not doctor_id:
        return []
    referrals = referral_repository.find_by_referrer(doctor_id)
    if not isinstance(referrals, list):
        return []

    def _pick_status(prospects: list[dict]) -> tuple[str, str | None]:
        if not prospects:
            return "pending", None
        # Prefer the most recently updated prospect; fall back to record order.
        def ts(p: dict) -> float:
            raw = p.get("updatedAt") or p.get("createdAt") or ""
            return _normalize_timestamp(raw)

        best = max(prospects, key=ts)
        status = str(best.get("status") or "pending").strip().lower() or "pending"
        updated_at = best.get("updatedAt") or best.get("createdAt") or None
        return status, str(updated_at) if updated_at else None

    enriched: list[dict] = []
    for ref in referrals:
        if not isinstance(ref, dict) or not ref.get("id"):
            continue
        prospects = sales_prospect_repository.find_all_by_referral_id(str(ref.get("id")))
        prospects = [p for p in prospects if isinstance(p, dict)]
        status, updated_at = _pick_status(prospects)
        # Doctor "Your Referrals" should reflect sales_prospects status, not the legacy referrals table.
        enriched.append({**ref, "status": status, "prospectUpdatedAt": updated_at})

    return enriched


def _resolve_sales_rep_aliases(identifiers: List[str]) -> set[str]:
    aliases: set[str] = set()

    for candidate in identifiers:
        if not candidate:
            continue
        try:
            aliases.update(referral_repository._collect_sales_rep_aliases(candidate))  # type: ignore[attr-defined]
        except AttributeError:
            # Fallback for environments where the helper is unavailable.
            normalized = referral_repository._normalize_identifier(candidate) if hasattr(referral_repository, "_normalize_identifier") else None  # type: ignore[attr-defined]
            if normalized:
                aliases.add(normalized)

    if not aliases:
        for candidate in identifiers:
            if not candidate:
                continue
            if hasattr(referral_repository, "_normalize_identifier"):
                normalized = referral_repository._normalize_identifier(candidate)  # type: ignore[attr-defined]
            else:
                normalized = str(candidate).strip() or None
            if normalized:
                aliases.add(normalized)

    return aliases


def _referral_matches_aliases(referral: Dict, aliases: set[str]) -> bool:
    if not aliases:
        return False

    def matches(value) -> bool:
        if not value:
            return False
        if hasattr(referral_repository, "_normalize_identifier"):
            normalized = referral_repository._normalize_identifier(value)  # type: ignore[attr-defined]
        else:
            normalized = str(value).strip().lower() if "@" in str(value) else str(value).strip()
        return bool(normalized) and normalized in aliases

    if matches(referral.get("salesRepId")):
        return True

    doctor_id = referral.get("referrerDoctorId")
    if doctor_id:
        doctor = user_repository.find_by_id(doctor_id)
        if doctor:
            if matches(doctor.get("salesRepId")) or matches(doctor.get("email")) or matches(doctor.get("id")):
                return True

    code_id = referral.get("referralCodeId")
    if code_id:
        code = referral_code_repository.find_by_id(code_id)
        if code and matches(code.get("salesRepId")):
            return True

    return False


def _load_contact_form_referrals(sales_rep_id: Optional[str] = None) -> list[dict]:
    """Load contact form submissions and map them into prospect records."""
    records: list[dict] = []
    mysql_enabled = bool(get_config().mysql.get("enabled"))

    try:
        include_office_address = _sales_prospects_support_office_address_columns()
        address_select = ""
        if include_office_address:
            address_select = """
                    ,sp.office_address_line1 AS office_address_line1
                    ,sp.office_address_line2 AS office_address_line2
                    ,sp.office_city AS office_city
                    ,sp.office_state AS office_state
                    ,sp.office_postal_code AS office_postal_code
                    ,sp.office_country AS office_country
            """
        if mysql_enabled and sales_rep_id:
            rows = mysql_client.fetch_all(
                f"""
                SELECT
                    cf.id,
                    cf.name,
                    cf.email,
                    cf.phone,
                    cf.source,
                    cf.created_at,
                    sp.doctor_id AS prospect_doctor_id,
                    sp.status AS prospect_status,
                    sp.notes AS prospect_notes,
                    sp.updated_at AS prospect_updated_at,
                    sp.reseller_permit_exempt AS reseller_permit_exempt,
                    sp.reseller_permit_file_path AS reseller_permit_file_path,
                    sp.reseller_permit_file_name AS reseller_permit_file_name,
                    sp.reseller_permit_uploaded_at AS reseller_permit_uploaded_at
                    {address_select}
                FROM sales_prospects sp
                JOIN contact_forms cf ON cf.id = sp.contact_form_id
                WHERE sp.sales_rep_id = %(sales_rep_id)s
                  AND sp.contact_form_id IS NOT NULL
                ORDER BY COALESCE(sp.updated_at, cf.created_at) DESC
                LIMIT 200
                """,
                {"sales_rep_id": str(sales_rep_id)},
            )
        elif mysql_enabled:
            rows = mysql_client.fetch_all(
                f"""
                SELECT
                    cf.id,
                    cf.name,
                    cf.email,
                    cf.phone,
                    cf.source,
                    cf.created_at,
                    sp.sales_rep_id AS prospect_sales_rep_id,
                    sp.doctor_id AS prospect_doctor_id,
                    sp.status AS prospect_status,
                    sp.notes AS prospect_notes,
                    sp.updated_at AS prospect_updated_at,
                    sp.reseller_permit_exempt AS reseller_permit_exempt,
                    sp.reseller_permit_file_path AS reseller_permit_file_path,
                    sp.reseller_permit_file_name AS reseller_permit_file_name,
                    sp.reseller_permit_uploaded_at AS reseller_permit_uploaded_at
                    {address_select}
                FROM contact_forms cf
                LEFT JOIN sales_prospects sp
                  ON sp.id = CONCAT('contact_form:', cf.id)
                  OR sp.contact_form_id = CAST(cf.id AS CHAR)
                ORDER BY COALESCE(sp.updated_at, cf.created_at) DESC
                LIMIT 200
                """,
            )
        else:
            rows = []
        logger.info(
            "[referrals] loaded contact forms",
            extra={
                "count": len(rows or []),
                "mysql_enabled": mysql_enabled,
                "sales_rep_id": sales_rep_id,
            },
        )
    except Exception as exc:
        logger.warning(
            "[referrals] contact form load failed",
            exc_info=exc,
            extra={
                "mysql_enabled": mysql_enabled,
                "sales_rep_id": sales_rep_id,
            },
        )
        rows = []

    for row in rows or []:
        created_at_raw = row.get("created_at") or row.get("createdAt")
        created_at = created_at_raw.isoformat() if isinstance(created_at_raw, datetime) else created_at_raw
        updated_at_raw = row.get("prospect_updated_at") or row.get("updated_at") or row.get("updatedAt") or created_at_raw
        updated_at = updated_at_raw.isoformat() if isinstance(updated_at_raw, datetime) else updated_at_raw or created_at
        record_id = f"contact_form:{row.get('id')}" if row.get("id") is not None else _generate_unique_code("system")
        status = row.get("prospect_status") or "contact_form"
        prospect_sales_rep_id = row.get("prospect_sales_rep_id") or None
        if mysql_enabled and row.get("id") is not None and not row.get("prospect_status"):
            # Best-effort backfill so every contact form exists in the generalized prospects table.
            try:
                sales_prospect_repository.upsert(
                    {
                        "id": record_id,
                        "salesRepId": str(prospect_sales_rep_id) if prospect_sales_rep_id else None,
                        "contactFormId": str(row.get("id")),
                        "status": "contact_form",
                        "isManual": False,
                        "contactName": row.get("name") or None,
                        "contactEmail": row.get("email") or None,
                        "contactPhone": row.get("phone") or None,
                    }
                )
            except Exception:
                pass
        base = {
            "id": record_id,
            "referrerDoctorId": None,
            "salesRepId": str(sales_rep_id)
            if sales_rep_id
            else (str(prospect_sales_rep_id) if prospect_sales_rep_id else None),
            "referredContactName": row.get("name") or "Contact Form Lead",
            "referredContactEmail": row.get("email") or None,
            "referredContactPhone": row.get("phone") or None,
            "status": status,
            "salesRepNotes": row.get("prospect_notes") or None,
            "notes": row.get("source") or "Contact form submission",
            "resellerPermitExempt": bool(row.get("reseller_permit_exempt") or 0),
            "resellerPermitFilePath": row.get("reseller_permit_file_path") or None,
            "resellerPermitFileName": row.get("reseller_permit_file_name") or None,
            "resellerPermitUploadedAt": (
                row.get("reseller_permit_uploaded_at").isoformat()
                if isinstance(row.get("reseller_permit_uploaded_at"), datetime)
                else row.get("reseller_permit_uploaded_at")
            ),
            "officeAddressLine1": row.get("office_address_line1") or None,
            "officeAddressLine2": row.get("office_address_line2") or None,
            "officeCity": row.get("office_city") or None,
            "officeState": row.get("office_state") or None,
            "officePostalCode": row.get("office_postal_code") or None,
            "officeCountry": row.get("office_country") or None,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "convertedDoctorId": row.get("prospect_doctor_id") or None,
            "convertedAt": None,
            "referredContactHasAccount": False,
            "referredContactAccountId": None,
            "referredContactAccountName": None,
            "referredContactAccountEmail": None,
            "referredContactAccountCreatedAt": None,
            "referredContactTotalOrders": 0,
            "referredContactEligibleForCredit": False,
            "isManual": False,
        }
        records.append(_apply_referred_contact_account_fields(base))
    return records


def list_referrals_for_sales_rep(sales_rep_identifier: str, scope_all: bool = False, token_role: Optional[str] = None):
    """
    Fetch lead records visible to the given sales rep.

    The sales_prospects table is the authoritative source for which leads belong in the sales-rep pipeline.
    The referrals table is used only to enrich referral-derived leads (e.g. referrerDoctor details, creditIssuedAt).
    """
    sales_rep_id = (
        _resolve_sales_rep_id(sales_rep_identifier)
        or _resolve_sales_rep_id(_resolve_user_id(sales_rep_identifier))
        or _resolve_user_id(sales_rep_identifier)
        or sales_rep_identifier
    )
    if not sales_rep_id:
        return []

    # Determine the *target* user's role even when `sales_rep_id` resolves to a sales_reps.id.
    target_user = None
    try:
        target_user = user_repository.find_by_id(str(sales_rep_identifier))
    except Exception:
        target_user = None
    if not target_user:
        try:
            target_user = user_repository.find_by_id(str(sales_rep_id))
        except Exception:
            target_user = None
    if not target_user:
        try:
            rep = sales_rep_repository.find_by_id(str(sales_rep_id))
        except Exception:
            rep = None
        legacy_user_id = str(rep.get("legacyUserId") or rep.get("legacy_user_id") or "").strip() if isinstance(rep, dict) else ""
        if legacy_user_id:
            try:
                target_user = user_repository.find_by_id(legacy_user_id)
            except Exception:
                target_user = None
    if not target_user:
        try:
            rep = sales_rep_repository.find_by_id(str(sales_rep_identifier))
        except Exception:
            rep = None
        legacy_user_id = str(rep.get("legacyUserId") or rep.get("legacy_user_id") or "").strip() if isinstance(rep, dict) else ""
        if legacy_user_id:
            try:
                target_user = user_repository.find_by_id(legacy_user_id)
            except Exception:
                target_user = None

    role = (target_user.get("role") or "").lower() if isinstance(target_user, dict) else ""
    token_is_admin = (token_role or "").lower() == "admin"
    # `is_admin` here means the *target* dashboard is for an admin account.
    # Do not treat "viewer is admin" as "target is admin" or else house/contact-form
    # prospects leak into every sales rep/sales lead dashboard.
    is_admin = role == "admin"

    def _is_blank_lead(record: Dict) -> bool:
        if not isinstance(record, dict):
            return True

        def has_text(value) -> bool:
            return isinstance(value, str) and value.strip() != ""

        # Must have an id to be actionable.
        if not has_text(record.get("id")):
            return True

        meaningful_fields = [
            "referredContactName",
            "referredContactEmail",
            "referredContactPhone",
            "referredContactAccountId",
            "referredContactAccountEmail",
            "referrerDoctorId",
            "referrerDoctorName",
            "referrerDoctorEmail",
            "referrerDoctorPhone",
            "convertedDoctorId",
            "officeAddressLine1",
            "officeAddressLine2",
            "officeCity",
            "officeState",
            "officePostalCode",
            "officeCountry",
            "salesRepNotes",
            "notes",
        ]
        for key in meaningful_fields:
            value = record.get(key)
            if isinstance(value, bool):
                continue
            if value is None:
                continue
            if isinstance(value, (int, float)) and value != 0:
                return False
            if has_text(value):
                return False
        return True

    def _is_manual_prospect(p: Dict) -> bool:
        if not isinstance(p, dict):
            return False
        if bool(p.get("isManual")):
            return True
        return str(p.get("id") or "").startswith("manual:")

    def _is_contact_form_prospect(p: Dict) -> bool:
        if not isinstance(p, dict):
            return False
        if str(p.get("id") or "").startswith("contact_form:"):
            return True
        return bool(p.get("contactFormId"))

    def _make_manual_lead(p: Dict) -> Dict:
        base = {
            "id": p.get("id"),
            "referrerDoctorId": None,
            "salesRepId": p.get("salesRepId"),
            "referredContactName": p.get("contactName"),
            "referredContactEmail": p.get("contactEmail"),
            "referredContactPhone": p.get("contactPhone"),
            "status": p.get("status") or "pending",
            "salesRepNotes": p.get("notes") or None,
            "notes": p.get("notes") or None,
            "resellerPermitExempt": bool(p.get("resellerPermitExempt")),
            "resellerPermitFilePath": p.get("resellerPermitFilePath") or None,
            "resellerPermitFileName": p.get("resellerPermitFileName") or None,
            "resellerPermitUploadedAt": p.get("resellerPermitUploadedAt") or None,
            "officeAddressLine1": p.get("officeAddressLine1") or None,
            "officeAddressLine2": p.get("officeAddressLine2") or None,
            "officeCity": p.get("officeCity") or None,
            "officeState": p.get("officeState") or None,
            "officePostalCode": p.get("officePostalCode") or None,
            "officeCountry": p.get("officeCountry") or None,
            "createdAt": p.get("createdAt"),
            "updatedAt": p.get("updatedAt"),
            "convertedDoctorId": p.get("doctorId") or None,
            "convertedAt": None,
            "referredContactHasAccount": False,
            "referredContactAccountId": None,
            "referredContactAccountName": None,
            "referredContactAccountEmail": None,
            "referredContactAccountCreatedAt": None,
            "referredContactTotalOrders": 0,
            "referredContactEligibleForCredit": False,
            "isManual": True,
        }
        return _apply_referred_contact_account_fields(base)

    def _make_contact_form_lead(p: Dict) -> Dict:
        contact_form_id = p.get("contactFormId")
        lead_id = str(p.get("id") or "")
        if not lead_id.startswith("contact_form:"):
            lead_id = f"contact_form:{contact_form_id}" if contact_form_id else lead_id
        base = {
            "id": lead_id,
            "referrerDoctorId": None,
            "salesRepId": p.get("salesRepId"),
            "referredContactName": p.get("contactName") or "Contact Form Lead",
            "referredContactEmail": p.get("contactEmail") or None,
            "referredContactPhone": p.get("contactPhone") or None,
            "status": p.get("status") or "contact_form",
            "salesRepNotes": p.get("notes") or None,
            "notes": p.get("notes") or "Contact form submission",
            "resellerPermitExempt": bool(p.get("resellerPermitExempt")),
            "resellerPermitFilePath": p.get("resellerPermitFilePath") or None,
            "resellerPermitFileName": p.get("resellerPermitFileName") or None,
            "resellerPermitUploadedAt": p.get("resellerPermitUploadedAt") or None,
            "officeAddressLine1": p.get("officeAddressLine1") or None,
            "officeAddressLine2": p.get("officeAddressLine2") or None,
            "officeCity": p.get("officeCity") or None,
            "officeState": p.get("officeState") or None,
            "officePostalCode": p.get("officePostalCode") or None,
            "officeCountry": p.get("officeCountry") or None,
            "createdAt": p.get("createdAt"),
            "updatedAt": p.get("updatedAt"),
            "convertedDoctorId": p.get("doctorId") or None,
            "convertedAt": None,
            "referredContactHasAccount": False,
            "referredContactAccountId": None,
            "referredContactAccountName": None,
            "referredContactAccountEmail": None,
            "referredContactAccountCreatedAt": None,
            "referredContactTotalOrders": 0,
            "referredContactEligibleForCredit": False,
            "isManual": False,
        }
        return _apply_referred_contact_account_fields(base)

    prospects = (
        sales_prospect_repository.get_all()
        if (is_admin and scope_all)
        else sales_prospect_repository.find_by_sales_rep(str(sales_rep_id))
    )

    # Admin "mine" dashboards should still include the house pipeline so admins can track
    # inbound/house contacts without leaking other reps' pipelines.
    if token_is_admin and not scope_all:
        try:
            from ..repositories.sales_prospect_repository import HOUSE_SALES_REP_ID

            prospects = [*prospects, *sales_prospect_repository.find_by_sales_rep(HOUSE_SALES_REP_ID)]
        except Exception:
            pass

    seen_prospect_ids: set[str] = set()
    normalized_prospects: list[dict] = []
    for p in prospects or []:
        if not isinstance(p, dict):
            continue
        pid = str(p.get("id") or "").strip()
        if pid and pid in seen_prospect_ids:
            continue
        if pid:
            seen_prospect_ids.add(pid)
        normalized_prospects.append(p)

    manual_leads = [_make_manual_lead(p) for p in normalized_prospects if _is_manual_prospect(p)]

    # Admin dashboards include house contact-form leads; they are not tied to any rep sales code.
    if token_is_admin:
        contact_form_leads = _load_contact_form_referrals(sales_rep_id=None)
    else:
        contact_form_leads = [_make_contact_form_lead(p) for p in normalized_prospects if _is_contact_form_prospect(p)]

    referral_ids: list[str] = []
    for p in normalized_prospects:
        if _is_manual_prospect(p) or _is_contact_form_prospect(p):
            continue
        rid = str(p.get("referralId") or "").strip()
        if rid and not rid.startswith(("contact_form:", "manual:")):
            referral_ids.append(rid)

    referral_leads: list[dict] = []
    for rid in referral_ids:
        ref = referral_repository.find_by_id(rid)
        if ref:
            referral_leads.append(_enrich_referral(ref))
            continue
        # Fallback: keep lead visible from prospect even if the referral record is missing.
        prospect = next((p for p in normalized_prospects if str(p.get("referralId") or "") == rid), None)
        if not prospect:
            continue
        base = {
            "id": rid,
            "referrerDoctorId": None,
            "salesRepId": prospect.get("salesRepId"),
            "referredContactName": prospect.get("contactName"),
            "referredContactEmail": prospect.get("contactEmail"),
            "referredContactPhone": prospect.get("contactPhone"),
            "status": prospect.get("status") or "pending",
            "salesRepNotes": prospect.get("notes") or None,
            "notes": prospect.get("notes") or None,
            "resellerPermitExempt": bool(prospect.get("resellerPermitExempt")),
            "resellerPermitFilePath": prospect.get("resellerPermitFilePath") or None,
            "resellerPermitFileName": prospect.get("resellerPermitFileName") or None,
            "resellerPermitUploadedAt": prospect.get("resellerPermitUploadedAt") or None,
            "officeAddressLine1": prospect.get("officeAddressLine1") or None,
            "officeAddressLine2": prospect.get("officeAddressLine2") or None,
            "officeCity": prospect.get("officeCity") or None,
            "officeState": prospect.get("officeState") or None,
            "officePostalCode": prospect.get("officePostalCode") or None,
            "officeCountry": prospect.get("officeCountry") or None,
            "createdAt": prospect.get("createdAt"),
            "updatedAt": prospect.get("updatedAt"),
            "convertedDoctorId": prospect.get("doctorId") or None,
            "convertedAt": None,
            "referredContactHasAccount": False,
            "referredContactAccountId": None,
            "referredContactAccountName": None,
            "referredContactAccountEmail": None,
            "referredContactAccountCreatedAt": None,
            "referredContactTotalOrders": 0,
            "referredContactEligibleForCredit": False,
            "isManual": False,
        }
        referral_leads.append(_apply_referred_contact_account_fields(base))

    combined = [*referral_leads, *contact_form_leads, *manual_leads]
    combined = [lead for lead in combined if not _is_blank_lead(lead)]
    combined.sort(key=lambda item: _normalize_timestamp(item.get("createdAt")), reverse=True)

    logger.info(
        "[referrals] leads from sales_prospects",
        extra={
            "sales_rep_id": str(sales_rep_id),
            "scope_all": bool(scope_all),
            "admin": bool(is_admin),
            "viewer_admin": bool(token_is_admin),
            "lead_count": len(combined),
        },
    )
    return combined


def update_referral_for_sales_rep(referral_id: str, sales_rep_id: str, updates: Dict) -> Dict:
    resolved_sales_rep_id = str(_resolve_user_id(sales_rep_id) or "").strip()
    fallback_sales_rep_id = str(sales_rep_id or "").strip()

    if _is_contact_form_id(referral_id):
        return _update_contact_form_referral(referral_id, sales_rep_id, updates)

    if str(referral_id or "").startswith("manual:"):
        return _update_manual_prospect(referral_id, sales_rep_id, updates)

    referral = referral_repository.find_by_id(referral_id)
    referral_missing = False
    if not referral:
        # If the referral record is missing, still allow updates when a sales_prospects row exists.
        referral_missing = True
        fallback_prospect = None
        try:
            if resolved_sales_rep_id:
                fallback_prospect = sales_prospect_repository.find_by_sales_rep_and_referral(
                    resolved_sales_rep_id,
                    referral_id,
                )
            if not fallback_prospect and fallback_sales_rep_id:
                fallback_prospect = sales_prospect_repository.find_by_sales_rep_and_referral(
                    fallback_sales_rep_id,
                    referral_id,
                )
        except Exception:
            fallback_prospect = None
        if not fallback_prospect:
            raise _service_error("REFERRAL_NOT_FOUND", 404)
        referral = {
            "id": referral_id,
            "salesRepId": fallback_prospect.get("salesRepId") or resolved_sales_rep_id or fallback_sales_rep_id or None,
            "referrerDoctorId": None,
            "referredContactName": fallback_prospect.get("contactName"),
            "referredContactEmail": fallback_prospect.get("contactEmail"),
            "referredContactPhone": fallback_prospect.get("contactPhone"),
            "notes": fallback_prospect.get("notes") or None,
            "createdAt": fallback_prospect.get("createdAt"),
            "updatedAt": fallback_prospect.get("updatedAt"),
        }

    candidate_identifiers = []
    if resolved_sales_rep_id:
        candidate_identifiers.append(resolved_sales_rep_id)
    if fallback_sales_rep_id and fallback_sales_rep_id not in candidate_identifiers:
        candidate_identifiers.append(fallback_sales_rep_id)

    alias_set = _resolve_sales_rep_aliases(candidate_identifiers)

    accessible_ids: set[str] = set()
    for candidate in candidate_identifiers:
        try:
            prospect = sales_prospect_repository.find_by_sales_rep_and_referral(str(candidate), str(referral_id))
        except Exception:
            prospect = None
        if prospect and prospect.get("referralId") is not None:
            accessible_ids.add(str(referral_id))
            break

    if not accessible_ids:
        for candidate in candidate_identifiers:
            for item in referral_repository.find_by_sales_rep(candidate):
                if item.get("id") is not None:
                    accessible_ids.add(str(item["id"]))

    if not accessible_ids and _referral_matches_aliases(referral, alias_set):
        accessible_ids.add(str(referral.get("id")))

    if str(referral.get("id")) not in accessible_ids:
        raise _service_error("REFERRAL_NOT_FOUND", 404)

    existing_prospect = sales_prospect_repository.find_by_sales_rep_and_referral(
        str(referral.get("salesRepId") or sales_rep_id),
        str(referral.get("id")),
    )
    current_status = (existing_prospect.get("status") if existing_prospect else None) or "pending"
    referral_payload: Dict = {"id": referral["id"]}
    prospect_updates: Dict = {}
    changed_referral = False
    changed_prospect = False

    if "status" in updates:
        sanitized_status = _sanitize_referral_status(updates.get("status"), current_status)
        if sanitized_status != current_status:
            prospect_updates["status"] = sanitized_status
            changed_prospect = True

    if "notes" in updates:
        sanitized_notes = _sanitize_notes(updates.get("notes"))
        if referral_missing:
            existing_notes = existing_prospect.get("notes") if existing_prospect else None
            if sanitized_notes != (existing_notes or None):
                prospect_updates["notes"] = sanitized_notes
                changed_prospect = True
        else:
            if sanitized_notes != (referral.get("notes") or None):
                referral_payload["notes"] = sanitized_notes
                changed_referral = True
    
    if "salesRepNotes" in updates:
        sanitized_notes = _sanitize_notes(updates.get("salesRepNotes"))
        existing_notes = existing_prospect.get("notes") if existing_prospect else None
        if sanitized_notes != (existing_notes or None):
            prospect_updates["notes"] = sanitized_notes
            changed_prospect = True

    if "referredContactName" in updates:
        sanitized_name = _sanitize_text(updates.get("referredContactName"))
        if sanitized_name and sanitized_name != referral.get("referredContactName"):
            referral_payload["referredContactName"] = sanitized_name
            changed_referral = True

    if "referredContactEmail" in updates:
        sanitized_email = _sanitize_email(updates.get("referredContactEmail"))
        if sanitized_email != (referral.get("referredContactEmail") or None):
            referral_payload["referredContactEmail"] = sanitized_email
            changed_referral = True

    if "referredContactPhone" in updates:
        sanitized_phone = _sanitize_phone(updates.get("referredContactPhone"))
        if sanitized_phone != (referral.get("referredContactPhone") or None):
            referral_payload["referredContactPhone"] = sanitized_phone
            changed_referral = True

    if not changed_referral and not changed_prospect:
        return _enrich_referral(referral)

    updated = referral
    if changed_referral and not referral_missing:
        updated = referral_repository.update({**referral, **referral_payload}) or referral

    prospect_payload: Dict = {
        "id": str(referral.get("id")),
        "salesRepId": str(referral.get("salesRepId") or sales_rep_id),
        "referralId": str(referral.get("id")),
        "contactName": (updated or referral).get("referredContactName"),
        "contactEmail": (updated or referral).get("referredContactEmail"),
        "contactPhone": (updated or referral).get("referredContactPhone"),
        "isManual": False,
    }
    if "status" in prospect_updates:
        prospect_payload["status"] = prospect_updates.get("status")
    if "notes" in prospect_updates:
        prospect_payload["notes"] = prospect_updates.get("notes")
    contact_account, _ = _resolve_referred_contact_account(updated or referral)
    if contact_account and contact_account.get("id"):
        prospect_payload["doctorId"] = str(contact_account.get("id"))

    try:
        sales_prospect_repository.upsert(prospect_payload)
    except Exception:
        pass

    if referral_missing:
        prospect_snapshot = sales_prospect_repository.find_by_id(str(referral.get("id"))) or {}
        base = {
            "id": str(referral.get("id")),
            "referrerDoctorId": None,
            "salesRepId": prospect_snapshot.get("salesRepId") or (updated or referral).get("salesRepId"),
            "referredContactName": prospect_snapshot.get("contactName") or (updated or referral).get("referredContactName"),
            "referredContactEmail": prospect_snapshot.get("contactEmail") or (updated or referral).get("referredContactEmail"),
            "referredContactPhone": prospect_snapshot.get("contactPhone") or (updated or referral).get("referredContactPhone"),
            "status": prospect_snapshot.get("status") or "pending",
            "salesRepNotes": prospect_snapshot.get("notes") or None,
            "notes": prospect_snapshot.get("notes") or None,
            "resellerPermitExempt": bool(prospect_snapshot.get("resellerPermitExempt")),
            "resellerPermitFilePath": prospect_snapshot.get("resellerPermitFilePath") or None,
            "resellerPermitFileName": prospect_snapshot.get("resellerPermitFileName") or None,
            "resellerPermitUploadedAt": prospect_snapshot.get("resellerPermitUploadedAt") or None,
            "createdAt": prospect_snapshot.get("createdAt") or (updated or referral).get("createdAt"),
            "updatedAt": prospect_snapshot.get("updatedAt") or (updated or referral).get("updatedAt"),
            "convertedDoctorId": prospect_snapshot.get("doctorId") or None,
            "convertedAt": None,
            "referredContactHasAccount": False,
            "referredContactAccountId": None,
            "referredContactAccountName": None,
            "referredContactAccountEmail": None,
            "referredContactAccountCreatedAt": None,
            "referredContactTotalOrders": 0,
            "referredContactEligibleForCredit": False,
            "isManual": False,
        }
        return _apply_referred_contact_account_fields(base)

    return _enrich_referral(updated or referral)


def _update_contact_form_referral(referral_id: str, sales_rep_id: str, updates: Dict) -> Dict:
    contact_form_pk = str(referral_id).replace("contact_form:", "")
    row = mysql_client.fetch_one(
        "SELECT * FROM contact_forms WHERE id = %(id)s",
        {"id": contact_form_pk},
    )
    if not row:
        raise _service_error("REFERRAL_NOT_FOUND", 404)

    existing = sales_prospect_repository.find_by_sales_rep_and_contact_form(
        str(_resolve_user_id(sales_rep_id) or sales_rep_id),
        str(contact_form_pk),
    )
    current_status = (existing.get("status") if existing else None) or "contact_form"

    payload: Dict = {
        "id": str(referral_id),
        "salesRepId": str(_resolve_user_id(sales_rep_id) or sales_rep_id),
        "contactFormId": str(contact_form_pk),
        "contactName": row.get("name"),
        "contactEmail": row.get("email"),
        "contactPhone": row.get("phone"),
        "isManual": False,
        "status": current_status,
        "notes": existing.get("notes") if existing else None,
    }

    if "status" in updates:
        payload["status"] = _sanitize_referral_status(updates.get("status"), current_status)
    if "salesRepNotes" in updates:
        payload["notes"] = _sanitize_notes(updates.get("salesRepNotes"))

    try:
        saved = sales_prospect_repository.upsert(payload)
    except Exception as exc:
        logger.warning("[prospects] contact form prospect update failed", exc_info=exc)
        saved = payload

    created_at_raw = row.get("created_at")
    created_at = created_at_raw.isoformat() if isinstance(created_at_raw, datetime) else created_at_raw
    return {
        "id": str(referral_id),
        "referrerDoctorId": None,
        "salesRepId": str(_resolve_user_id(sales_rep_id) or sales_rep_id),
        "referredContactName": row.get("name") or "Contact Form Lead",
        "referredContactEmail": row.get("email") or None,
        "referredContactPhone": row.get("phone") or None,
        "status": saved.get("status") or "contact_form",
        "salesRepNotes": saved.get("notes") or None,
        "notes": row.get("source") or "Contact form submission",
        "resellerPermitExempt": bool(saved.get("resellerPermitExempt")),
        "resellerPermitFilePath": saved.get("resellerPermitFilePath") or None,
        "resellerPermitFileName": saved.get("resellerPermitFileName") or None,
        "resellerPermitUploadedAt": saved.get("resellerPermitUploadedAt") or None,
        "createdAt": created_at,
        "updatedAt": saved.get("updatedAt") or created_at,
        "convertedDoctorId": None,
        "convertedAt": None,
        "referredContactHasAccount": False,
        "referredContactAccountId": None,
        "referredContactAccountName": None,
        "referredContactAccountEmail": None,
        "referredContactAccountCreatedAt": None,
        "referredContactTotalOrders": 0,
        "referredContactEligibleForCredit": False,
        "isManual": False,
    }


def _update_manual_prospect(prospect_id: str, sales_rep_id: str, updates: Dict) -> Dict:
    resolved_sales_rep_id = str(_resolve_user_id(sales_rep_id) or sales_rep_id).strip()
    existing = sales_prospect_repository.find_by_id(prospect_id)
    if not existing or str(existing.get("salesRepId") or "").strip() != resolved_sales_rep_id:
        raise _service_error("REFERRAL_NOT_FOUND", 404)
    if not existing.get("isManual"):
        raise _service_error("NOT_MANUAL_PROSPECT", 400)

    current_status = existing.get("status") or "pending"
    payload: Dict = {"id": prospect_id, "salesRepId": resolved_sales_rep_id}
    changed = False

    if "status" in updates:
        payload["status"] = _sanitize_referral_status(updates.get("status"), current_status)
        changed = True

    if "salesRepNotes" in updates:
        payload["notes"] = _sanitize_notes(updates.get("salesRepNotes"))
        changed = True

    if "referredContactName" in updates:
        payload["contactName"] = _sanitize_text(updates.get("referredContactName"))
        changed = True

    if "referredContactEmail" in updates:
        payload["contactEmail"] = _sanitize_email(updates.get("referredContactEmail"))
        changed = True

    if "referredContactPhone" in updates:
        payload["contactPhone"] = _sanitize_phone(updates.get("referredContactPhone"))
        changed = True

    if not changed:
        return {
            "id": existing.get("id"),
            "referrerDoctorId": None,
            "salesRepId": existing.get("salesRepId"),
            "referredContactName": existing.get("contactName"),
            "referredContactEmail": existing.get("contactEmail"),
            "referredContactPhone": existing.get("contactPhone"),
            "status": existing.get("status") or "pending",
            "salesRepNotes": existing.get("notes") or None,
            "notes": existing.get("notes") or None,
            "resellerPermitExempt": bool(existing.get("resellerPermitExempt")),
            "resellerPermitFilePath": existing.get("resellerPermitFilePath") or None,
            "resellerPermitFileName": existing.get("resellerPermitFileName") or None,
            "resellerPermitUploadedAt": existing.get("resellerPermitUploadedAt") or None,
            "createdAt": existing.get("createdAt"),
            "updatedAt": existing.get("updatedAt"),
            "convertedDoctorId": None,
            "convertedAt": None,
            "referredContactHasAccount": False,
            "referredContactAccountId": None,
            "referredContactAccountName": None,
            "referredContactAccountEmail": None,
            "referredContactAccountCreatedAt": None,
            "referredContactTotalOrders": 0,
            "referredContactEligibleForCredit": False,
            "isManual": True,
        }

    saved = sales_prospect_repository.upsert({**existing, **payload})
    return {
        "id": saved.get("id"),
        "referrerDoctorId": None,
        "salesRepId": saved.get("salesRepId"),
        "referredContactName": saved.get("contactName"),
        "referredContactEmail": saved.get("contactEmail"),
        "referredContactPhone": saved.get("contactPhone"),
        "status": saved.get("status") or "pending",
        "salesRepNotes": saved.get("notes") or None,
        "notes": saved.get("notes") or None,
        "resellerPermitExempt": bool(saved.get("resellerPermitExempt")),
        "resellerPermitFilePath": saved.get("resellerPermitFilePath") or None,
        "resellerPermitFileName": saved.get("resellerPermitFileName") or None,
        "resellerPermitUploadedAt": saved.get("resellerPermitUploadedAt") or None,
        "createdAt": saved.get("createdAt"),
        "updatedAt": saved.get("updatedAt"),
        "convertedDoctorId": None,
        "convertedAt": None,
        "referredContactHasAccount": False,
        "referredContactAccountId": None,
        "referredContactAccountName": None,
        "referredContactAccountEmail": None,
        "referredContactAccountCreatedAt": None,
        "referredContactTotalOrders": 0,
        "referredContactEligibleForCredit": False,
        "isManual": True,
    }


def get_sales_prospect_for_sales_rep(sales_rep_id: str, identifier: str) -> Optional[Dict]:
    rep_id = str(
        _resolve_sales_rep_id(sales_rep_id)
        or _resolve_sales_rep_id(_resolve_user_id(sales_rep_id))
        or _resolve_user_id(sales_rep_id)
        or sales_rep_id
    ).strip()
    candidate = str(identifier or "").strip()
    if not rep_id or not candidate:
        return None

    prospect = sales_prospect_repository.find_by_id(candidate)
    if prospect and str(prospect.get("salesRepId") or "").strip() == rep_id:
        return prospect

    if candidate.startswith("contact_form:"):
        contact_form_pk = candidate.replace("contact_form:", "")
        return sales_prospect_repository.find_by_sales_rep_and_contact_form(rep_id, contact_form_pk)

    by_referral = sales_prospect_repository.find_by_sales_rep_and_referral(rep_id, candidate)
    if by_referral:
        return by_referral

    return sales_prospect_repository.find_by_sales_rep_and_doctor(rep_id, candidate)


def get_sales_prospect_for_admin(identifier: str) -> Optional[Dict]:
    candidate = str(identifier or "").strip()
    if not candidate:
        return None

    prospect = sales_prospect_repository.find_by_id(candidate)
    if prospect:
        return prospect

    if candidate.startswith("contact_form:"):
        return sales_prospect_repository.find_by_id(candidate)

    # Some clients pass raw numeric contact_form ids; try the canonical key.
    if candidate.isdigit():
        prospect = sales_prospect_repository.find_by_id(f"contact_form:{candidate}")
        if prospect:
            return prospect

    # Referral ids can map to multiple prospects; return the most recently updated.
    matches = sales_prospect_repository.find_all_by_referral_id(candidate)
    if matches:
        def _updated_at(row: Dict) -> str:
            return str(row.get("updatedAt") or row.get("updated_at") or "")
        matches_sorted = sorted(matches, key=_updated_at, reverse=True)
        return matches_sorted[0]

    # Doctor id lookup (for account-backed prospects).
    prospect = sales_prospect_repository.find_by_doctor_id(candidate)
    if prospect:
        return prospect

    # Email lookup as a last resort.
    if "@" in candidate:
        prospect = sales_prospect_repository.find_by_contact_email(candidate)
        if prospect:
            return prospect

    return None


def _sanitize_user_for_sales_prospect(user: Optional[Dict]) -> Optional[Dict]:
    if not user:
        return None
    return {
        "id": user.get("id"),
        "name": user.get("name"),
        "email": user.get("email"),
        "role": user.get("role"),
        "phone": user.get("phone") or user.get("phoneNumber") or user.get("phone_number"),
        "salesRepId": user.get("salesRepId") or user.get("sales_rep_id"),
        "profileImageUrl": user.get("profileImageUrl") or user.get("profile_image_url"),
        "officeAddressLine1": user.get("officeAddressLine1") or user.get("office_address_line1"),
        "officeAddressLine2": user.get("officeAddressLine2") or user.get("office_address_line2"),
        "officeCity": user.get("officeCity") or user.get("office_city"),
        "officeState": user.get("officeState") or user.get("office_state"),
        "officePostalCode": user.get("officePostalCode") or user.get("office_postal_code"),
        "officeCountry": user.get("officeCountry") or user.get("office_country"),
    }


def get_user_for_sales_prospect(prospect: Optional[Dict]) -> Optional[Dict]:
    if not prospect:
        return None
    doctor_id = prospect.get("doctorId") or prospect.get("doctor_id")
    if doctor_id:
        return _sanitize_user_for_sales_prospect(user_repository.find_by_id(str(doctor_id)))
    email = (
        prospect.get("contactEmail")
        or prospect.get("contact_email")
        or prospect.get("referredContactEmail")
        or prospect.get("referred_contact_email")
        or prospect.get("email")
    )
    if email:
        return _sanitize_user_for_sales_prospect(user_repository.find_by_email(str(email)))
    return None

def upsert_sales_prospect_for_sales_rep(
    sales_rep_id: str,
    identifier: str,
    status: Optional[str] = None,
    notes: Optional[str] = None,
    reseller_permit_exempt: Optional[bool] = None,
    office_address_updates: Optional[Dict] = None,
) -> Dict:
    if not sales_rep_id or not identifier:
        raise _service_error("INVALID_PAYLOAD", 400)

    rep_id = str(
        _resolve_sales_rep_id(sales_rep_id)
        or _resolve_sales_rep_id(_resolve_user_id(sales_rep_id))
        or _resolve_user_id(sales_rep_id)
        or sales_rep_id
    ).strip()
    candidate = str(identifier or "").strip()
    existing = get_sales_prospect_for_sales_rep(rep_id, candidate)

    payload: Dict = {"salesRepId": rep_id}
    if existing and existing.get("id"):
        payload["id"] = str(existing.get("id"))
        payload["doctorId"] = existing.get("doctorId")
        payload["referralId"] = existing.get("referralId")
        payload["contactFormId"] = existing.get("contactFormId")
        payload["isManual"] = bool(existing.get("isManual"))
        payload["contactName"] = existing.get("contactName")
        payload["contactEmail"] = existing.get("contactEmail")
        payload["contactPhone"] = existing.get("contactPhone")

        # Account-backed doctor prospects should default to "converted" and behave like manual rows,
        # since they do not have a referral/contact-form id to anchor them in the pipeline.
        existing_id = str(existing.get("id") or "")
        existing_status = str(existing.get("status") or "").strip().lower()
        is_doctor_prospect = (
            existing_id.startswith("doctor:")
            and bool(existing.get("doctorId"))
            and not existing.get("referralId")
            and not existing.get("contactFormId")
        )
        if is_doctor_prospect:
            payload["isManual"] = True
            if status is None and existing_status not in ("nuture", "nurturing"):
                payload["status"] = "converted"
            if (not payload.get("contactName")) or (not payload.get("contactEmail")) or (not payload.get("contactPhone")):
                doctor_id = str(existing.get("doctorId") or "").strip()
                doctor = user_repository.find_by_id(doctor_id) if doctor_id else None
                if doctor:
                    payload["contactName"] = payload.get("contactName") or doctor.get("name") or None
                    payload["contactEmail"] = payload.get("contactEmail") or doctor.get("email") or None
                    payload["contactPhone"] = payload.get("contactPhone") or doctor.get("phone") or doctor.get("phoneNumber") or doctor.get("phone_number") or None
    else:
        # Create a new prospect row if needed.
        if candidate.startswith("contact_form:"):
            payload["id"] = candidate
            payload["contactFormId"] = candidate.replace("contact_form:", "")
        elif candidate.startswith("manual:"):
            payload["id"] = candidate
            payload["isManual"] = True
        else:
            # If this looks like a real doctor account id, store as doctor prospect; otherwise treat as referral.
            doctor = user_repository.find_by_id(candidate)
            if doctor and (doctor.get("role") or "").lower() in ("doctor", "test_doctor"):
                payload["id"] = f"doctor:{candidate}"
                payload["doctorId"] = candidate
                payload["status"] = "converted"
                payload["isManual"] = True
                payload["contactName"] = doctor.get("name") or None
                payload["contactEmail"] = doctor.get("email") or None
                payload["contactPhone"] = doctor.get("phone") or doctor.get("phoneNumber") or doctor.get("phone_number") or None
            elif referral_repository.find_by_id(candidate):
                payload["id"] = candidate
                payload["referralId"] = candidate
            else:
                payload["id"] = candidate
                payload["referralId"] = candidate

    if status is not None:
        payload["status"] = _sanitize_referral_status(status, "pending")
    if notes is not None:
        payload["notes"] = _sanitize_notes(notes)
    if reseller_permit_exempt is not None:
        is_exempt = bool(reseller_permit_exempt)
        payload["resellerPermitExempt"] = is_exempt
        if is_exempt:
            # Enforce mutual exclusivity: an exempt prospect cannot also carry an uploaded permit.
            _delete_sales_prospect_reseller_permit_file(existing)
            payload["resellerPermitFilePath"] = None
            payload["resellerPermitFileName"] = None
            payload["resellerPermitUploadedAt"] = None
    if isinstance(office_address_updates, dict):
        if "officeAddressLine1" in office_address_updates:
            payload["officeAddressLine1"] = _sanitize_address_field(office_address_updates.get("officeAddressLine1"))
        if "officeAddressLine2" in office_address_updates:
            payload["officeAddressLine2"] = _sanitize_address_field(office_address_updates.get("officeAddressLine2"))
        if "officeCity" in office_address_updates:
            payload["officeCity"] = _sanitize_address_field(office_address_updates.get("officeCity"))
        if "officeState" in office_address_updates:
            payload["officeState"] = _sanitize_address_field(office_address_updates.get("officeState"))
        if "officePostalCode" in office_address_updates:
            payload["officePostalCode"] = _sanitize_address_field(office_address_updates.get("officePostalCode"))
        if "officeCountry" in office_address_updates:
            payload["officeCountry"] = _sanitize_address_field(office_address_updates.get("officeCountry"))

        # If this prospect corresponds to an existing user account, persist the address on the users table too.
        # The users table is the authoritative source once an account exists.
        try:
            user_target = None
            if payload.get("doctorId"):
                user_target = user_repository.find_by_id(payload.get("doctorId"))
            if not user_target and payload.get("contactEmail"):
                user_target = user_repository.find_by_email(payload.get("contactEmail"))

            if user_target and user_target.get("id"):
                address_updates: Dict[str, object] = {}
                for key in (
                    "officeAddressLine1",
                    "officeAddressLine2",
                    "officeCity",
                    "officeState",
                    "officePostalCode",
                    "officeCountry",
                ):
                    if key in payload:
                        address_updates[key] = payload.get(key)
                if address_updates:
                    user_repository.update({"id": user_target.get("id"), **address_updates})
        except Exception:
            pass
    return sales_prospect_repository.upsert(payload)


def upload_reseller_permit_for_sales_rep(
    sales_rep_id: str,
    identifier: str,
    *,
    filename: str,
    content: bytes,
) -> Dict:
    if not sales_rep_id or not identifier:
        raise _service_error("INVALID_PAYLOAD", 400)
    if not content:
        raise _service_error("INVALID_FILE", 400)

    max_bytes = 8 * 1024 * 1024
    if len(content) > max_bytes:
        raise _service_error("FILE_TOO_LARGE", 413)

    rep_id = str(_resolve_user_id(sales_rep_id) or sales_rep_id).strip()
    candidate = str(identifier or "").strip()

    safe_name = (filename or "permit").strip()
    safe_name = re.sub(r"[^a-zA-Z0-9._-]+", "_", safe_name)[:120] or "permit"

    cfg = get_config()
    data_dir = Path(str(getattr(cfg, "data_dir", "server-data")))
    relative_dir = Path("uploads") / "reseller-permits" / rep_id / re.sub(r"[^a-zA-Z0-9_-]+", "_", candidate)[:64]
    abs_dir = data_dir / relative_dir
    os.makedirs(abs_dir, exist_ok=True)

    timestamp = datetime.utcnow().strftime("%Y%m%d%H%M%S")
    stored_name = f"{timestamp}_{safe_name}"
    abs_path = abs_dir / stored_name
    abs_path.write_bytes(content)

    stored_relative = str((relative_dir / stored_name).as_posix())
    uploaded_at = datetime.utcnow().isoformat()

    base = upsert_sales_prospect_for_sales_rep(rep_id, candidate)
    _delete_sales_prospect_reseller_permit_file(base)
    return sales_prospect_repository.upsert(
        {
            **(base or {}),
            "id": str((base or {}).get("id") or candidate),
            "salesRepId": rep_id,
            "resellerPermitExempt": False,
            "resellerPermitFilePath": stored_relative,
            "resellerPermitFileName": safe_name,
            "resellerPermitUploadedAt": uploaded_at,
        }
    )


def delete_reseller_permit_for_sales_rep(sales_rep_id: str, identifier: str) -> Dict:
    rep_id = str(_resolve_user_id(sales_rep_id) or sales_rep_id).strip()
    candidate = str(identifier or "").strip()
    if not rep_id or not candidate:
        raise _service_error("INVALID_PAYLOAD", 400)

    existing = get_sales_prospect_for_sales_rep(rep_id, candidate)
    if not existing:
        raise _service_error("PERMIT_NOT_FOUND", 404)

    _delete_sales_prospect_reseller_permit_file(existing)
    updated = sales_prospect_repository.upsert(
        {
            **existing,
            "salesRepId": rep_id,
            "resellerPermitFilePath": None,
            "resellerPermitFileName": None,
            "resellerPermitUploadedAt": None,
        }
    )
    return updated


def _delete_sales_prospect_reseller_permit_file(prospect: Optional[Dict]) -> None:
    try:
        if not prospect or not prospect.get("resellerPermitFilePath"):
            return
        cfg = get_config()
        data_dir = Path(str(getattr(cfg, "data_dir", "server-data")))
        relative_path = str(prospect.get("resellerPermitFilePath") or "").lstrip("/\\")
        abs_path = (data_dir / relative_path).resolve()
        allowed_root = (data_dir / "uploads" / "reseller-permits").resolve()
        if not str(abs_path).startswith(str(allowed_root)):
            return
        if abs_path.exists():
            abs_path.unlink()
    except Exception:
        # Best-effort cleanup; never block the request flow.
        return


def get_referral_status_choices() -> List[str]:
    return REFERRAL_STATUS_CHOICES.copy()


def handle_order_referral_effects(purchaser_id: str, referral_code: Optional[str], order_total: float, order_id: str):
    checkout_bonus = award_checkout_referral_commission(referral_code, order_total, purchaser_id, order_id)
    first_order_bonus = award_first_order_credit(purchaser_id, order_id, order_total)
    return {"checkoutBonus": checkout_bonus, "firstOrderBonus": first_order_bonus}


def award_checkout_referral_commission(referral_code: Optional[str], total: float, purchaser_id: str, order_id: str):
    if not referral_code:
        return None
    referrer = user_repository.find_by_referral_code(referral_code)
    if not referrer or referrer.get("id") == purchaser_id:
        return None

    commission = round(float(total) * get_config().referral["commission_rate"], 2)
    ledger_entry = credit_ledger_repository.insert(
        {
            "doctorId": referrer["id"],
            "salesRepId": referrer.get("salesRepId"),
            "amount": commission,
            "currency": "USD",
            "direction": "credit",
            "reason": "referral_bonus",
            "description": f"Checkout referral code applied (order {order_id})",
            "firstOrderBonus": False,
            "metadata": {"context": "checkout_code", "referralCode": referral_code, "purchaserId": purchaser_id},
        }
    )

    updated_referrer = user_repository.adjust_referral_credits(referrer["id"], commission) or referrer
    updated_referrer = user_repository.update(
        {
            **updated_referrer,
            "totalReferrals": int(updated_referrer.get("totalReferrals") or 0) + 1,
        }
    ) or updated_referrer

    return {
        "referrerId": updated_referrer["id"],
        "referrerName": updated_referrer.get("name"),
        "commission": commission,
        "ledgerEntry": ledger_entry,
    }


def award_first_order_credit(purchasing_doctor_id: str, order_id: str, order_total: float):
    purchasing_doctor = user_repository.find_by_id(purchasing_doctor_id)
    if not purchasing_doctor or not purchasing_doctor.get("referrerDoctorId"):
        return None
    referrer = user_repository.find_by_id(purchasing_doctor["referrerDoctorId"])
    if not referrer:
        return None

    if _has_first_order_credit(referrer["id"], purchasing_doctor["id"]):
        return None

    referral_record = next(
        (ref for ref in referral_repository.get_all() if ref.get("convertedDoctorId") == purchasing_doctor["id"]),
        None,
    )

    amount = round(float(get_config().referral["fixed_credit_amount"]), 2)
    ledger_entry = credit_ledger_repository.insert(
        {
            "doctorId": referrer["id"],
            "salesRepId": purchasing_doctor.get("salesRepId"),
            "referralId": referral_record.get("id") if referral_record else None,
            "orderId": order_id,
            "amount": amount,
            "currency": "USD",
            "direction": "credit",
            "reason": "referral_bonus",
            "description": f"First order credit granted for {purchasing_doctor.get('name')}",
            "firstOrderBonus": True,
            "metadata": {"context": "first_order", "convertedDoctorId": purchasing_doctor["id"], "orderTotal": order_total},
        }
    )

    updated_referrer = user_repository.adjust_referral_credits(referrer["id"], amount) or referrer
    updated_referrer = user_repository.update(
        {
            **updated_referrer,
            "totalReferrals": int(updated_referrer.get("totalReferrals") or 0) + 1,
        }
    ) or updated_referrer

    user_repository.update(
        {
            **purchasing_doctor,
            "firstOrderBonusGrantedAt": _now(),
        }
    )

    if referral_record:
        credited_at = _now()
        referral_repository.update(
            {
                **referral_record,
                # Once the referrer has been credited, the pipeline should move from
                # "converted" into nurturing ("nuture") for ongoing follow-up.
                "status": "nuture",
                "convertedDoctorId": purchasing_doctor["id"],
                "convertedAt": _now(),
                "creditIssuedAt": credited_at,
                "creditIssuedAmount": amount,
                "creditIssuedBy": "system",
            }
        )
        # Keep the sales-prospect pipeline in sync (status is authoritative there).
        try:
            referral_key = str(referral_record.get("id") or "").strip()
            prospects = sales_prospect_repository.find_all_by_referral_id(referral_key) if referral_key else []
        except Exception:
            prospects = []
        for prospect in prospects or []:
            if not isinstance(prospect, dict):
                continue
            prospect_id = str(prospect.get("id") or "").strip()
            sales_rep_id = prospect.get("salesRepId") or purchasing_doctor.get("salesRepId")
            if not prospect_id or not sales_rep_id:
                continue
            try:
                sales_prospect_repository.upsert(
                    {
                        "id": prospect_id,
                        "salesRepId": str(sales_rep_id),
                        "doctorId": prospect.get("doctorId") or purchasing_doctor.get("id") or None,
                        "referralId": str(prospect.get("referralId") or referral_key or ""),
                        "status": "nuture",
                        "isManual": bool(prospect.get("isManual")) if "isManual" in prospect else False,
                        "contactName": prospect.get("contactName") or referral_record.get("referredContactName"),
                        "contactEmail": prospect.get("contactEmail") or referral_record.get("referredContactEmail"),
                        "contactPhone": prospect.get("contactPhone") or referral_record.get("referredContactPhone"),
                        "notes": prospect.get("notes") or None,
                    }
                )
            except Exception:
                pass
        # Also update any doctor-linked prospects that don't carry the referralId.
        try:
            sales_prospect_repository.mark_doctor_as_nurturing_after_credit(purchasing_doctor["id"])
        except Exception:
            pass

    return {
        "referrerId": updated_referrer["id"],
        "referrerName": updated_referrer.get("name"),
        "amount": amount,
        "ledgerEntry": ledger_entry,
    }


def _has_first_order_credit(referrer_id: str, converted_doctor_id: str) -> bool:
    entries = credit_ledger_repository.find_by_doctor(referrer_id)
    for entry in entries:
        if (
            entry.get("firstOrderBonus")
            and entry.get("metadata", {}).get("convertedDoctorId") == converted_doctor_id
        ):
            return True
    return False


def calculate_doctor_credit_summary(doctor_id: str):
    summary = credit_ledger_repository.summarize_credits(doctor_id)
    doctor = user_repository.find_by_id(doctor_id) or {}
    available_balance = float(doctor.get("referralCredits") or 0)
    lifetime_credits = float(summary.get("creditsEarned") or summary.get("total") or 0)
    net_credits = float(summary.get("total") or 0)
    return {
        "totalCredits": round(lifetime_credits, 2),
        "availableCredits": round(available_balance, 2),
        "netCredits": round(net_credits, 2),
        "firstOrderBonuses": round(float(summary["firstOrderBonuses"]), 2),
        "ledger": credit_ledger_repository.find_by_doctor(doctor_id),
    }


def manually_add_credit(doctor_id: str, amount: float, reason: str, created_by: str, referral_id: Optional[str] = None):
    """Manually add a credit to a doctor's account."""
    if not doctor_id or not isinstance(amount, (int, float)) or not reason:
        raise _service_error("INVALID_REQUEST", 400)

    doctor = user_repository.find_by_id(doctor_id)
    if not doctor:
        raise _service_error("DOCTOR_NOT_FOUND", 404)

    referral_record = referral_repository.find_by_id(referral_id) if referral_id else None
    referral_contact_name = referral_record.get("referredContactName") if referral_record else None
    description = referral_contact_name and f"Credited for {referral_contact_name}" or reason

    if referral_record:
        contact_account, order_count = _resolve_referred_contact_account(referral_record)
        if order_count <= 0:
            contact_label = referral_contact_name or referral_record.get("referredContactEmail") or "This referral"
            raise _service_error(
                f"{contact_label} has not yet placed their first order.",
                400,
            )

    metadata = {"context": "manual_credit", "createdBy": created_by}
    if referral_id:
        metadata["referralId"] = referral_id
    if referral_contact_name:
        metadata["referralContactName"] = referral_contact_name

    ledger_entry = credit_ledger_repository.insert(
        {
            "doctorId": doctor_id,
            "salesRepId": doctor.get("salesRepId"),
            "amount": round(amount, 2),
            "currency": "USD",
            "direction": "credit",
            "reason": "manual_adjustment",
            "description": description,
            "firstOrderBonus": False,
            "referralId": referral_id,
            "metadata": metadata,
        }
    )

    delta = round(amount, 2)
    updated_doctor = user_repository.adjust_referral_credits(doctor_id, delta) or {
        **doctor,
        "referralCredits": float(doctor.get("referralCredits") or 0) + delta,
    }

    if referral_record:
        credited_at = _now()
        referral_repository.update(
            {
                **referral_record,
                "creditIssuedAt": credited_at,
                "creditIssuedAmount": delta,
                "creditIssuedBy": created_by,
                # Move credited referrals out of "converted" and into nurturing.
                # The sales-prospect pipeline status is authoritative, but we also
                # update the legacy referral status for consistency.
                "status": "nuture",
            }
        )
        # Status is tracked in sales_prospects; ensure the linked prospect also moves to nurturing.
        try:
            referral_key = str(referral_record.get("id") or referral_id or "").strip()
            if referral_key:
                prospects = sales_prospect_repository.find_all_by_referral_id(referral_key)
            else:
                prospects = []
        except Exception:
            prospects = []

        updated_any = False
        for prospect in prospects or []:
            if not isinstance(prospect, dict):
                continue
            prospect_id = str(prospect.get("id") or referral_id or "").strip()
            sales_rep_id = prospect.get("salesRepId") or referral_record.get("salesRepId")
            if not prospect_id or not sales_rep_id:
                continue
            try:
                sales_prospect_repository.upsert(
                    {
                        "id": prospect_id,
                        "salesRepId": str(sales_rep_id),
                        "doctorId": prospect.get("doctorId") or None,
                        "referralId": str(prospect.get("referralId") or referral_key or ""),
                        "status": "nuture",
                        "isManual": bool(prospect.get("isManual")) if "isManual" in prospect else False,
                        "contactName": prospect.get("contactName") or referral_record.get("referredContactName"),
                        "contactEmail": prospect.get("contactEmail") or referral_record.get("referredContactEmail"),
                        "contactPhone": prospect.get("contactPhone") or referral_record.get("referredContactPhone"),
                        "notes": prospect.get("notes") or None,
                        "resellerPermitExempt": prospect.get("resellerPermitExempt") if "resellerPermitExempt" in prospect else None,
                        "resellerPermitFilePath": prospect.get("resellerPermitFilePath") if "resellerPermitFilePath" in prospect else None,
                        "resellerPermitFileName": prospect.get("resellerPermitFileName") if "resellerPermitFileName" in prospect else None,
                        "resellerPermitUploadedAt": prospect.get("resellerPermitUploadedAt") if "resellerPermitUploadedAt" in prospect else None,
                        "createdAt": prospect.get("createdAt") or referral_record.get("createdAt"),
                        "updatedAt": credited_at,
                    }
                )
                updated_any = True
            except Exception:
                continue

        if not updated_any:
            # Fallback: best-effort upsert by referral id (common schema uses id==referralId).
            try:
                referral_key = str(referral_record.get("id") or referral_id or "").strip()
                sales_rep_id = referral_record.get("salesRepId")
                if referral_key and sales_rep_id:
                    sales_prospect_repository.upsert(
                        {
                            "id": referral_key,
                            "salesRepId": str(sales_rep_id),
                            "referralId": referral_key,
                            "status": "nuture",
                            "isManual": False,
                            "contactName": referral_record.get("referredContactName"),
                            "contactEmail": referral_record.get("referredContactEmail"),
                            "contactPhone": referral_record.get("referredContactPhone"),
                            "updatedAt": credited_at,
                            "createdAt": referral_record.get("createdAt") or credited_at,
                        }
                    )
            except Exception:
                pass
        # Also update any doctor-linked prospects that don't carry the referralId.
        try:
            if contact_account and contact_account.get("id"):
                sales_prospect_repository.mark_doctor_as_nurturing_after_credit(str(contact_account.get("id")))
        except Exception:
            pass

    return {"ledgerEntry": ledger_entry, "doctor": updated_doctor}


def apply_referral_credit(doctor_id: str, amount: float, order_id: str) -> Dict:
    """Deduct referral credits from a doctor's balance and write a debit ledger entry.

    Guards against overdraft and no-ops. Returns the ledger entry and the updated
    doctor snapshot.
    """
    if not doctor_id or not isinstance(amount, (int, float)):
        raise _service_error("INVALID_CREDIT_REQUEST", 400)
    amt = float(amount)
    if amt <= 0:
        raise _service_error("INVALID_CREDIT_AMOUNT", 400)

    doctor = user_repository.find_by_id(doctor_id)
    if not doctor:
        raise _service_error("USER_NOT_FOUND", 404)
    balance = float(doctor.get("referralCredits") or 0)
    if amt > balance + 1e-9:
        raise _service_error("INSUFFICIENT_CREDITS", 400)

    updated = user_repository.adjust_referral_credits(doctor_id, -amt) or {**doctor, "referralCredits": round(balance - amt, 2)}

    ledger_entry = credit_ledger_repository.insert(
        {
            "doctorId": doctor_id,
            "salesRepId": doctor.get("salesRepId"),
            "orderId": order_id,
            "amount": round(amt, 2),
            "currency": "USD",
            "direction": "debit",
            "reason": "referral_credit_applied",
            "description": f"Applied ${amt:.2f} referral credit to order {order_id}",
            "firstOrderBonus": False,
            "metadata": {"context": "checkout", "orderId": order_id},
        }
    )

    return {"ledgerEntry": ledger_entry, "doctor": updated}


def count_orders_for_doctor(doctor_id: str) -> int:
    base_count = order_repository.count_by_user_id(doctor_id)
    if base_count > 0:
        return base_count

    try:
        doctor = user_repository.find_by_id(str(doctor_id))
    except Exception:
        doctor = None
    email = (doctor.get("email") if isinstance(doctor, dict) else None) or ""
    return 1 if _has_woo_order_for_email(email) else 0


def _service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _generate_manual_id() -> str:
    return f"manual:{int(time() * 1000)}"
def _normalize_timestamp(value) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, str):
        return value
    return ""
