from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import delegation_service
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
            err = ValueError("Patient links are not enabled for doctors")
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
            expires_in_hours=expires_in_hours,
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
            notes=str(notes).strip() if isinstance(notes, str) and str(notes).strip() else None,
        )
        return {"success": True, **result}

    return handle_action(action)
