from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from flask import Blueprint, request

from ..utils.http import handle_action
from ..database import mysql_client
from ..repositories import sales_rep_repository, sales_prospect_repository, user_repository
from ..services import email_service
from ..utils.crypto_envelope import compute_blind_index, encrypt_text

blueprint = Blueprint("contact", __name__, url_prefix="/api/contact")
logger = logging.getLogger(__name__)

CONTACT_FORM_SOURCE_ALIASES = {
    "question": "question",
    "questions": "question",
    "footer": "question",
    "footer_question": "question",
    "contact": "question",
    "contact_form": "question",
    "join": "join_network",
    "join_network": "join_network",
    "join_the_network": "join_network",
    "join_physician_network": "join_network",
    "network": "join_network",
    "main_landing": "join_network",
    "landing": "join_network",
    "landing_join": "join_network",
    "landing_join_network": "join_network",
    "partner": "partner_application",
    "partner_application": "partner_application",
    "partner_applications": "partner_application",
    "partner_with_trufusionlabs": "partner_application",
    "partnership": "partner_application",
    "application": "partner_application",
}

CONTACT_FORM_MESSAGE_FIELDS = {
    "question": {
        "key": "question",
        "label": "Type your question here:",
    },
    "join_network": {
        "key": "heard_about_us",
        "label": "How did you hear about us?",
    },
    "partner_application": {
        "key": "partnership_fit",
        "label": "How can we help each other?",
    },
}


def _source_token(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _normalize_contact_form_source(value: Any) -> str:
    return CONTACT_FORM_SOURCE_ALIASES.get(_source_token(value), "question")


def _extract_sales_code(payload: Dict[str, Any], raw_source: Any) -> str:
    explicit = (
        payload.get("salesCode")
        or payload.get("sales_code")
        or payload.get("referralSource")
        or payload.get("referral_source")
    )
    sales_code = str(explicit or "").strip()
    if sales_code:
        return sales_code

    raw_source_text = str(raw_source or "").strip()
    if raw_source_text and _source_token(raw_source_text) not in CONTACT_FORM_SOURCE_ALIASES:
        return raw_source_text
    return ""


def _normalize_identifier(value: Any) -> str:
    return str(value or "").strip()


def _non_house_sales_rep_id(value: Any) -> Optional[str]:
    rep_id = _normalize_identifier(value)
    if not rep_id:
        return None
    house_id = _normalize_identifier(getattr(sales_prospect_repository, "HOUSE_SALES_REP_ID", "house"))
    if house_id and rep_id.lower() == house_id.lower():
        return None
    return rep_id


def _is_admin_role(value: Any) -> bool:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_") == "admin"


def _sales_rep_code_is_admin_owned(rep: Optional[Dict[str, Any]]) -> bool:
    if not isinstance(rep, dict):
        return False
    if _is_admin_role(rep.get("role")):
        return True

    legacy_user_id = _normalize_identifier(rep.get("legacyUserId") or rep.get("legacy_user_id"))
    if legacy_user_id:
        try:
            linked_user = user_repository.find_by_id(legacy_user_id)
        except Exception:
            linked_user = None
        if linked_user and _is_admin_role(linked_user.get("role")):
            return True

    rep_email = str(rep.get("email") or "").strip()
    if rep_email:
        try:
            linked_user = user_repository.find_by_email(rep_email)
        except Exception:
            linked_user = None
        if linked_user and _is_admin_role(linked_user.get("role")):
            return True

    return False


def _resolve_existing_lead_owner(email: str) -> Tuple[Optional[str], Optional[str]]:
    normalized_email = str(email or "").strip().lower()
    if not normalized_email:
        return None, None

    doctor_id: Optional[str] = None
    try:
        user = user_repository.find_by_email(normalized_email)
    except Exception:
        logger.warning("Failed to resolve contact form user owner", exc_info=True)
        user = None

    if user:
        role = str(user.get("role") or "").strip().lower()
        if role in ("doctor", "test_doctor"):
            doctor_id = _normalize_identifier(user.get("id")) or None
            user_rep_id = _non_house_sales_rep_id(user.get("salesRepId") or user.get("sales_rep_id"))
            if user_rep_id:
                return user_rep_id, doctor_id

    if doctor_id:
        try:
            doctor_prospect = sales_prospect_repository.find_by_doctor_id(doctor_id)
        except Exception:
            logger.warning(
                "Failed to resolve contact form prospect owner by doctor",
                extra={"doctorId": doctor_id},
                exc_info=True,
            )
            doctor_prospect = None
        prospect_rep_id = _non_house_sales_rep_id(
            (doctor_prospect or {}).get("salesRepId")
            or (doctor_prospect or {}).get("sales_rep_id")
        )
        if prospect_rep_id:
            return prospect_rep_id, doctor_id

    try:
        prospect = sales_prospect_repository.find_by_contact_email(normalized_email)
    except Exception:
        logger.warning("Failed to resolve contact form prospect owner by email", exc_info=True)
        prospect = None

    prospect_rep_id = _non_house_sales_rep_id(
        (prospect or {}).get("salesRepId")
        or (prospect or {}).get("sales_rep_id")
    )
    if prospect_rep_id:
        prospect_doctor_id = _normalize_identifier(
            (prospect or {}).get("doctorId")
            or (prospect or {}).get("doctor_id")
        )
        return prospect_rep_id, doctor_id or prospect_doctor_id or None

    return None, doctor_id


@blueprint.route("", methods=["POST"], strict_slashes=False)
def submit_contact():
    def action() -> Dict[str, Any]:
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name") or "").strip()
        email = str(payload.get("email") or "").strip()
        phone = str(payload.get("phone") or "").strip()
        message = str(
            payload.get("message")
            or payload.get("details")
            or payload.get("note")
            or ""
        ).strip()
        raw_source = payload.get("source")
        source = _normalize_contact_form_source(raw_source)
        message_field = CONTACT_FORM_MESSAGE_FIELDS[source]
        sales_code = _extract_sales_code(payload, raw_source)

        if not name or not email:
            error = ValueError("Name and email are required.")
            error.status = 400  # type: ignore[attr-defined]
            raise error

        record = {
            "name": name,
            "email": email,
            "phone": phone or None,
            "message": message or None,
            "message_field_key": message_field["key"],
            "message_label": message_field["label"],
            "source": source or None,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        if not mysql_client.is_enabled():
            error = RuntimeError("Contact form storage requires MySQL to be enabled.")
            error.status = 503  # type: ignore[attr-defined]
            raise error

        try:
            inserted_id = None
            with mysql_client.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO contact_forms (
                        name, email, phone, message, message_field_key, message_label, email_blind_index, source
                    )
                    VALUES (
                        %(name)s, %(email)s, %(phone)s, %(message)s, %(message_field_key)s, %(message_label)s, %(email_blind_index)s, %(source)s
                    )
                    """,
                    {
                        "name": encrypt_text(
                            record["name"],
                            aad={"table": "contact_forms", "field": "name"},
                        ),
                        "email": encrypt_text(
                            record["email"],
                            aad={"table": "contact_forms", "field": "email"},
                        ),
                        "phone": encrypt_text(
                            record["phone"],
                            aad={"table": "contact_forms", "field": "phone"},
                        ) if record["phone"] else None,
                        "message": encrypt_text(
                            record["message"],
                            aad={"table": "contact_forms", "field": "message"},
                        ) if record["message"] else None,
                        "message_field_key": record["message_field_key"],
                        "message_label": record["message_label"],
                        "email_blind_index": compute_blind_index(
                            record["email"],
                            label="contact_forms.email",
                            normalizer=lambda value: value.strip().lower(),
                        ),
                        "source": record["source"],
                    },
                )
                inserted_id = cur.lastrowid

            # Always add contact form submissions to the generalized prospects table.
            try:
                if inserted_id:
                    existing_rep_id, existing_doctor_id = _resolve_existing_lead_owner(record["email"])
                    rep = (
                        sales_rep_repository.find_by_sales_code(sales_code)
                        if sales_code and not existing_rep_id
                        else None
                    )
                    if existing_rep_id:
                        sales_rep_id = existing_rep_id
                    elif _sales_rep_code_is_admin_owned(rep):
                        sales_rep_id = sales_prospect_repository.HOUSE_SALES_REP_ID
                    else:
                        sales_rep_id = str(rep.get("id")) if rep and rep.get("id") else None
                    contact_phones = [record["phone"]] if record["phone"] else []
                    sales_prospect_repository.upsert(
                        {
                            "id": f"contact_form:{inserted_id}",
                            "salesRepId": sales_rep_id,
                            "doctorId": existing_doctor_id,
                            "contactFormId": str(inserted_id),
                            "sourceSystem": "contact_form",
                            "sourceExternalId": str(inserted_id),
                            "sourcePayloadJson": {
                                "contactFormId": str(inserted_id),
                                "source": record["source"] or None,
                                "submittedAt": record["createdAt"],
                                "contactName": record["name"],
                                "contactEmail": record["email"],
                                "contactPhone": record["phone"],
                                "message": record["message"],
                                "messageFieldKey": record["message_field_key"],
                                "messageLabel": record["message_label"],
                            },
                            "status": "contact_form",
                            "isManual": False,
                            "contactName": record["name"],
                            "contactEmail": record["email"],
                            "contactPhone": record["phone"],
                            "contactEmails": [record["email"]],
                            "contactPhones": contact_phones,
                        },
                        match_by_contact=False,
                    )
                    user_repository.mark_contact_form_origin_for_email(
                        record["email"],
                        source=f"contact_form:{inserted_id}",
                    )
            except Exception:
                pass
        except Exception:
            raise

        try:
            email_service.send_contact_form_received_email(
                record["email"],
                name=record["name"],
            )
        except Exception:
            logger.warning(
                "Failed to send contact form received email",
                extra={"contactFormId": inserted_id, "recipient": record["email"]},
                exc_info=True,
            )

        return {"status": "ok"}

    return handle_action(action)


@blueprint.route("", methods=["GET"], strict_slashes=False)
def contact_info():
    def action() -> Dict[str, Any]:
        return {"status": "ok"}

    return handle_action(action)
