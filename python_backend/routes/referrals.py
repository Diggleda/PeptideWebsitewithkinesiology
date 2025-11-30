from __future__ import annotations

import re
from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..repositories import referral_code_repository, referral_repository, user_repository, sales_rep_repository
from ..services import referral_service
from ..utils.http import handle_action

blueprint = Blueprint("referrals", __name__, url_prefix="/api/referrals")


def _sanitize_string(value, max_length=190):
    if not isinstance(value, str):
        return ""
    cleaned = re.sub(r"[\r\n\t]+", " ", value.strip())
    return cleaned[:max_length]


def _sanitize_email(value):
    candidate = _sanitize_string(value, 190).lower()
    if candidate and re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", candidate):
        return candidate
    return None


def _sanitize_phone(value):
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"[^0-9+()\\-\\s]", "", value).strip()
    return cleaned[:32] if cleaned else None


def _ensure_user():
    user_id = g.current_user.get("id")
    user = user_repository.find_by_id(user_id)
    if not user and (g.current_user.get("role") == "sales_rep"):
        rep = sales_rep_repository.find_by_id(user_id)
        if rep:
            return {**rep, "id": rep.get("id"), "role": "sales_rep"}
    if not user:
        raise _error("AUTH_USER_NOT_FOUND", 401)
    return user


def _require_doctor(user):
    role = (user.get("role") or "").lower()
    if role not in ("doctor", "test_doctor"):
        raise _error("DOCTOR_ACCESS_REQUIRED", 403)


def _require_sales_rep(user):
    if (user.get("role") or "").lower() != "sales_rep":
        token_role = (g.current_user.get("role") or "").lower()
        if token_role == "sales_rep":
            return
        raise _error("SALES_REP_ACCESS_REQUIRED", 403)


@blueprint.post("/doctor/referrals")
@require_auth
def submit_referral():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        user = _ensure_user()
        _require_doctor(user)

        if not user.get("salesRepId"):
            raise _error("NO_ASSIGNED_SALES_REP", 400)

        contact_name = _sanitize_string(payload.get("contactName"))
        contact_email = _sanitize_email(payload.get("contactEmail"))
        contact_phone = _sanitize_phone(payload.get("contactPhone"))
        notes = _sanitize_string(payload.get("notes"), 500) or None

        if not contact_name:
            raise _error("CONTACT_NAME_REQUIRED", 400)

        referral = referral_service.record_referral_submission(
            {
                "referrerDoctorId": user["id"],
                "salesRepId": user.get("salesRepId"),
                "contactName": contact_name,
                "contactEmail": contact_email,
                "contactPhone": contact_phone,
                "notes": notes,
            }
        )
        return {"referral": referral}

    return handle_action(action, status=201)


@blueprint.get("/doctor/summary")
@require_auth
def doctor_summary():

    def action():
        user = _ensure_user()
        _require_doctor(user)
        credits = referral_service.calculate_doctor_credit_summary(user["id"])
        referrals = referral_service.list_referrals_for_doctor(user["id"])
        return {"credits": credits, "referrals": referrals}

    return handle_action(action)


@blueprint.get("/doctor/ledger")
@require_auth
def doctor_ledger():

    def action():
        user = _ensure_user()
        _require_doctor(user)
        credits = referral_service.calculate_doctor_credit_summary(user["id"])
        return credits

    return handle_action(action)


@blueprint.get("/admin/dashboard")
@require_auth
def admin_dashboard():

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        referrals = referral_service.list_referrals_for_sales_rep(user["id"])
        codes = [code for code in referral_code_repository.get_all() if code.get("salesRepId") == user["id"]]
        return {
            "referrals": referrals,
            "codes": codes,
            "statuses": referral_service.get_referral_status_choices(),
        }

    return handle_action(action)


@blueprint.get("/admin/referrals")
@require_auth
def admin_referrals():

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        referrals = referral_service.list_referrals_for_sales_rep(user["id"])
        return {
            "referrals": referrals,
            "statuses": referral_service.get_referral_status_choices(),
        }

    return handle_action(action)


@blueprint.get("/admin/codes")
@require_auth
def admin_codes():

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        codes = [code for code in referral_code_repository.get_all() if code.get("salesRepId") == user["id"]]
        return {"codes": codes}

    return handle_action(action)


@blueprint.post("/admin/referrals/code")
@require_auth
def admin_create_code():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        referral_id = payload.get("referralId")
        if not referral_id:
            raise _error("REFERRAL_ID_REQUIRED", 400)

        referral = referral_repository.find_by_id(referral_id)
        if not referral or referral.get("salesRepId") != user["id"]:
            raise _error("REFERRAL_NOT_FOUND", 404)

        record = referral_service.create_onboarding_code(
            {
                "salesRepId": user["id"],
                "referrerDoctorId": referral.get("referrerDoctorId"),
                "referralId": referral.get("id"),
                "createdBy": user.get("email") or user["id"],
            }
        )

        referral_repository.update(
            {
                **referral,
                "referralCodeId": record.get("id"),
                "status": "code_issued",
            }
        )

        return {"code": record}

    return handle_action(action, status=201)


@blueprint.patch("/admin/referrals/<referral_id>")
@require_auth
def admin_update_referral(referral_id: str):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        updates = {
            key: payload.get(key)
            for key in (
                "status",
                "notes",
                "referredContactName",
                "referredContactEmail",
                "referredContactPhone",
            )
            if key in payload
        }
        referral = referral_service.update_referral_for_sales_rep(referral_id, user["id"], updates)
        return {
            "referral": referral,
            "statuses": referral_service.get_referral_status_choices(),
        }

    return handle_action(action)


@blueprint.post("/admin/credits")
@require_auth
def admin_add_credit():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        user = _ensure_user()
        _require_sales_rep(user)

        doctor_id = payload.get("doctorId")
        amount = payload.get("amount")
        reason = _sanitize_string(payload.get("reason"))

        if not doctor_id or not isinstance(amount, (int, float)) or not reason:
            raise _error("INVALID_PAYLOAD", 400)

        result = referral_service.manually_add_credit(
            doctor_id=doctor_id,
            amount=amount,
            reason=reason,
            created_by=user.get("email") or user["id"],
        )
        return result

    return handle_action(action, status=201)


@blueprint.patch("/admin/codes/<code_id>")
@require_auth
def admin_update_code(code_id):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        status = payload.get("status")
        allowed_statuses = {"available", "revoked", "retired"}
        if status and status not in allowed_statuses:
            raise _error("INVALID_STATUS", 400)

        record = referral_code_repository.find_by_id(code_id)
        if not record or record.get("salesRepId") != user["id"]:
            raise _error("CODE_NOT_FOUND", 404)

        updated = referral_code_repository.update(
            {
                **record,
                "status": status or record.get("status"),
                "history": [
                    *record.get("history", []),
                    {
                        "action": "status_changed",
                        "at": _now(),
                        "by": user.get("email") or user["id"],
                        "status": status or record.get("status"),
                    },
                ],
            }
        )
        return {"code": updated}

    return handle_action(action)


def _error(message, status):
    err = ValueError(message)
    setattr(err, "status", status)
    return err


def _now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
