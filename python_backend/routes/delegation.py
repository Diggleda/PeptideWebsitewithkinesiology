from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import delegation_service, usage_tracking_service, resource_version_service
from ..services import settings_service  # type: ignore[attr-defined]
from ..utils.http import handle_action

blueprint = Blueprint("delegation", __name__, url_prefix="/api/delegation")


def _bump_resources(*resources: str, metadata: dict | None = None) -> None:
    resource_version_service.bump_many_safe(resources, metadata=metadata)


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


def _should_count_resolve_page_load(args: object) -> bool:
    getter = getattr(args, "get", None)
    if not callable(getter):
        return True
    raw_value = None
    for key in ("countPageLoad", "countUsage", "trackPageLoad", "track_usage", "trackUsage"):
        raw_value = getter(key)
        if raw_value is not None:
            break
    if raw_value is None:
        return True
    normalized = str(raw_value or "").strip().lower()
    if not normalized:
        return True
    return normalized not in {"0", "false", "no", "off", "read", "readonly", "poll"}


def _payload_value(payload: dict, camel: str, snake: str, default=None):
    if camel in payload:
        return payload.get(camel)
    if snake in payload:
        return payload.get(snake)
    return default


def _delegate_usage_actor(doctor_id: object = None) -> dict:
    actor = getattr(g, "current_user", None) or {}
    actor_id = str(actor.get("id") or "").strip()
    if actor_id:
        return actor
    normalized_doctor_id = str(doctor_id or "").strip()
    if normalized_doctor_id:
        return {"id": normalized_doctor_id, "role": "doctor"}
    return {}


def _track_delegate_usage(event: str, *, doctor_id: object = None, metadata: dict | None = None) -> None:
    normalized_event = str(event or "").strip()
    if not normalized_event:
        return
    event_metadata = {"linkType": "delegate", **(metadata or {})}
    usage_tracking_service.track_event(
        normalized_event,
        actor=_delegate_usage_actor(doctor_id),
        metadata=event_metadata,
    )


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
        brochure_name = _payload_value(payload, "brochureName", "brochure_name")
        link_type = _payload_value(payload, "linkType", "link_type")
        recipient_name = _payload_value(payload, "recipientName", "recipient_name")
        recipient_contact = _payload_value(payload, "recipientContact", "recipient_contact")
        delegate_name = _payload_value(payload, "delegateName", "delegate_name")
        delegate_contact = _payload_value(payload, "delegateContact", "delegate_contact")
        delegate_role = _payload_value(payload, "delegateRole", "delegate_role")
        product_scope = _payload_value(payload, "productScope", "product_scope")
        product_scope_items = _payload_value(payload, "productScopeItems", "product_scope_items")
        delegate_permission = _payload_value(payload, "delegatePermission", "delegate_permission")
        markup_percent = payload.get("markupPercent") if "markupPercent" in payload else payload.get("markup_percent")
        pricing_disclosure = _payload_value(payload, "pricingDisclosure", "pricing_disclosure")
        zelle_recipient_name = _payload_value(payload, "zelleRecipientName", "zelle_recipient_name")
        payment_confirmation_required = _payload_value(
            payload,
            "paymentConfirmationRequired",
            "payment_confirmation_required",
        )
        delegate_instructions = _payload_value(payload, "delegateInstructions", "delegate_instructions")
        internal_physician_note = _payload_value(payload, "internalPhysicianNote", "internal_physician_note")
        terms_version = _payload_value(payload, "termsVersion", "terms_version")
        shipping_policy_version = _payload_value(payload, "shippingPolicyVersion", "shipping_policy_version")
        privacy_policy_version = _payload_value(payload, "privacyPolicyVersion", "privacy_policy_version")
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
            link_type=link_type if isinstance(link_type, str) else None,
            created_by_user_id=str(actor.get("id") or doctor_id),
            reference_label=reference_label if isinstance(reference_label, str) else None,
            patient_id=patient_id if isinstance(patient_id, str) else None,
            subject_label=subject_label if isinstance(subject_label, str) else None,
            study_label=study_label if isinstance(study_label, str) else None,
            patient_reference=patient_reference if isinstance(patient_reference, str) else None,
            brochure_name=brochure_name if isinstance(brochure_name, str) else None,
            recipient_name=recipient_name if isinstance(recipient_name, str) else None,
            recipient_contact=recipient_contact if isinstance(recipient_contact, str) else None,
            delegate_name=delegate_name if isinstance(delegate_name, str) else None,
            delegate_contact=delegate_contact if isinstance(delegate_contact, str) else None,
            delegate_role=delegate_role if isinstance(delegate_role, str) else None,
            product_scope=product_scope if isinstance(product_scope, str) else None,
            product_scope_items=product_scope_items,
            delegate_permission=delegate_permission if isinstance(delegate_permission, str) else None,
            markup_percent=markup_percent if markup_percent is not None else None,
            pricing_disclosure=pricing_disclosure if isinstance(pricing_disclosure, str) else None,
            zelle_recipient_name=zelle_recipient_name if isinstance(zelle_recipient_name, str) else None,
            payment_confirmation_required=payment_confirmation_required,
            delegate_instructions=delegate_instructions if isinstance(delegate_instructions, str) else None,
            internal_physician_note=internal_physician_note if isinstance(internal_physician_note, str) else None,
            terms_version=terms_version if isinstance(terms_version, str) else None,
            shipping_policy_version=shipping_policy_version if isinstance(shipping_policy_version, str) else None,
            privacy_policy_version=privacy_policy_version if isinstance(privacy_policy_version, str) else None,
            instructions=instructions if isinstance(instructions, str) else None,
            allowed_products=allowed_products,
            expires_in_hours=expires_in_hours,
            payment_method=payment_method if isinstance(payment_method, str) else None,
            payment_instructions=payment_instructions if isinstance(payment_instructions, str) else None,
            physician_certified=physician_certified,
        )
        usage_tracking_service.track_event(
            "brochure_link_created" if str(link.get("linkType") or "").lower() == "brochure" else "delegate_link_created",
            actor=getattr(g, "current_user", None) or {},
            metadata={
                "linkType": link.get("linkType") or "delegate",
                "token": link.get("token"),
                "productScope": link.get("productScope"),
                "delegatePermission": link.get("delegatePermission"),
            },
        )
        _bump_resources(
            "patient-links",
            metadata={"source": "delegation.create", "token": link.get("token")},
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
        brochure_name = _payload_value(payload, "brochureName", "brochure_name")
        delegate_name = _payload_value(payload, "delegateName", "delegate_name")
        delegate_contact = _payload_value(payload, "delegateContact", "delegate_contact")
        delegate_role = _payload_value(payload, "delegateRole", "delegate_role")
        product_scope = _payload_value(payload, "productScope", "product_scope")
        product_scope_items = _payload_value(payload, "productScopeItems", "product_scope_items")
        delegate_permission = _payload_value(payload, "delegatePermission", "delegate_permission")
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
        pricing_disclosure = _payload_value(payload, "pricingDisclosure", "pricing_disclosure")
        zelle_recipient_name = _payload_value(payload, "zelleRecipientName", "zelle_recipient_name")
        payment_confirmation_required = _payload_value(
            payload,
            "paymentConfirmationRequired",
            "payment_confirmation_required",
        )
        delegate_instructions = _payload_value(payload, "delegateInstructions", "delegate_instructions")
        internal_physician_note = _payload_value(payload, "internalPhysicianNote", "internal_physician_note")
        terms_version = _payload_value(payload, "termsVersion", "terms_version")
        shipping_policy_version = _payload_value(payload, "shippingPolicyVersion", "shipping_policy_version")
        privacy_policy_version = _payload_value(payload, "privacyPolicyVersion", "privacy_policy_version")
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
            _track_delegate_usage(
                "delegate_link_deleted",
                doctor_id=doctor_id,
                metadata={"status": "deleted"},
            )
            _bump_resources(
                "patient-links",
                metadata={"source": "delegation.delete", "token": token},
            )
            return {"success": True, **result}

        updated = delegation_service.update_link(
            doctor_id,
            token,
            reference_label=reference_label if isinstance(reference_label, str) else None,
            patient_id=patient_id if isinstance(patient_id, str) else None,
            subject_label=subject_label if isinstance(subject_label, str) else None,
            study_label=study_label if isinstance(study_label, str) else None,
            patient_reference=patient_reference if isinstance(patient_reference, str) else None,
            brochure_name=brochure_name if isinstance(brochure_name, str) else None,
            delegate_name=delegate_name if isinstance(delegate_name, str) else None,
            delegate_contact=delegate_contact if isinstance(delegate_contact, str) else None,
            delegate_role=delegate_role if isinstance(delegate_role, str) else None,
            product_scope=product_scope if isinstance(product_scope, str) else None,
            product_scope_items=product_scope_items,
            delegate_permission=delegate_permission if isinstance(delegate_permission, str) else None,
            revoke=bool(revoke) if revoke is not None else None,
            markup_percent=markup_percent if markup_percent is not None else None,
            pricing_disclosure=pricing_disclosure if isinstance(pricing_disclosure, str) else None,
            zelle_recipient_name=zelle_recipient_name if isinstance(zelle_recipient_name, str) else None,
            payment_confirmation_required=payment_confirmation_required,
            delegate_instructions=delegate_instructions if isinstance(delegate_instructions, str) else None,
            internal_physician_note=internal_physician_note if isinstance(internal_physician_note, str) else None,
            terms_version=terms_version if isinstance(terms_version, str) else None,
            shipping_policy_version=shipping_policy_version if isinstance(shipping_policy_version, str) else None,
            privacy_policy_version=privacy_policy_version if isinstance(privacy_policy_version, str) else None,
            instructions=instructions if isinstance(instructions, str) else None,
            allowed_products=allowed_products,
            expires_in_hours=(
                expires_in_hours
                if has_expires_in_hours and expires_in_hours is not None
                else ""
                if has_expires_in_hours
                else None
            ),
            payment_method=payment_method if isinstance(payment_method, str) else None,
            payment_instructions=payment_instructions if isinstance(payment_instructions, str) else None,
            received_payment=received_payment if received_payment is not None else None,
        )
        event_name = "delegate_link_updated"
        if revoke is True:
            event_name = "delegate_link_revoked"
        elif revoke is False:
            event_name = "delegate_link_reactivated"
        elif received_payment is not None:
            event_name = "delegate_payment_status_updated"
        _track_delegate_usage(
            event_name,
            doctor_id=doctor_id,
            metadata={
                "productScope": updated.get("productScope") if isinstance(updated, dict) else None,
                "delegatePermission": updated.get("delegatePermission") if isinstance(updated, dict) else None,
                "status": updated.get("status") if isinstance(updated, dict) else None,
                "receivedPayment": updated.get("receivedPayment") if isinstance(updated, dict) else None,
            },
        )
        _bump_resources(
            "patient-links",
            metadata={"source": "delegation.update", "token": token},
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
        _bump_resources(
            "patient-links",
            "settings",
            metadata={"source": "delegation.config", "doctorId": doctor_id},
        )
        return {"success": True, "config": config}

    return handle_action(action)


@blueprint.get("/resolve")
def resolve_token():
    token = (request.args.get("token") or "").strip()
    count_page_load = _should_count_resolve_page_load(request.args)

    def action():
        ip = (
            request.headers.get("CF-Connecting-IP")
            or request.headers.get("X-Forwarded-For")
            or request.remote_addr
            or ""
        )
        if isinstance(ip, str) and "," in ip:
            ip = ip.split(",", 1)[0].strip()
        view_context = {
            "ip": ip,
            "userAgent": request.headers.get("User-Agent") or "",
        }
        kwargs = {"count_page_load": count_page_load}
        if any(str(value or "").strip() for value in view_context.values()):
            kwargs["view_context"] = view_context
        resolved = delegation_service.resolve_delegate_token(token, **kwargs)
        if count_page_load:
            _track_delegate_usage(
                "delegate_link_opened",
                doctor_id=resolved.get("doctorId") if isinstance(resolved, dict) else None,
                metadata={
                    "productScope": resolved.get("productScope") if isinstance(resolved, dict) else None,
                    "delegatePermission": resolved.get("delegatePermission") if isinstance(resolved, dict) else None,
                    "status": resolved.get("status") if isinstance(resolved, dict) else None,
                    "usageCount": resolved.get("usageCount") if isinstance(resolved, dict) else None,
                    "openCount": resolved.get("openCount") if isinstance(resolved, dict) else None,
                    "proposalStatus": resolved.get("proposalStatus") if isinstance(resolved, dict) else None,
                },
            )
        return {"success": True, **resolved}

    return handle_action(action)


@blueprint.get("/links/<token>/proposal")
@require_auth
def get_link_proposal(token: str):
    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        proposal = delegation_service.get_link_proposal(doctor_id, token)
        _track_delegate_usage(
            "delegate_proposal_review_loaded",
            doctor_id=doctor_id,
            metadata={
                "proposalStatus": proposal.get("proposalStatus") if isinstance(proposal, dict) else None,
                "status": proposal.get("status") if isinstance(proposal, dict) else None,
            },
        )
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
        _bump_resources(
            "patient-links",
            "orders",
            metadata={"source": "delegation.proposal.review", "token": token},
        )
        return {"success": True, **result}

    return handle_action(action)
