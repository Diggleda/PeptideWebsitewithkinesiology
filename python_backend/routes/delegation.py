from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import delegation_service, usage_tracking_service
from ..services import settings_service  # type: ignore[attr-defined]
from ..utils.http import handle_action

blueprint = Blueprint("delegation", __name__, url_prefix="/api/delegation")


def _normalize_role(value: object) -> str:
    return str(value or "").strip().lower().replace(" ", "_").replace("-", "_")


def _require_doctor_access(role: str) -> None:
    if role not in ("doctor", "test_doctor", "admin"):
        err = ValueError("Doctor access required")
        setattr(err, "status", 403)
        raise err
    if role == "doctor":
        settings = settings_service.get_settings()
        if not bool(settings.get("patientLinksEnabled", False)):
            err = ValueError("Delegate links are not enabled for doctors")
            setattr(err, "status", 403)
            raise err


def _resolve_target_doctor_id(role: str) -> str:
    actor = getattr(g, "current_user", None) or {}
    actor_id = str(actor.get("id") or "").strip()
    if role == "admin":
        override = str(request.args.get("doctorId") or "").strip()
        if override:
            return override
        err = ValueError("doctorId query param is required for admin requests")
        setattr(err, "status", 400)
        raise err
    if not actor_id:
        err = ValueError("User id missing from auth token")
        setattr(err, "status", 403)
        raise err
    return actor_id


@blueprint.get("/links")
@require_auth
def list_links():
    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        return {
            "success": True,
            "links": delegation_service.list_links(doctor_id),
            "config": delegation_service.get_doctor_config(doctor_id),
        }

    return handle_action(action)


@blueprint.post("/links")
@require_auth
def create_link():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        reference_label = (
            payload.get("referenceLabel")
            if "referenceLabel" in payload
            else payload.get("reference_label")
            if "reference_label" in payload
            else payload.get("label")
        )
        patient_id = payload.get("patientId") if "patientId" in payload else payload.get("patient_id")
        subject_label = payload.get("subjectLabel") if "subjectLabel" in payload else payload.get("subject_label")
        study_label = payload.get("studyLabel") if "studyLabel" in payload else payload.get("study_label")
        patient_reference = (
            payload.get("patientReference")
            if "patientReference" in payload
            else payload.get("patient_reference")
        )
        markup_percent = payload.get("markupPercent") if "markupPercent" in payload else payload.get("markup_percent")
        instructions = payload.get("instructions") if "instructions" in payload else None
        allowed_products = (
            payload.get("allowedProducts")
            if "allowedProducts" in payload
            else payload.get("allowed_products")
        )
        expires_in_hours = (
            payload.get("expiresInHours")
            if "expiresInHours" in payload
            else payload.get("expires_in_hours")
        )
        usage_limit = payload.get("usageLimit") if "usageLimit" in payload else payload.get("usage_limit")
        payment_method = payload.get("paymentMethod") if "paymentMethod" in payload else payload.get("payment_method")
        payment_instructions = (
            payload.get("paymentInstructions")
            if "paymentInstructions" in payload
            else payload.get("payment_instructions")
        )
        physician_certified = (
            payload.get("physicianCertified")
            if "physicianCertified" in payload
            else payload.get("physician_certified")
        )
        link = delegation_service.create_link(
            doctor_id,
            reference_label=reference_label if isinstance(reference_label, str) else None,
            patient_id=patient_id if isinstance(patient_id, str) else None,
            subject_label=subject_label if isinstance(subject_label, str) else None,
            study_label=study_label if isinstance(study_label, str) else None,
            patient_reference=patient_reference if isinstance(patient_reference, str) else None,
            markup_percent=markup_percent if markup_percent is not None else None,
            instructions=instructions if isinstance(instructions, str) else None,
            allowed_products=allowed_products,
            expires_in_hours=expires_in_hours,
            usage_limit=usage_limit,
            payment_method=payment_method if isinstance(payment_method, str) else None,
            payment_instructions=payment_instructions if isinstance(payment_instructions, str) else None,
            physician_certified=physician_certified,
        )
        usage_tracking_service.track_event(
            "delegate_link_created",
            actor=getattr(g, "current_user", None) or {},
            metadata={"token": link.get("token"), "subjectLabel": link.get("subjectLabel"), "studyLabel": link.get("studyLabel")},
        )
        return {"success": True, "link": link}

    return handle_action(action, status=201)


@blueprint.patch("/links/<token>")
@require_auth
def update_link(token: str):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        reference_label = (
            payload.get("referenceLabel")
            if "referenceLabel" in payload
            else payload.get("reference_label")
            if "reference_label" in payload
            else payload.get("label")
            if "label" in payload
            else None
        )
        patient_id = payload.get("patientId") if "patientId" in payload else payload.get("patient_id") if "patient_id" in payload else None
        subject_label = payload.get("subjectLabel") if "subjectLabel" in payload else payload.get("subject_label") if "subject_label" in payload else None
        study_label = payload.get("studyLabel") if "studyLabel" in payload else payload.get("study_label") if "study_label" in payload else None
        patient_reference = (
            payload.get("patientReference")
            if "patientReference" in payload
            else payload.get("patient_reference")
            if "patient_reference" in payload
            else None
        )
        revoke = payload.get("revoke") if "revoke" in payload else None
        delete_link = (
            payload.get("delete")
            if "delete" in payload
            else payload.get("deleteLink")
            if "deleteLink" in payload
            else payload.get("permanentDelete")
            if "permanentDelete" in payload
            else None
        )
        markup_percent = payload.get("markupPercent") if "markupPercent" in payload else payload.get("markup_percent")
        instructions = payload.get("instructions") if "instructions" in payload else None
        allowed_products = (
            payload.get("allowedProducts")
            if "allowedProducts" in payload
            else payload.get("allowed_products")
            if "allowed_products" in payload
            else None
        )
        expires_in_hours = (
            payload.get("expiresInHours")
            if "expiresInHours" in payload
            else payload.get("expires_in_hours")
            if "expires_in_hours" in payload
            else None
        )
        has_expires_in_hours = "expiresInHours" in payload or "expires_in_hours" in payload
        usage_limit = payload.get("usageLimit") if "usageLimit" in payload else payload.get("usage_limit") if "usage_limit" in payload else None
        payment_method = payload.get("paymentMethod") if "paymentMethod" in payload else payload.get("payment_method")
        payment_instructions = (
          payload.get("paymentInstructions")
          if "paymentInstructions" in payload
          else payload.get("payment_instructions")
          if "payment_instructions" in payload
          else None
        )
        received_payment = (
            payload.get("receivedPayment")
            if "receivedPayment" in payload
            else payload.get("received_payment")
            if "received_payment" in payload
            else payload.get("paymentReceived")
            if "paymentReceived" in payload
            else None
        )
        if bool(delete_link):
            result = delegation_service.delete_link(doctor_id, token)
            return {"success": True, **result}

        updated = delegation_service.update_link(
            doctor_id,
            token,
            reference_label=reference_label if isinstance(reference_label, str) else None,
            patient_id=patient_id if isinstance(patient_id, str) else None,
            subject_label=subject_label if isinstance(subject_label, str) else None,
            study_label=study_label if isinstance(study_label, str) else None,
            patient_reference=patient_reference if isinstance(patient_reference, str) else None,
            revoke=bool(revoke) if revoke is not None else None,
            markup_percent=markup_percent if markup_percent is not None else None,
            instructions=instructions if isinstance(instructions, str) else None,
            allowed_products=allowed_products,
            expires_in_hours=(
                expires_in_hours
                if has_expires_in_hours and expires_in_hours is not None
                else ""
                if has_expires_in_hours
                else None
            ),
            usage_limit=usage_limit,
            payment_method=payment_method if isinstance(payment_method, str) else None,
            payment_instructions=payment_instructions if isinstance(payment_instructions, str) else None,
            received_payment=received_payment if received_payment is not None else None,
        )
        return {"success": True, "link": updated}

    return handle_action(action)


@blueprint.patch("/config")
@require_auth
def update_config():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        config = delegation_service.update_doctor_config(doctor_id, payload)
        return {"success": True, "config": config}

    return handle_action(action)


@blueprint.get("/resolve")
def resolve_token():
    token = (request.args.get("token") or "").strip()
    return handle_action(lambda: {"success": True, **delegation_service.resolve_delegate_token(token)})


@blueprint.get("/links/<token>/proposal")
@require_auth
def get_link_proposal(token: str):
    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        proposal = delegation_service.get_link_proposal(doctor_id, token)
        return {"success": True, "proposal": proposal}

    return handle_action(action)


@blueprint.post("/links/<token>/proposal/review")
@require_auth
def review_link_proposal(token: str):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        status = payload.get("status") or payload.get("proposalStatus") or None
        order_id = payload.get("orderId") or payload.get("order_id") or payload.get("doctorOrderId") or None
        amount_due = (
            payload.get("amountDue")
            if "amountDue" in payload
            else payload.get("amount_due")
            if "amount_due" in payload
            else payload.get("delegateAmountDue")
            if "delegateAmountDue" in payload
            else payload.get("delegate_amount_due")
            if "delegate_amount_due" in payload
            else payload.get("paymentTrackerAmount")
            if "paymentTrackerAmount" in payload
            else None
        )
        amount_due_currency = (
            payload.get("amountDueCurrency")
            if "amountDueCurrency" in payload
            else payload.get("amount_due_currency")
            if "amount_due_currency" in payload
            else payload.get("delegateAmountDueCurrency")
            if "delegateAmountDueCurrency" in payload
            else payload.get("delegate_amount_due_currency")
            if "delegate_amount_due_currency" in payload
            else None
        )
        notes = (
            payload.get("notes")
            or payload.get("reviewNotes")
            or payload.get("proposalReviewNotes")
            or None
        )
        if not isinstance(status, str) or not status.strip():
            err = ValueError("status is required")
            setattr(err, "status", 400)
            raise err
        result = delegation_service.review_link_proposal(
            doctor_id,
            token,
            status=str(status),
            order_id=str(order_id).strip() if isinstance(order_id, str) and str(order_id).strip() else None,
            amount_due=amount_due,
            amount_due_currency=(
                str(amount_due_currency).strip()
                if isinstance(amount_due_currency, str) and str(amount_due_currency).strip()
                else None
            ),
            notes=str(notes).strip() if isinstance(notes, str) and str(notes).strip() else None,
        )
        usage_tracking_service.track_event(
            "delegate_proposal_reviewed",
            actor=getattr(g, "current_user", None) or {},
            metadata={"token": token, "status": str(status).strip()},
        )
        return {"success": True, **result}

    return handle_action(action)
