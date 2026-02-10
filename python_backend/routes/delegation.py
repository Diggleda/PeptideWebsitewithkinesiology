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
        markup_percent = payload.get("markupPercent") if "markupPercent" in payload else payload.get("markup_percent")
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
            markup_percent=markup_percent if markup_percent is not None else None,
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
        revoke = payload.get("revoke") if "revoke" in payload else None
        markup_percent = payload.get("markupPercent") if "markupPercent" in payload else payload.get("markup_percent")
        payment_method = payload.get("paymentMethod") if "paymentMethod" in payload else payload.get("payment_method")
        payment_instructions = (
            payload.get("paymentInstructions")
            if "paymentInstructions" in payload
            else payload.get("payment_instructions")
            if "payment_instructions" in payload
            else None
        )
        updated = delegation_service.update_link(
            doctor_id,
            token,
            reference_label=reference_label if isinstance(reference_label, str) else None,
            patient_id=patient_id if isinstance(patient_id, str) else None,
            revoke=bool(revoke) if revoke is not None else None,
            markup_percent=markup_percent if markup_percent is not None else None,
            payment_method=payment_method if isinstance(payment_method, str) else None,
            payment_instructions=payment_instructions if isinstance(payment_instructions, str) else None,
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
        if not isinstance(status, str) or not status.strip():
            err = ValueError("status is required")
            setattr(err, "status", 400)
            raise err
        result = delegation_service.review_link_proposal(
            doctor_id,
            token,
            status=str(status),
            order_id=str(order_id).strip() if isinstance(order_id, str) and str(order_id).strip() else None,
        )
        return {"success": True, **result}

    return handle_action(action)
