from __future__ import annotations

import re
from pathlib import Path
from flask import Blueprint, g, request, send_file

from ..middleware.auth import require_auth
from ..repositories import referral_code_repository, referral_repository, sales_prospect_repository, user_repository, sales_rep_repository
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
    role = (user.get("role") or "").lower()
    token_role = (g.current_user.get("role") or "").lower()
    # Allow admins regardless of stored role, and allow explicit sales_rep/rep
    if token_role == "admin" or role == "admin":
        return
    if role in ("sales_rep", "rep") or token_role in ("sales_rep", "rep"):
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


@blueprint.delete("/doctor/referrals/<referral_id>")
@require_auth
def delete_doctor_referral(referral_id: str):

    def action():
        user = _ensure_user()
        _require_doctor(user)
        referral = referral_repository.find_by_id(referral_id)
        # If missing or already removed, treat as success (idempotent)
        if not referral:
            return {"deleted": True}

        # Status is tracked in sales_prospects; block delete if any prospect has progressed.
        prospects = sales_prospect_repository.find_all_by_referral_id(referral_id)
        progressed = any((p.get("status") or "").lower() not in ("", "pending") for p in prospects)
        if progressed:
            raise _error("REFERRAL_DELETE_NOT_ALLOWED", 409)

        # Allow deletion even if ownership metadata is missing/mismatched (legacy data)
        referral_repository.delete(referral_id)
        return {"deleted": True}

    return handle_action(action)


@blueprint.get("/admin/dashboard")
@require_auth
def admin_dashboard():

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        requested_sales_rep_id = (request.args.get("salesRepId") or user.get("salesRepId") or user.get("id") or "").strip()
        scope_all = (request.args.get("scope") or "").lower() == "all"
        # Admins can view all referrals; sales reps stay scoped to their own assignments.
        target_sales_rep_id = user["id"] if not scope_all and not requested_sales_rep_id else requested_sales_rep_id or user["id"]
        referrals = referral_service.list_referrals_for_sales_rep(
            target_sales_rep_id,
            scope_all=scope_all and user.get("role", "").lower() == "admin",
            token_role=(g.current_user.get("role") or "").lower(),
        )
        codes = (
            referral_code_repository.get_all()
            if scope_all and (user.get("role") or "").lower() == "admin"
            else [code for code in referral_code_repository.get_all() if str(code.get("salesRepId")) == str(target_sales_rep_id)]
        )
        users = referral_service.list_accounts_for_sales_rep(
            target_sales_rep_id,
            scope_all=scope_all and (user.get("role") or "").lower() == "admin",
        )
        return {
            "version": "backend_v1.9.64",
            "referrals": referrals,
            "codes": codes,
            "users": users,
            "statuses": referral_service.get_referral_status_choices(),
        }

    return handle_action(action)


@blueprint.get("/admin/referrals")
@require_auth
def admin_referrals():

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        referrals = referral_service.list_referrals_for_sales_rep(
            user["id"],
            token_role=(g.current_user.get("role") or "").lower(),
        )
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
        target_ids = {str(user.get("id"))}
        linked = user.get("salesRepId") or g.current_user.get("salesRepId")
        if linked:
            target_ids.add(str(linked))
        codes = [
            code
            for code in referral_code_repository.get_all()
            if str(code.get("salesRepId")) in target_ids
        ]
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
                "status": "contacted",
            }
        )

        return {"code": record}

    return handle_action(action, status=201)


@blueprint.post("/admin/manual")
@require_auth
def admin_create_manual_prospect():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        referral = referral_service.create_manual_prospect(
            {
                "salesRepId": user["id"],
                "name": payload.get("name"),
                "email": payload.get("email"),
                "phone": payload.get("phone"),
                "notes": payload.get("notes"),
                "status": payload.get("status"),
                "hasAccount": payload.get("hasAccount"),
            }
        )
        return {"referral": referral}

    return handle_action(action, status=201)


@blueprint.delete("/admin/manual/<referral_id>")
@require_auth
def admin_delete_manual_prospect(referral_id: str):

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        referral_service.delete_manual_prospect(referral_id, user["id"])
        return {"status": "deleted"}

    return handle_action(action)


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
                "salesRepNotes",
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


@blueprint.get("/admin/sales-prospects/<identifier>")
@require_auth
def admin_get_sales_prospect(identifier: str):
    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        prospect = referral_service.get_sales_prospect_for_sales_rep(user["id"], identifier)
        return {"prospect": prospect}

    return handle_action(action)


@blueprint.patch("/admin/sales-prospects/<identifier>")
@require_auth
def admin_upsert_sales_prospect(identifier: str):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        user = _ensure_user()
        _require_sales_rep(user)
        prospect = referral_service.upsert_sales_prospect_for_sales_rep(
            sales_rep_id=user["id"],
            identifier=identifier,
            status=payload.get("status") if "status" in payload else None,
            notes=payload.get("notes") if "notes" in payload else None,
            reseller_permit_exempt=payload.get("resellerPermitExempt")
            if "resellerPermitExempt" in payload
            else None,
        )
        return {"prospect": prospect}

    return handle_action(action)


@blueprint.route("/admin/sales-prospects/<identifier>/reseller-permit", methods=["GET", "POST", "DELETE"])
@require_auth
def admin_reseller_permit(identifier: str):
    def action():
        user = _ensure_user()
        _require_sales_rep(user)

        if request.method == "DELETE":
            prospect = referral_service.delete_reseller_permit_for_sales_rep(
                user["id"],
                identifier,
            )
            return {"prospect": prospect}

        if request.method == "POST":
            file = request.files.get("file")
            if not file:
                raise _error("INVALID_FILE", 400)

            content = file.read()
            filename = file.filename or "reseller_permit"
            prospect = referral_service.upload_reseller_permit_for_sales_rep(
                user["id"],
                identifier,
                filename=filename,
                content=content,
            )
            return {"prospect": prospect}

        prospect = referral_service.get_sales_prospect_for_sales_rep(user["id"], identifier)
        if not prospect or not prospect.get("resellerPermitFilePath"):
            raise _error("PERMIT_NOT_FOUND", 404)

        cfg = referral_service.get_config()
        data_dir = Path(str(getattr(cfg, "data_dir", "server-data")))
        relative_path = str(prospect.get("resellerPermitFilePath") or "").lstrip("/\\")
        abs_path = (data_dir / relative_path).resolve()
        allowed_root = (data_dir / "uploads" / "reseller-permits").resolve()
        if not str(abs_path).startswith(str(allowed_root)):
            raise _error("PERMIT_NOT_FOUND", 404)
        if not abs_path.exists():
            raise _error("PERMIT_NOT_FOUND", 404)

        download_name = prospect.get("resellerPermitFileName") or abs_path.name
        return send_file(abs_path, download_name=download_name, as_attachment=False)

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
        referral_id = payload.get("referralId")

        if not doctor_id or not isinstance(amount, (int, float)) or not reason:
            raise _error("INVALID_PAYLOAD", 400)

        result = referral_service.manually_add_credit(
            doctor_id=doctor_id,
            amount=amount,
            reason=reason,
            created_by=user.get("email") or user["id"],
            referral_id=referral_id,
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

        next_status = status or record.get("status")
        if next_status in {"revoked", "retired"}:
            rotated = referral_service.regenerate_sales_rep_code(user["id"], created_by=user.get("email") or user["id"])
            return {"code": rotated}

        return {"code": record}

    return handle_action(action)


def _error(message, status):
    err = ValueError(message)
    setattr(err, "status", status)
    return err


def _now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
