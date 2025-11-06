from __future__ import annotations

import re
import secrets
from typing import Dict, List, Optional

from ..repositories import (
    credit_ledger_repository,
    order_repository,
    referral_code_repository,
    referral_repository,
    sales_rep_repository,
    user_repository,
)
from . import get_config

ALLOWED_SUFFIX_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
REFERRAL_STATUS_CHOICES = [
    "pending",
    "contacted",
    "follow_up",
    "code_issued",
    "converted",
    "closed",
    "not_interested",
    "disqualified",
    "rejected",
    "in_review",
]


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


def _sanitize_notes(value: Optional[str]) -> Optional[str]:
    return _sanitize_text(value, 600)


def _sanitize_referral_status(status: Optional[str], fallback: str) -> str:
    candidate = (status or "").strip().lower()
    if candidate in REFERRAL_STATUS_CHOICES:
        return candidate
    return fallback


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
    for record in referral_code_repository.get_all():
        code = record.get("code")
        if code:
            existing.add(code.upper())
    return existing


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
    return enriched


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
    referrer_doctor_id = data.get("referrerDoctorId")
    referral_id = data.get("referralId")
    created_by = data.get("createdBy", "system")
    timestamp = _now()
    code = _generate_unique_code(sales_rep_id)
    return referral_code_repository.insert(
        {
            "salesRepId": sales_rep_id,
            "referrerDoctorId": referrer_doctor_id,
            "referralId": referral_id,
            "code": code,
            "status": "available",
            "issuedAt": timestamp,
            "history": [
                {
                    "action": "generated",
                    "at": timestamp,
                    "by": created_by,
                }
            ],
        }
    )


def redeem_onboarding_code(payload: Dict) -> Dict:
    code = (payload.get("code") or "").strip().upper()
    doctor_id = payload.get("doctorId")
    record = referral_code_repository.find_by_code(code)
    if not record:
        raise _service_error("REFERRAL_CODE_UNKNOWN", 404)
    if record.get("status") != "available":
        raise _service_error("REFERRAL_CODE_UNAVAILABLE", 409)

    timestamp = _now()
    updated = referral_code_repository.update(
        {
            **record,
            "doctorId": doctor_id,
            "status": "retired",
            "redeemedAt": timestamp,
            "history": [*record.get("history", []), {"action": "redeemed", "at": timestamp, "doctorId": doctor_id}],
        }
    )

    if record.get("referralId"):
        referral = referral_repository.find_by_id(record["referralId"])
        if referral:
            referral_repository.update(
                {
                    **referral,
                    "status": "converted",
                    "convertedDoctorId": doctor_id,
                    "convertedAt": timestamp,
                }
            )
    return updated


def get_onboarding_code(code: str) -> Optional[Dict]:
    return referral_code_repository.find_by_code(code)


def record_referral_submission(data: Dict) -> Dict:
    timestamp = _now()
    return referral_repository.insert(
        {
            "referrerDoctorId": data.get("referrerDoctorId"),
            "salesRepId": data.get("salesRepId"),
            "referredContactName": data.get("contactName"),
            "referredContactEmail": data.get("contactEmail"),
            "referredContactPhone": data.get("contactPhone"),
            "status": "pending",
            "notes": data.get("notes"),
            "createdAt": timestamp,
            "updatedAt": timestamp,
        }
    )


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
    return referral_repository.find_by_referrer(doctor_id)


def list_referrals_for_sales_rep(sales_rep_identifier: str):
    sales_rep_id = _resolve_user_id(sales_rep_identifier)
    if not sales_rep_id:
        return []
    referrals: List[Dict] = []
    for ref in referral_repository.get_all():
        ref_rep_id = (ref.get("salesRepId") or "") or None
        matches = False
        if ref_rep_id and str(ref_rep_id) == str(sales_rep_id):
            matches = True
        else:
            doctor_id = ref.get("referrerDoctorId")
            if doctor_id:
                doctor = user_repository.find_by_id(doctor_id)
                if doctor and str(doctor.get("salesRepId") or "") == str(sales_rep_id):
                    matches = True

        if matches:
            referrals.append(ref)

    referrals.sort(key=lambda item: item.get("createdAt") or "", reverse=True)
    return [_enrich_referral(ref) for ref in referrals]


def update_referral_for_sales_rep(referral_id: str, sales_rep_id: str, updates: Dict) -> Dict:
    referral = referral_repository.find_by_id(referral_id)
    if not referral or referral.get("salesRepId") != sales_rep_id:
        raise _service_error("REFERRAL_NOT_FOUND", 404)

    current_status = referral.get("status") or "pending"
    payload: Dict = {"id": referral["id"]}
    changed = False

    if "status" in updates:
        sanitized_status = _sanitize_referral_status(updates.get("status"), current_status)
        if sanitized_status != current_status:
            payload["status"] = sanitized_status
            changed = True

    if "notes" in updates:
        sanitized_notes = _sanitize_notes(updates.get("notes"))
        if sanitized_notes != (referral.get("notes") or None):
            payload["notes"] = sanitized_notes
            changed = True

    if "referredContactName" in updates:
        sanitized_name = _sanitize_text(updates.get("referredContactName"))
        if sanitized_name and sanitized_name != referral.get("referredContactName"):
            payload["referredContactName"] = sanitized_name
            changed = True

    if "referredContactEmail" in updates:
        sanitized_email = _sanitize_email(updates.get("referredContactEmail"))
        if sanitized_email != (referral.get("referredContactEmail") or None):
            payload["referredContactEmail"] = sanitized_email
            changed = True

    if "referredContactPhone" in updates:
        sanitized_phone = _sanitize_phone(updates.get("referredContactPhone"))
        if sanitized_phone != (referral.get("referredContactPhone") or None):
            payload["referredContactPhone"] = sanitized_phone
            changed = True

    if not changed:
        return _enrich_referral(referral)

    updated = referral_repository.update({**referral, **payload})
    return _enrich_referral(updated or referral)


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

    updated_referrer = user_repository.update(
        {
            **referrer,
            "referralCredits": float(referrer.get("referralCredits") or 0) + commission,
            "totalReferrals": int(referrer.get("totalReferrals") or 0) + 1,
        }
    ) or referrer

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

    updated_referrer = user_repository.update(
        {
            **referrer,
            "referralCredits": float(referrer.get("referralCredits") or 0) + amount,
            "totalReferrals": int(referrer.get("totalReferrals") or 0) + 1,
        }
    ) or referrer

    user_repository.update(
        {
            **purchasing_doctor,
            "firstOrderBonusGrantedAt": _now(),
        }
    )

    if referral_record:
        referral_repository.update(
            {
                **referral_record,
                "status": "converted",
                "convertedDoctorId": purchasing_doctor["id"],
                "convertedAt": _now(),
            }
        )

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
    return {
        "totalCredits": round(float(summary["total"]), 2),
        "firstOrderBonuses": round(float(summary["firstOrderBonuses"]), 2),
        "ledger": credit_ledger_repository.find_by_doctor(doctor_id),
    }


def count_orders_for_doctor(doctor_id: str) -> int:
    return len(order_repository.find_by_user_id(doctor_id))


def _service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
