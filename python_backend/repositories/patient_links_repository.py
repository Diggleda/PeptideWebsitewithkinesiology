from __future__ import annotations

import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..services import get_config
from ..utils.crypto_envelope import decrypt_json, decrypt_text, encrypt_json, encrypt_text

TTL_HOURS = 72
TOKEN_VERSION_HASHED = 2
ACTIVE_LINK_SQL = "(expires_at IS NULL OR expires_at > UTC_TIMESTAMP())"


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _fmt_datetime(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
        return dt.isoformat()
    return str(value)


def _coerce_datetime(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except Exception:
            return None
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    return None


def _serialize_json(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value)


def _parse_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception:
            return None
    return None


def _normalize_optional_text(value: Any, *, max_len: int = 190) -> Optional[str]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    return text[:max_len]


def _normalize_optional_int(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        parsed = int(float(value))
    except Exception:
        return None
    return max(1, min(parsed, 10_000))


def _normalize_bool_flag(value: Any) -> bool:
    if value is True or value is False:
        return value
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0.0
        except Exception:
            return False
    text = str(value or "").strip().lower()
    return text in ("1", "true", "yes", "y", "on")


def _normalize_allowed_products(value: Any) -> List[str]:
    if value is None:
        return []
    items: List[str]
    if isinstance(value, str):
        normalized = value.replace("\n", ",")
        items = [part.strip() for part in normalized.split(",")]
    elif isinstance(value, (list, tuple, set)):
        items = [str(part or "").strip() for part in value]
    else:
        items = [str(value).strip()]
    seen: set[str] = set()
    normalized_items: List[str] = []
    for item in items:
        if not item:
            continue
        token = item.upper()
        if token in seen:
            continue
        seen.add(token)
        normalized_items.append(token)
    return normalized_items


def _hash_token(raw_token: str) -> str:
    return hashlib.sha256(str(raw_token or "").encode("utf-8")).hexdigest()


def _field_aad(token_hash: Optional[str], field_name: str) -> Dict[str, Any]:
    return {
        "table": "patient_links",
        "record_ref": str(token_hash or "").strip() or "pending",
        "field": field_name,
    }


def _encrypt_field(token_hash: Optional[str], field_name: str, value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    return encrypt_text(value, aad=_field_aad(token_hash, field_name))


def _decrypt_field(
    row: Dict[str, Any],
    *,
    field_name: str,
    encrypted_key: Optional[str] = None,
    legacy_keys: List[str],
) -> Optional[str]:
    token_hash = str(row.get("token") or "").strip() or None
    decrypted = decrypt_text(row.get(field_name), aad=_field_aad(token_hash, field_name))
    if decrypted:
        return decrypted
    if encrypted_key:
        decrypted = decrypt_text(row.get(encrypted_key), aad=_field_aad(token_hash, field_name))
        if decrypted:
            return decrypted
    for legacy_key in legacy_keys:
        legacy_value = row.get(legacy_key)
        if legacy_value not in (None, ""):
            return str(legacy_value)
    return None


def _decrypt_json_field(
    row: Dict[str, Any],
    *,
    field_name: str,
    encrypted_key: Optional[str] = None,
    legacy_key: str,
) -> Any:
    token_hash = str(row.get("token") or "").strip() or None
    decrypted = decrypt_json(row.get(legacy_key), aad=_field_aad(token_hash, field_name))
    if decrypted is not None:
        return decrypted
    if encrypted_key:
        decrypted = decrypt_json(row.get(encrypted_key), aad=_field_aad(token_hash, field_name))
        if decrypted is not None:
            return decrypted
    return _parse_json(row.get(legacy_key))


def _lookup_params(raw_token: str) -> Dict[str, Any]:
    normalized = str(raw_token or "").strip()
    return {
        "raw_token": normalized,
        "hashed_token": _hash_token(normalized),
    }


def _resolve_row_public_token(row: Dict[str, Any], fallback: Optional[str] = None) -> Optional[str]:
    version = int(row.get("token_version") or 1)
    token_value = str(row.get("token") or "").strip()
    if version >= TOKEN_VERSION_HASHED:
        decrypted = decrypt_text(row.get("token_ciphertext"))
        if decrypted:
            return decrypted
        return fallback
    return token_value or fallback


def _derive_status(row: Dict[str, Any]) -> str:
    if row.get("revoked_at"):
        return "revoked"
    expires_at = _coerce_datetime(row.get("expires_at"))
    if isinstance(expires_at, datetime) and expires_at <= datetime.now(timezone.utc):
        return "expired"
    status = str(row.get("status") or "").strip().lower()
    if status in {"expired", "exhausted"}:
        return "active"
    return status or "active"


def _map_row(row: Dict[str, Any], *, fallback_token: Optional[str] = None) -> Dict[str, Any]:
    subject_label = _decrypt_field(
        row,
        field_name="subject_label",
        encrypted_key="subject_label_encrypted",
        legacy_keys=["subject_label", "patient_id"],
    )
    study_label = _decrypt_field(
        row,
        field_name="study_label",
        encrypted_key="study_label_encrypted",
        legacy_keys=["study_label"],
    )
    patient_reference = _decrypt_field(
        row,
        field_name="patient_reference",
        encrypted_key="patient_reference_encrypted",
        legacy_keys=["patient_reference", "reference_label"],
    )
    delegate_name = _decrypt_field(
        row,
        field_name="delegate_name",
        legacy_keys=["delegate_name"],
    )
    delegate_contact = _decrypt_field(
        row,
        field_name="delegate_contact",
        legacy_keys=["delegate_contact"],
    )
    pricing_disclosure = _decrypt_field(
        row,
        field_name="pricing_disclosure",
        legacy_keys=["pricing_disclosure"],
    )
    zelle_recipient_name = _decrypt_field(
        row,
        field_name="zelle_recipient_name",
        legacy_keys=["zelle_recipient_name"],
    )
    delegate_instructions = _decrypt_field(
        row,
        field_name="delegate_instructions",
        legacy_keys=["delegate_instructions"],
    )
    internal_physician_note = _decrypt_field(
        row,
        field_name="internal_physician_note",
        legacy_keys=["internal_physician_note"],
    )
    allowed_products = _parse_json(row.get("allowed_products_json")) or []
    if not isinstance(allowed_products, list):
        allowed_products = []
    product_scope_items = _parse_json(row.get("product_scope_items_json")) or []
    if not isinstance(product_scope_items, list):
        product_scope_items = []
    status = _derive_status(row)
    usage_count = int(row.get("usage_count") or 0)
    return {
        "token": _resolve_row_public_token(row, fallback=fallback_token),
        "tokenHint": row.get("token_hint") or None,
        "doctorId": row.get("doctor_id"),
        "patientId": subject_label,
        "patientReference": patient_reference,
        "referenceLabel": patient_reference or study_label,
        "label": patient_reference or study_label,
        "subjectLabel": subject_label,
        "studyLabel": study_label,
        "delegateName": delegate_name,
        "delegateContact": delegate_contact,
        "delegateRole": row.get("delegate_role") or None,
        "productScope": row.get("product_scope") or "all_physician_approved",
        "productScopeItems": product_scope_items,
        "delegatePermission": row.get("delegate_permission") or "submit_for_physician_review",
        "createdAt": _fmt_datetime(row.get("created_at")),
        "expiresAt": _fmt_datetime(row.get("expires_at")),
        "markupPercent": float(row.get("markup_percent") or 0.0),
        "pricingDisclosure": pricing_disclosure,
        "zelleRecipientName": zelle_recipient_name,
        "paymentConfirmationRequired": bool(int(row.get("payment_confirmation_required") if row.get("payment_confirmation_required") is not None else 1)),
        "delegateInstructions": delegate_instructions,
        "internalPhysicianNote": internal_physician_note,
        "termsVersion": row.get("terms_version") or None,
        "shippingPolicyVersion": row.get("shipping_policy_version") or None,
        "privacyPolicyVersion": row.get("privacy_policy_version") or None,
        "instructions": _decrypt_field(
            row,
            field_name="instructions",
            encrypted_key="instructions_encrypted",
            legacy_keys=["instructions"],
        ),
        "allowedProducts": allowed_products,
        "usageLimit": None,
        "usageCount": usage_count,
        "openCount": int(row.get("open_count") or 0),
        "status": status,
        "paymentMethod": row.get("payment_method") or None,
        "paymentInstructions": _decrypt_field(
            row,
            field_name="payment_instructions",
            encrypted_key="payment_instructions_encrypted",
            legacy_keys=["payment_instructions"],
        ),
        "physicianCertified": bool(int(row.get("physician_certified") or 0)),
        "receivedPayment": bool(int(row.get("received_payment") or 0)),
        "lastUsedAt": _fmt_datetime(row.get("last_used_at")),
        "lastOpenedAt": _fmt_datetime(row.get("last_opened_at")),
        "lastOrderAt": _fmt_datetime(row.get("last_order_at")),
        "revokedAt": _fmt_datetime(row.get("revoked_at")),
        "delegateCart": _decrypt_json_field(
            row,
            field_name="delegate_cart_json",
            encrypted_key="delegate_cart_encrypted",
            legacy_key="delegate_cart_json",
        ),
        "delegateShipping": _decrypt_json_field(
            row,
            field_name="delegate_shipping_json",
            encrypted_key="delegate_shipping_encrypted",
            legacy_key="delegate_shipping_json",
        ),
        "delegatePayment": _decrypt_json_field(
            row,
            field_name="delegate_payment_json",
            encrypted_key="delegate_payment_encrypted",
            legacy_key="delegate_payment_json",
        ),
        "delegateSharedAt": _fmt_datetime(row.get("delegate_shared_at")),
        "delegateOrderId": row.get("delegate_order_id"),
        "delegateReviewStatus": row.get("delegate_review_status"),
        "delegateReviewedAt": _fmt_datetime(row.get("delegate_reviewed_at")),
        "delegateReviewOrderId": row.get("delegate_review_order_id"),
        "delegateReviewNotes": _decrypt_field(
            row,
            field_name="delegate_review_notes",
            encrypted_key="delegate_review_notes_encrypted",
            legacy_keys=["delegate_review_notes"],
        ),
    }


def delete_expired() -> int:
    if not _using_mysql():
        return 0
    try:
        return int(
            mysql_client.execute(
                """
                UPDATE patient_links
                SET status = 'expired'
                WHERE expires_at IS NOT NULL
                  AND expires_at <= UTC_TIMESTAMP()
                  AND revoked_at IS NULL
                  AND COALESCE(status, 'active') <> 'expired'
                """,
            )
            or 0
        )
    except Exception:
        return 0


def create_link(
    doctor_id: str,
    *,
    reference_label: Optional[str] = None,
    patient_id: Optional[str] = None,
    subject_label: Optional[str] = None,
    study_label: Optional[str] = None,
    patient_reference: Optional[str] = None,
    delegate_name: Optional[str] = None,
    delegate_contact: Optional[str] = None,
    delegate_role: Optional[str] = None,
    product_scope: Optional[str] = None,
    product_scope_items: Optional[Any] = None,
    delegate_permission: Optional[str] = None,
    markup_percent: Optional[float] = None,
    pricing_disclosure: Optional[str] = None,
    zelle_recipient_name: Optional[str] = None,
    payment_confirmation_required: Optional[Any] = None,
    delegate_instructions: Optional[str] = None,
    internal_physician_note: Optional[str] = None,
    terms_version: Optional[str] = None,
    shipping_policy_version: Optional[str] = None,
    privacy_policy_version: Optional[str] = None,
    payment_method: Optional[str] = None,
    payment_instructions: Optional[str] = None,
    instructions: Optional[str] = None,
    allowed_products: Optional[Any] = None,
    expires_in_hours: Optional[int] = None,
    usage_limit: Optional[int] = None,
    physician_certified: Optional[Any] = None,
) -> Dict[str, Any]:
    if not _using_mysql():
        raise RuntimeError("MySQL backend is required for delegate links")
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        raise ValueError("doctor_id is required")

    subject_label_value = _normalize_optional_text(subject_label or patient_id)
    study_label_value = _normalize_optional_text(study_label)
    patient_reference_value = _normalize_optional_text(patient_reference or reference_label)
    delegate_name_value = _normalize_optional_text(delegate_name)
    delegate_contact_value = _normalize_optional_text(delegate_contact)
    delegate_role_value = _normalize_optional_text(delegate_role, max_len=64)
    product_scope_value = _normalize_optional_text(product_scope, max_len=64) or "all_physician_approved"
    product_scope_items_value = _normalize_allowed_products(product_scope_items)
    delegate_permission_value = _normalize_optional_text(delegate_permission, max_len=64) or "submit_for_physician_review"
    pricing_disclosure_value = _normalize_optional_text(pricing_disclosure, max_len=1000)
    zelle_recipient_name_value = _normalize_optional_text(zelle_recipient_name)
    payment_confirmation_required_value = 1 if _normalize_bool_flag(
        True if payment_confirmation_required is None else payment_confirmation_required
    ) else 0
    delegate_instructions_value = _normalize_optional_text(delegate_instructions, max_len=4000)
    internal_physician_note_value = _normalize_optional_text(internal_physician_note, max_len=4000)
    terms_version_value = _normalize_optional_text(terms_version, max_len=64)
    shipping_policy_version_value = _normalize_optional_text(shipping_policy_version, max_len=64)
    privacy_policy_version_value = _normalize_optional_text(privacy_policy_version, max_len=64)
    payment_method_value = _normalize_optional_text(payment_method, max_len=32)
    payment_instructions_value = _normalize_optional_text(payment_instructions, max_len=4000)
    physician_certified_value = 1 if _normalize_bool_flag(physician_certified) else 0
    instructions_value = _normalize_optional_text(instructions, max_len=4000)
    allowed_products_value = _normalize_allowed_products(allowed_products)
    usage_limit_value = None
    delete_expired()

    if markup_percent is None:
        markup_percent = 0.0
        try:
            from ..repositories import user_repository

            doctor = user_repository.find_by_id(doctor_id) or {}
            if isinstance(doctor, dict):
                markup_percent = float(doctor.get("markupPercent") or 0.0)
        except Exception:
            markup_percent = 0.0

    hours = _normalize_optional_int(expires_in_hours)

    for attempt in range(2):
        raw_token = str(uuid.uuid4())
        token_hash = _hash_token(raw_token)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(hours=hours) if hours is not None else None
        token_ciphertext = encrypt_text(raw_token, aad=_field_aad(token_hash, "token"))
        params = {
            "token": token_hash,
            "token_version": TOKEN_VERSION_HASHED,
            "token_ciphertext": token_ciphertext,
            "token_hint": raw_token.split("-")[0],
            "doctor_id": doctor_id,
            "patient_id": _encrypt_field(token_hash, "patient_id", subject_label_value),
            "reference_label": _encrypt_field(
                token_hash, "reference_label", patient_reference_value or study_label_value
            ),
            "subject_label": _encrypt_field(token_hash, "subject_label", subject_label_value),
            "study_label": _encrypt_field(token_hash, "study_label", study_label_value),
            "patient_reference": _encrypt_field(token_hash, "patient_reference", patient_reference_value),
            "delegate_name": _encrypt_field(token_hash, "delegate_name", delegate_name_value),
            "delegate_contact": _encrypt_field(token_hash, "delegate_contact", delegate_contact_value),
            "delegate_role": delegate_role_value,
            "product_scope": product_scope_value,
            "product_scope_items_json": _serialize_json(product_scope_items_value),
            "delegate_permission": delegate_permission_value,
            "created_at": now.replace(tzinfo=None),
            "expires_at": expires.replace(tzinfo=None) if isinstance(expires, datetime) else None,
            "markup_percent": float(markup_percent or 0.0),
            "pricing_disclosure": _encrypt_field(token_hash, "pricing_disclosure", pricing_disclosure_value),
            "zelle_recipient_name": _encrypt_field(token_hash, "zelle_recipient_name", zelle_recipient_name_value),
            "payment_confirmation_required": payment_confirmation_required_value,
            "delegate_instructions": _encrypt_field(token_hash, "delegate_instructions", delegate_instructions_value),
            "internal_physician_note": _encrypt_field(token_hash, "internal_physician_note", internal_physician_note_value),
            "terms_version": terms_version_value,
            "shipping_policy_version": shipping_policy_version_value,
            "privacy_policy_version": privacy_policy_version_value,
            "instructions": _encrypt_field(token_hash, "instructions", instructions_value),
            "allowed_products_json": _serialize_json(allowed_products_value),
            "usage_limit": usage_limit_value,
            "status": "active",
            "payment_method": payment_method_value,
            "payment_instructions": _encrypt_field(
                token_hash, "payment_instructions", payment_instructions_value
            ),
            "physician_certified": physician_certified_value,
        }
        try:
            mysql_client.execute(
                """
                INSERT INTO patient_links (
                    token, token_version, token_ciphertext, token_hint,
                    doctor_id, patient_id,
                    reference_label,
                    subject_label,
                    study_label,
                    patient_reference,
                    delegate_name,
                    delegate_contact,
                    delegate_role,
                    product_scope,
                    product_scope_items_json,
                    delegate_permission,
                    created_at, expires_at, markup_percent,
                    pricing_disclosure,
                    zelle_recipient_name,
                    payment_confirmation_required,
                    delegate_instructions,
                    internal_physician_note,
                    terms_version,
                    shipping_policy_version,
                    privacy_policy_version,
                    instructions, allowed_products_json,
                    usage_limit, usage_count, open_count, status,
                    payment_method, payment_instructions, physician_certified
                )
                VALUES (
                    %(token)s, %(token_version)s, %(token_ciphertext)s, %(token_hint)s,
                    %(doctor_id)s, %(patient_id)s,
                    %(reference_label)s,
                    %(subject_label)s,
                    %(study_label)s,
                    %(patient_reference)s,
                    %(delegate_name)s,
                    %(delegate_contact)s,
                    %(delegate_role)s,
                    %(product_scope)s,
                    %(product_scope_items_json)s,
                    %(delegate_permission)s,
                    %(created_at)s, %(expires_at)s, %(markup_percent)s,
                    %(pricing_disclosure)s,
                    %(zelle_recipient_name)s,
                    %(payment_confirmation_required)s,
                    %(delegate_instructions)s,
                    %(internal_physician_note)s,
                    %(terms_version)s,
                    %(shipping_policy_version)s,
                    %(privacy_policy_version)s,
                    %(instructions)s, %(allowed_products_json)s,
                    %(usage_limit)s, 0, 0, %(status)s,
                    %(payment_method)s, %(payment_instructions)s, %(physician_certified)s
                )
                """,
                params,
            )
            return {
                "token": raw_token,
                "tokenHint": params["token_hint"],
                "patientId": subject_label_value,
                "patientReference": patient_reference_value,
                "referenceLabel": patient_reference_value or study_label_value,
                "label": patient_reference_value or study_label_value,
                "subjectLabel": subject_label_value,
                "studyLabel": study_label_value,
                "delegateName": delegate_name_value,
                "delegateContact": delegate_contact_value,
                "delegateRole": delegate_role_value,
                "productScope": product_scope_value,
                "productScopeItems": product_scope_items_value,
                "delegatePermission": delegate_permission_value,
                "createdAt": now.isoformat(),
                "expiresAt": expires.isoformat() if isinstance(expires, datetime) else None,
                "markupPercent": float(markup_percent or 0.0),
                "pricingDisclosure": pricing_disclosure_value,
                "zelleRecipientName": zelle_recipient_name_value,
                "paymentConfirmationRequired": bool(payment_confirmation_required_value),
                "delegateInstructions": delegate_instructions_value,
                "internalPhysicianNote": internal_physician_note_value,
                "termsVersion": terms_version_value,
                "shippingPolicyVersion": shipping_policy_version_value,
                "privacyPolicyVersion": privacy_policy_version_value,
                "instructions": instructions_value,
                "allowedProducts": allowed_products_value,
                "usageLimit": usage_limit_value,
                "usageCount": 0,
                "openCount": 0,
                "status": "active",
                "paymentMethod": payment_method_value,
                "paymentInstructions": payment_instructions_value,
                "physicianCertified": bool(physician_certified_value),
                "receivedPayment": False,
                "lastUsedAt": None,
                "lastOpenedAt": None,
                "lastOrderAt": None,
                "revokedAt": None,
            }
        except Exception:
            if attempt >= 1:
                raise
            continue

    raise RuntimeError("Unable to create delegate link")


def list_links(doctor_id: str) -> List[Dict[str, Any]]:
    if not _using_mysql():
        return []
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return []
    delete_expired()
    rows = mysql_client.fetch_all(
        """
        SELECT *
        FROM patient_links
        WHERE doctor_id = %(doctor_id)s
        ORDER BY created_at DESC
        """,
        {"doctor_id": doctor_id},
    )
    return [_map_row(row) for row in (rows or [])]


def find_by_token(token: str, *, include_inactive: bool = False) -> Optional[Dict[str, Any]]:
    if not _using_mysql():
        return None
    normalized = str(token or "").strip()
    if not normalized:
        return None
    delete_expired()
    params = _lookup_params(normalized)
    row = mysql_client.fetch_one(
        """
        SELECT *
        FROM patient_links
        WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
        LIMIT 1
        """,
        params,
    )
    if not row:
        return None
    mapped = _map_row(row, fallback_token=normalized)
    if include_inactive:
        return mapped
    if str(mapped.get("revokedAt") or "").strip():
        return None
    if mapped.get("status") in ("revoked", "expired"):
        return None
    return mapped


def touch_last_used(token: str) -> None:
    if not _using_mysql():
        return
    normalized = str(token or "").strip()
    if not normalized:
        return
    try:
        mysql_client.execute(
            f"""
            UPDATE patient_links
            SET
                last_used_at = UTC_TIMESTAMP(),
                last_opened_at = UTC_TIMESTAMP(),
                open_count = COALESCE(open_count, 0) + 1
            WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
              AND {ACTIVE_LINK_SQL}
              AND revoked_at IS NULL
              AND COALESCE(status, 'active') NOT IN ('revoked', 'expired')
            """,
            _lookup_params(normalized),
        )
    except Exception:
        return


def update_link(
    doctor_id: str,
    token: str,
    *,
    reference_label: Optional[str] = None,
    patient_id: Optional[str] = None,
    subject_label: Optional[str] = None,
    study_label: Optional[str] = None,
    patient_reference: Optional[str] = None,
    delegate_name: Optional[str] = None,
    delegate_contact: Optional[str] = None,
    delegate_role: Optional[str] = None,
    product_scope: Optional[str] = None,
    product_scope_items: Optional[Any] = None,
    delegate_permission: Optional[str] = None,
    revoke: Optional[bool] = None,
    markup_percent: Optional[float] = None,
    pricing_disclosure: Optional[str] = None,
    zelle_recipient_name: Optional[str] = None,
    payment_confirmation_required: Optional[Any] = None,
    delegate_instructions: Optional[str] = None,
    internal_physician_note: Optional[str] = None,
    terms_version: Optional[str] = None,
    shipping_policy_version: Optional[str] = None,
    privacy_policy_version: Optional[str] = None,
    payment_method: Optional[str] = None,
    payment_instructions: Optional[str] = None,
    instructions: Optional[str] = None,
    allowed_products: Optional[Any] = None,
    expires_in_hours: Optional[int] = None,
    usage_limit: Optional[Any] = None,
    received_payment: Optional[object] = None,
) -> Optional[Dict[str, Any]]:
    if not _using_mysql():
        return None
    doctor_id = str(doctor_id or "").strip()
    raw_token = str(token or "").strip()
    if not doctor_id or not raw_token:
        return None

    updates: list[str] = []
    params: Dict[str, Any] = {"doctor_id": doctor_id, **_lookup_params(raw_token)}
    token_hash = str(params.get("hashed_token") or "").strip() or None

    next_subject_label = subject_label if subject_label is not None else patient_id
    next_patient_reference = patient_reference if patient_reference is not None else reference_label

    if next_subject_label is not None:
        subject_label_value = _normalize_optional_text(next_subject_label)
        updates.extend(
            [
                "subject_label = %(subject_label)s",
                "patient_id = %(patient_id)s",
            ]
        )
        params["subject_label"] = _encrypt_field(token_hash, "subject_label", subject_label_value)
        params["patient_id"] = _encrypt_field(token_hash, "patient_id", subject_label_value)

    if study_label is not None:
        study_label_value = _normalize_optional_text(study_label)
        updates.append("study_label = %(study_label)s")
        params["study_label"] = _encrypt_field(token_hash, "study_label", study_label_value)

    if next_patient_reference is not None:
        patient_reference_value = _normalize_optional_text(next_patient_reference)
        updates.extend(
            [
                "patient_reference = %(patient_reference)s",
                "reference_label = %(reference_label)s",
            ]
        )
        params["patient_reference"] = _encrypt_field(
            token_hash, "patient_reference", patient_reference_value
        )
        params["reference_label"] = _encrypt_field(
            token_hash, "reference_label", patient_reference_value
        )

    if delegate_name is not None:
        params["delegate_name"] = _encrypt_field(
            token_hash, "delegate_name", _normalize_optional_text(delegate_name)
        )
        updates.append("delegate_name = %(delegate_name)s")

    if delegate_contact is not None:
        params["delegate_contact"] = _encrypt_field(
            token_hash, "delegate_contact", _normalize_optional_text(delegate_contact)
        )
        updates.append("delegate_contact = %(delegate_contact)s")

    if delegate_role is not None:
        params["delegate_role"] = _normalize_optional_text(delegate_role, max_len=64)
        updates.append("delegate_role = %(delegate_role)s")

    if product_scope is not None:
        params["product_scope"] = _normalize_optional_text(product_scope, max_len=64)
        updates.append("product_scope = %(product_scope)s")

    if product_scope_items is not None:
        params["product_scope_items_json"] = _serialize_json(_normalize_allowed_products(product_scope_items))
        updates.append("product_scope_items_json = %(product_scope_items_json)s")

    if delegate_permission is not None:
        params["delegate_permission"] = _normalize_optional_text(delegate_permission, max_len=64)
        updates.append("delegate_permission = %(delegate_permission)s")

    if revoke is True:
        updates.extend(["revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP())", "status = 'revoked'"])
    elif revoke is False:
        updates.extend(
            [
                "revoked_at = NULL",
                "status = 'active'",
            ]
        )

    if markup_percent is not None:
        updates.append("markup_percent = %(markup_percent)s")
        params["markup_percent"] = float(markup_percent or 0.0)

    if pricing_disclosure is not None:
        params["pricing_disclosure"] = _encrypt_field(
            token_hash, "pricing_disclosure", _normalize_optional_text(pricing_disclosure, max_len=1000)
        )
        updates.append("pricing_disclosure = %(pricing_disclosure)s")

    if zelle_recipient_name is not None:
        params["zelle_recipient_name"] = _encrypt_field(
            token_hash, "zelle_recipient_name", _normalize_optional_text(zelle_recipient_name)
        )
        updates.append("zelle_recipient_name = %(zelle_recipient_name)s")

    if payment_confirmation_required is not None:
        params["payment_confirmation_required"] = 1 if _normalize_bool_flag(payment_confirmation_required) else 0
        updates.append("payment_confirmation_required = %(payment_confirmation_required)s")

    if delegate_instructions is not None:
        params["delegate_instructions"] = _encrypt_field(
            token_hash,
            "delegate_instructions",
            _normalize_optional_text(delegate_instructions, max_len=4000),
        )
        updates.append("delegate_instructions = %(delegate_instructions)s")

    if internal_physician_note is not None:
        params["internal_physician_note"] = _encrypt_field(
            token_hash,
            "internal_physician_note",
            _normalize_optional_text(internal_physician_note, max_len=4000),
        )
        updates.append("internal_physician_note = %(internal_physician_note)s")

    if terms_version is not None:
        params["terms_version"] = _normalize_optional_text(terms_version, max_len=64)
        updates.append("terms_version = %(terms_version)s")

    if shipping_policy_version is not None:
        params["shipping_policy_version"] = _normalize_optional_text(shipping_policy_version, max_len=64)
        updates.append("shipping_policy_version = %(shipping_policy_version)s")

    if privacy_policy_version is not None:
        params["privacy_policy_version"] = _normalize_optional_text(privacy_policy_version, max_len=64)
        updates.append("privacy_policy_version = %(privacy_policy_version)s")

    if payment_method is not None:
        params["payment_method"] = _normalize_optional_text(payment_method, max_len=32)
        updates.append("payment_method = %(payment_method)s")

    if payment_instructions is not None:
        params["payment_instructions"] = _encrypt_field(
            token_hash,
            "payment_instructions",
            _normalize_optional_text(payment_instructions, max_len=4000),
        )
        updates.append("payment_instructions = %(payment_instructions)s")

    if instructions is not None:
        params["instructions"] = _encrypt_field(
            token_hash, "instructions", _normalize_optional_text(instructions, max_len=4000)
        )
        updates.append("instructions = %(instructions)s")

    if allowed_products is not None:
        params["allowed_products_json"] = _serialize_json(_normalize_allowed_products(allowed_products))
        updates.append("allowed_products_json = %(allowed_products_json)s")

    if expires_in_hours is not None:
        hours = _normalize_optional_int(expires_in_hours)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=hours) if hours is not None else None
        params["expires_at"] = expires_at.replace(tzinfo=None) if isinstance(expires_at, datetime) else None
        updates.append("expires_at = %(expires_at)s")

    if received_payment is not None:
        value: Optional[int] = None
        if isinstance(received_payment, bool):
            value = 1 if received_payment else 0
        elif isinstance(received_payment, (int, float)):
            value = 1 if int(received_payment) == 1 else 0
        elif isinstance(received_payment, str):
            normalized_value = received_payment.strip().lower()
            if normalized_value in ("1", "true", "yes", "y", "paid"):
                value = 1
            elif normalized_value in ("0", "false", "no", "n", "unpaid"):
                value = 0
        if value is not None:
            updates.append("received_payment = %(received_payment)s")
            params["received_payment"] = value

    if updates:
        delete_expired()
        mysql_client.execute(
            f"""
            UPDATE patient_links
            SET {", ".join(updates)}
            WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
              AND doctor_id = %(doctor_id)s
            """,
            params,
        )

    row = mysql_client.fetch_one(
        """
        SELECT *
        FROM patient_links
        WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
          AND doctor_id = %(doctor_id)s
        """,
        params,
    )
    if not row:
        return None
    return _map_row(row, fallback_token=raw_token)


def delete_link(doctor_id: str, token: str) -> bool:
    if not _using_mysql():
        return False
    doctor_id = str(doctor_id or "").strip()
    raw_token = str(token or "").strip()
    if not doctor_id or not raw_token:
        return False

    existing = mysql_client.fetch_one(
        """
        SELECT revoked_at
        FROM patient_links
        WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
          AND doctor_id = %(doctor_id)s
        LIMIT 1
        """,
        {"doctor_id": doctor_id, **_lookup_params(raw_token)},
    )
    if not existing or not existing.get("revoked_at"):
        return False

    result = mysql_client.execute(
        """
        DELETE FROM patient_links
        WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
          AND doctor_id = %(doctor_id)s
          AND revoked_at IS NOT NULL
        """,
        {"doctor_id": doctor_id, **_lookup_params(raw_token)},
    )
    if isinstance(result, (int, float)):
        return bool(int(result))
    if isinstance(result, dict):
        return bool(result.get("affectedRows") or 0)
    return bool(getattr(result, "rowcount", 0))


def get_doctor_markup_percent(doctor_id: str) -> float:
    if not _using_mysql():
        return 0.0
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return 0.0
    delete_expired()
    try:
        row = mysql_client.fetch_one(
            f"""
            SELECT markup_percent
            FROM patient_links
            WHERE doctor_id = %(doctor_id)s
              AND {ACTIVE_LINK_SQL}
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"doctor_id": doctor_id},
        )
        return float((row or {}).get("markup_percent") or 0.0)
    except Exception:
        return 0.0


def set_doctor_markup_percent(doctor_id: str, markup_percent: float) -> int:
    if not _using_mysql():
        return 0
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return 0
    delete_expired()
    try:
        return int(
            mysql_client.execute(
                f"""
                UPDATE patient_links
                SET markup_percent = %(markup_percent)s
                WHERE doctor_id = %(doctor_id)s
                  AND {ACTIVE_LINK_SQL}
                """,
                {"doctor_id": doctor_id, "markup_percent": float(markup_percent or 0.0)},
            )
            or 0
        )
    except Exception:
        return 0


def store_delegate_payload(
    token: str,
    *,
    cart: Any,
    shipping: Any,
    payment: Any,
    order_id: Optional[str] = None,
    shared_at: Optional[datetime] = None,
) -> bool:
    if not _using_mysql():
        return False
    normalized = str(token or "").strip()
    if not normalized:
        return False
    delete_expired()
    when = shared_at.astimezone(timezone.utc) if isinstance(shared_at, datetime) else datetime.now(timezone.utc)
    try:
        affected = mysql_client.execute(
            f"""
            UPDATE patient_links
            SET
                delegate_cart_json = %(cart)s,
                delegate_shipping_json = %(shipping)s,
                delegate_payment_json = %(payment)s,
                delegate_shared_at = %(shared_at)s,
                delegate_order_id = COALESCE(%(order_id)s, delegate_order_id),
                delegate_review_status = 'pending',
                delegate_reviewed_at = NULL,
                delegate_review_order_id = NULL,
                delegate_review_notes = NULL,
                last_used_at = UTC_TIMESTAMP(),
                last_order_at = %(shared_at)s,
                usage_count = COALESCE(usage_count, 0) + 1,
                status = CASE
                    WHEN revoked_at IS NOT NULL THEN 'revoked'
                    ELSE 'active'
                END
            WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
              AND {ACTIVE_LINK_SQL}
            """,
            {
                **_lookup_params(normalized),
                "cart": encrypt_json(
                    cart,
                    aad=_field_aad(_hash_token(normalized), "delegate_cart_json"),
                ),
                "shipping": encrypt_json(
                    shipping,
                    aad=_field_aad(_hash_token(normalized), "delegate_shipping_json"),
                ),
                "payment": encrypt_json(
                    payment,
                    aad=_field_aad(_hash_token(normalized), "delegate_payment_json"),
                ),
                "shared_at": when.replace(tzinfo=None),
                "order_id": str(order_id).strip() if order_id is not None and str(order_id).strip() else None,
            },
        )
        return int(affected or 0) > 0
    except Exception:
        return False


def set_delegate_review_status(
    doctor_id: str,
    token: str,
    *,
    status: str,
    order_id: Optional[str] = None,
    notes: Optional[str] = None,
    delegate_payment: Optional[Any] = None,
    reviewed_at: Optional[datetime] = None,
) -> bool:
    if not _using_mysql():
        return False
    doctor_id = str(doctor_id or "").strip()
    normalized = str(token or "").strip()
    if not doctor_id or not normalized:
        return False
    normalized_status = str(status or "").strip().lower()
    allowed = {"pending", "accepted", "modified", "rejected"}
    if normalized_status not in allowed:
        return False
    when = reviewed_at.astimezone(timezone.utc) if isinstance(reviewed_at, datetime) else datetime.now(timezone.utc)
    try:
        updates = [
            "delegate_review_status = %(status)s",
            "delegate_reviewed_at = %(reviewed_at)s",
            "delegate_review_order_id = %(order_id)s",
            "delegate_review_notes = %(notes)s",
        ]
        params: Dict[str, Any] = {
            **_lookup_params(normalized),
            "doctor_id": doctor_id,
            "status": normalized_status,
            "reviewed_at": when.replace(tzinfo=None),
            "order_id": str(order_id).strip() if order_id is not None and str(order_id).strip() else None,
            "notes": _encrypt_field(
                _hash_token(normalized),
                "delegate_review_notes",
                _normalize_optional_text(notes, max_len=4000),
            ),
        }
        if delegate_payment is not None:
            updates.append("delegate_payment_json = %(delegate_payment)s")
            params["delegate_payment"] = encrypt_json(
                delegate_payment,
                aad=_field_aad(_hash_token(normalized), "delegate_payment_json"),
            )
        affected = mysql_client.execute(
            f"""
            UPDATE patient_links
            SET
                {", ".join(updates)}
            WHERE (token = %(hashed_token)s OR token = %(raw_token)s)
              AND doctor_id = %(doctor_id)s
            """,
            params,
        )
        return int(affected or 0) > 0
    except Exception:
        return False


def insert_audit_event(
    *,
    token: Optional[str] = None,
    token_hash: Optional[str] = None,
    doctor_id: Optional[str] = None,
    actor_user_id: Optional[str] = None,
    actor_role: Optional[str] = None,
    event_type: str,
    resource_ref: Optional[str] = None,
    purpose: Optional[str] = None,
    result: Optional[str] = None,
    request_ip: Optional[str] = None,
    device_info: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> bool:
    if not _using_mysql():
        return False
    event_name = str(event_type or "").strip().lower()
    if not event_name:
        return False
    resolved_token_hash = str(token_hash or "").strip()
    if not resolved_token_hash:
        raw_token = str(token or "").strip()
        if not raw_token:
            return False
        resolved_token_hash = _hash_token(raw_token)
    try:
        mysql_client.execute(
            """
            INSERT INTO patient_link_audit_events (
                patient_link_token, doctor_id, actor_user_id, actor_role, event_type,
                resource_ref, purpose, result, request_ip, device_info, event_payload_json
            ) VALUES (
                %(patient_link_token)s, %(doctor_id)s, %(actor_user_id)s, %(actor_role)s, %(event_type)s,
                %(resource_ref)s, %(purpose)s, %(result)s, %(request_ip)s, %(device_info)s, %(event_payload_json)s
            )
            """,
            {
                "patient_link_token": resolved_token_hash,
                "doctor_id": _normalize_optional_text(doctor_id, max_len=32),
                "actor_user_id": _normalize_optional_text(actor_user_id, max_len=32),
                "actor_role": _normalize_optional_text(actor_role, max_len=64),
                "event_type": event_name[:64],
                "resource_ref": _normalize_optional_text(resource_ref or resolved_token_hash, max_len=128),
                "purpose": _normalize_optional_text(purpose, max_len=64),
                "result": _normalize_optional_text(result, max_len=32),
                "request_ip": _normalize_optional_text(request_ip, max_len=64),
                "device_info": _normalize_optional_text(device_info, max_len=255),
                "event_payload_json": _serialize_json(payload or {}),
            },
        )
        return True
    except Exception:
        return False
