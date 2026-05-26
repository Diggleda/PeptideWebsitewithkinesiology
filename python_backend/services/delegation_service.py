from __future__ import annotations

import json
import logging
import re
import secrets
import threading
import math
import hashlib
import hmac
from datetime import timedelta
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from ..database import mysql_client
from ..repositories import order_repository
from ..repositories import patient_links_repository
from ..repositories import user_repository
from ..services import email_service
from ..services import get_config
from ..services import settings_service  # type: ignore[attr-defined]
from ..storage import settings_store

logger = logging.getLogger(__name__)

_LINKS_KEY_PREFIX = "delegation_links_v1:"
_CONFIG_KEY_PREFIX = "delegation_config_v1:"
_INDEX_KEY = "delegation_link_index_v1"
_LEGACY_MIGRATED = False
_LEGACY_MIGRATION_LOCK = threading.Lock()
DEFAULT_DELEGATE_LINK_EXPIRY_HOURS = 72
MAX_DELEGATE_LINK_EXPIRY_HOURS = 168
MAX_BROCHURE_LINK_EXPIRY_HOURS = 10_000
DEFAULT_DELEGATE_USAGE_LIMIT = 1
DEFAULT_PRICING_DISCLOSURE = (
    "Prices may include physician-directed service, handling, administrative, or research coordination fees."
)
ALLOWED_PRODUCT_SCOPES = {
    "all_physician_approved",
    "specific_cart_only",
    "specific_products",
    "category_or_protocol",
}
ENABLED_PRODUCT_SCOPES = {
    "all_physician_approved",
    "specific_cart_only",
    "specific_products",
}
ALLOWED_DELEGATE_PERMISSIONS = {
    "view_products_only",
    "build_cart_only",
    "submit_payment_info_only",
    "submit_for_physician_review",
    "direct_checkout",
}
ENABLED_DELEGATE_PERMISSIONS = {
    "view_products_only",
    "submit_for_physician_review",
}
RESTRICTED_LEGACY_DELEGATE_PERMISSIONS = {
    "build_cart_only",
    "submit_payment_info_only",
    "direct_checkout",
}
DEFAULT_PRODUCT_SCOPE = "all_physician_approved"
DEFAULT_DELEGATE_PERMISSION = "submit_for_physician_review"
SUPPORTED_LINK_TYPES = {"delegate", "brochure"}
BROCHURE_PERMISSION = "view_products_only"
BROCHURE_CAPABILITIES = {
    "canViewProducts": True,
    "canViewPricing": False,
    "canAddToCart": False,
    "canCheckout": False,
    "canSubmitProposal": False,
    "canViewCOA": True,
    "canViewInventory": False,
}
DELEGATE_CAPABILITIES = {
    "canViewProducts": True,
    "canViewPricing": True,
    "canAddToCart": True,
    "canCheckout": False,
    "canSubmitProposal": True,
    "canViewCOA": True,
    "canViewInventory": True,
}
_PHI_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), "SSN"),
    (re.compile(r"\b(?:dob|date of birth)\b", re.IGNORECASE), "DOB"),
    (re.compile(r"\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b"), "date"),
    (re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE), "email"),
    (re.compile(r"(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}"), "phone"),
)
_PROHIBITED_RESEARCH_TERMS = (
    "prescription",
    "prescribe",
    "dosage",
    "dose",
    "dosing",
    "therapy",
    "treatment",
    "treat",
    "patient instructions",
    "consume",
    "ingest",
)
_AUDIT_BLOCKED_KEY_FRAGMENTS = (
    "patient",
    "subject",
    "study",
    "reference",
    "label",
    "name",
    "email",
    "phone",
    "address",
    "instruction",
    "note",
    "payment",
    "shipping",
    "cart",
)


def _using_mysql() -> bool:
    try:
        return bool(get_config().mysql.get("enabled"))
    except Exception:
        return False


def _normalize_token(value: object) -> str:
    token = str(value or "").strip()
    return token


def _normalize_markup_percent(value: object) -> float:
    try:
        percent = float(value)
    except Exception:
        percent = 0.0
    if not (percent == percent):  # NaN
        percent = 0.0
    percent = max(0.0, min(percent, 500.0))
    return round(percent + 1e-9, 2)


def _patient_link_settings() -> Dict[str, Any]:
    try:
        return settings_service.get_settings() or {}
    except Exception:
        return {}


def _patient_link_default_expiry_hours() -> Optional[int]:
    return DEFAULT_DELEGATE_LINK_EXPIRY_HOURS


def _patient_link_max_markup_percent() -> float:
    try:
        value = float(_patient_link_settings().get("patientLinkMaxMarkupPercent") or 20.0)
    except Exception:
        value = 20.0
    return max(0.0, min(value, 100.0))


def _normalize_capped_markup_percent(value: object) -> float:
    return min(_normalize_markup_percent(value), _patient_link_max_markup_percent())


def _doctor_default_markup_percent(doctor_id: str) -> float:
    try:
        return _normalize_capped_markup_percent(get_doctor_config(doctor_id).get("markupPercent"))
    except Exception:
        logger.debug(
            "[Delegation] Unable to load doctor markup default for doctor_id=%s",
            doctor_id,
            exc_info=True,
        )
        return 0.0


def _normalize_usage_limit(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        parsed = int(float(value))
    except Exception:
        return None
    return max(1, min(parsed, 10_000))


def _normalize_link_limit(
    value: Any,
    *,
    field_name: str,
    default: int,
    allow_missing: bool = True,
    max_value: int = MAX_DELEGATE_LINK_EXPIRY_HOURS,
) -> int:
    if value is None or value == "":
        if allow_missing:
            return default
        err = ValueError(f"{field_name} is required")
        setattr(err, "status", 400)
        raise err
    try:
        parsed = int(float(value))
    except Exception:
        err = ValueError(f"{field_name} must be a positive number")
        setattr(err, "status", 400)
        raise err
    if parsed <= 0:
        err = ValueError(f"{field_name} must be greater than zero")
        setattr(err, "status", 400)
        raise err
    if parsed > max_value:
        err = ValueError(f"{field_name} cannot exceed {max_value} hours")
        setattr(err, "status", 400)
        raise err
    return max(1, parsed)


def _normalize_optional_link_limit(
    value: Any,
    *,
    field_name: str,
    max_value: int = MAX_DELEGATE_LINK_EXPIRY_HOURS,
) -> Optional[int]:
    if value is None or value == "":
        return None
    return _normalize_link_limit(
        value,
        field_name=field_name,
        default=1,
        allow_missing=False,
        max_value=max_value,
    )


def _normalize_choice(value: Any, *, allowed: set[str], default: str, enabled: Optional[set[str]] = None) -> str:
    normalized = str(value or "").strip().lower()
    if normalized not in allowed:
        return default
    if enabled is not None and normalized not in enabled:
        return default
    return normalized


def _normalize_product_scope(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if not normalized:
        return DEFAULT_PRODUCT_SCOPE
    if normalized in ALLOWED_PRODUCT_SCOPES and normalized not in ENABLED_PRODUCT_SCOPES:
        err = ValueError("This product scope is not enabled for delegate links.")
        setattr(err, "status", 400)
        raise err
    return normalized if normalized in ENABLED_PRODUCT_SCOPES else DEFAULT_PRODUCT_SCOPE


def _normalize_delegate_permission(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in RESTRICTED_LEGACY_DELEGATE_PERMISSIONS:
        return "view_products_only"
    return _normalize_choice(
        value,
        allowed=ALLOWED_DELEGATE_PERMISSIONS,
        enabled=ENABLED_DELEGATE_PERMISSIONS,
        default=DEFAULT_DELEGATE_PERMISSION,
    )


def _normalize_link_type(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in SUPPORTED_LINK_TYPES else "delegate"


def capabilities_for_link_type(value: Any) -> Dict[str, bool]:
    return dict(BROCHURE_CAPABILITIES if _normalize_link_type(value) == "brochure" else DELEGATE_CAPABILITIES)


def _patient_link_hmac_secret() -> bytes:
    try:
        config = get_config()
        encryption = getattr(config, "encryption", {}) or {}
        candidates = [
            encryption.get("blind_index_key") if isinstance(encryption, dict) else None,
            encryption.get("key") if isinstance(encryption, dict) else None,
            getattr(config, "jwt_secret", None),
        ]
    except Exception:
        candidates = []
    for candidate in candidates:
        text = str(candidate or "").strip()
        if text:
            return text.encode("utf-8")
    return b"local-delegate-link-hmac-secret"


def _hmac_sha256(value: Any, *, label: str) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    return hmac.new(
        _patient_link_hmac_secret(),
        f"{label}:{text}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def _link_token_hint(token: Any, link: Optional[Dict[str, Any]] = None) -> Optional[str]:
    if isinstance(link, dict):
        existing = str(link.get("tokenHint") or link.get("token_hint") or "").strip()
        if existing:
            return existing[:16]
    text = str(token or "").strip()
    if not text:
        return None
    first_segment = text.split("-", 1)[0].strip()
    return (first_segment or text)[:16]


def safe_link_token_metadata(
    token: Any,
    link: Optional[Dict[str, Any]] = None,
    *,
    doctor_id: Any = None,
    link_type: Any = None,
) -> Dict[str, Any]:
    token_hash = _hmac_sha256(token, label="delegate-link-token")
    metadata: Dict[str, Any] = {}
    token_hint = _link_token_hint(token, link)
    if token_hint:
        metadata["tokenHint"] = token_hint
    if token_hash:
        metadata["tokenHash"] = token_hash
    resolved_link_type = str(
        link_type
        or ((link or {}).get("linkType") if isinstance(link, dict) else None)
        or ((link or {}).get("link_type") if isinstance(link, dict) else None)
        or ""
    ).strip().lower()
    if resolved_link_type:
        metadata["linkType"] = _normalize_link_type(resolved_link_type)
    resolved_doctor_id = str(
        doctor_id
        or ((link or {}).get("doctorId") if isinstance(link, dict) else None)
        or ((link or {}).get("doctor_id") if isinstance(link, dict) else None)
        or ""
    ).strip()
    if resolved_doctor_id:
        metadata["doctorId"] = resolved_doctor_id
    return metadata


def _hash_public_view_value(value: Any) -> Optional[str]:
    return _hmac_sha256(value, label="delegate-public-view")


def _usage_limit_for_link(link_type: Any, value: Any = None) -> Optional[int]:
    if _normalize_link_type(link_type) == "brochure":
        return None
    return _normalize_usage_limit(value) or DEFAULT_DELEGATE_USAGE_LIMIT


def _expiry_max_for_link_type(link_type: Any) -> int:
    return MAX_BROCHURE_LINK_EXPIRY_HOURS if _normalize_link_type(link_type) == "brochure" else MAX_DELEGATE_LINK_EXPIRY_HOURS


def _link_usage_limit_for_response(link: Optional[Dict[str, Any]]) -> Optional[int]:
    if not isinstance(link, dict):
        return None
    return _usage_limit_for_link(link.get("linkType") or link.get("link_type"), link.get("usageLimit"))


def _require_explicit_product_scope(product_scope: str, *product_lists: Any) -> None:
    if product_scope not in {"specific_products", "specific_cart_only", "category_or_protocol"}:
        return
    allowed: List[str] = []
    for product_list in product_lists:
        allowed.extend(_normalize_allowed_products(product_list))
    if allowed:
        return
    err = ValueError("This link has no approved product scope.")
    setattr(err, "status", 403)
    raise err


def _normalize_delegate_role(value: Any) -> Optional[str]:
    normalized = str(value or "").strip().lower().replace(" ", "_").replace("-", "_")
    allowed = {
        "patient",
        "caregiver",
        "staff",
        "research_participant",
        "authorized_representative",
        "other",
    }
    return normalized if normalized in allowed else None


def _normalize_bool(value: Any, *, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return int(value) == 1
    normalized = str(value or "").strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _validate_sensitive_session_text(value: Optional[str], *, field_name: str, max_len: int = 4000) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return _validate_research_note(text[:max_len], field_name=field_name, max_len=max_len)


def _validate_policy_version(value: Optional[str], *, field_name: str) -> Optional[str]:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    return normalized[:64]


def _normalize_currency_amount(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except Exception:
        return None
    if not math.isfinite(parsed):
        return None
    return round(max(0.0, parsed) + 1e-9, 2)


def _normalize_currency_code(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    normalized = value.strip().upper()
    if not normalized:
        return None
    if not re.fullmatch(r"[A-Z]{3}", normalized):
        return None
    return normalized


def _normalize_allowed_products(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, str):
        items = [part.strip() for part in value.replace("\n", ",").split(",")]
    elif isinstance(value, (list, tuple, set)):
        items = [str(part or "").strip() for part in value]
    else:
        items = [str(value).strip()]
    seen: set[str] = set()
    normalized: List[str] = []
    for item in items:
        if not item:
            continue
        token = item.upper()
        if token in seen:
            continue
        seen.add(token)
        normalized.append(token)
    return normalized


def _validate_non_phi_label(value: Optional[str], *, field_name: str, max_len: int = 190) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    text = text[:max_len]
    for pattern, label in _PHI_PATTERNS:
        if pattern.search(text):
            err = ValueError(f"{field_name} must not contain PHI ({label}). Use a study or subject code instead.")
            setattr(err, "status", 400)
            raise err
    return text


def _validate_research_note(value: Optional[str], *, field_name: str, max_len: int = 4000) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    lowered = text.lower()
    for term in _PROHIBITED_RESEARCH_TERMS:
        if term in lowered:
            err = ValueError(
                f"{field_name} cannot include prescription, dosing, treatment, therapy, or consumption instructions."
            )
            setattr(err, "status", 400)
            raise err
    return text[:max_len]


def _validate_delegate_review_notes(value: Optional[str]) -> Optional[str]:
    sanitized = _validate_non_phi_label(value, field_name="reviewNotes", max_len=4000)
    return _validate_research_note(sanitized, field_name="reviewNotes", max_len=4000)


def _compensation_disclosure(markup_percent: object) -> str:
    if _normalize_markup_percent(markup_percent) > 0:
        return "Your physician receives compensation from this transaction."
    return "Your physician does not receive compensation from this TrufusionLabs transaction."


def _delegate_proposal_review_status(link: Optional[Dict[str, Any]]) -> Optional[str]:
    if not isinstance(link, dict):
        return None
    review_status = (
        str(link.get("delegateReviewStatus") or "").strip().lower()
        if isinstance(link.get("delegateReviewStatus"), str)
        else None
    )
    if review_status:
        return review_status
    return "pending" if str(link.get("delegateSharedAt") or "").strip() else None


def _link_display_name(link: Optional[Dict[str, Any]]) -> Optional[str]:
    if not isinstance(link, dict):
        return None
    for key in (
        "linkName",
        "link_name",
        "brochureName",
        "brochure_name",
        "subjectLabel",
        "subject_label",
        "referenceLabel",
        "label",
    ):
        value = str(link.get(key) or "").strip()
        if value:
            return value
    return None


def _delegate_proposal_label(link: Optional[Dict[str, Any]]) -> str:
    if not isinstance(link, dict):
        return "Delegate proposal"
    return (
        _link_display_name(link)
        or str(link.get("patientReference") or "").strip()
        or str(link.get("studyLabel") or "").strip()
        or str(link.get("subjectLabel") or "").strip()
        or "Delegate proposal"
    )


def _send_delegate_proposal_ready_email_for_link(
    token: str,
    link: Optional[Dict[str, Any]],
    *,
    submitted_at: Optional[datetime] = None,
) -> bool:
    token = _normalize_token(token)
    candidate = link if isinstance(link, dict) else None
    if _delegate_proposal_review_status(candidate) != "pending" and token:
        candidate = patient_links_repository.find_by_token(token, include_inactive=True) or candidate

    if _delegate_proposal_review_status(candidate) != "pending":
        return False

    doctor_id = str((candidate or {}).get("doctorId") or "").strip()
    if not doctor_id:
        return False

    try:
        doctor = user_repository.find_by_id(doctor_id) or {}
        if not _normalize_bool(
            doctor.get("receivePatientLinkUpdateEmails")
            if "receivePatientLinkUpdateEmails" in doctor
            else doctor.get("receive_patient_link_update_emails"),
            default=True,
        ):
            logger.info(
                "[Delegation] Skipping delegate proposal email by physician preference",
                extra={**safe_link_token_metadata(token, candidate, doctor_id=doctor_id), "doctorId": doctor_id},
            )
            return False
        recipient = str(doctor.get("email") or "").strip()
        if not recipient:
            logger.warning(
                "[Delegation] Delegate proposal awaiting review has no physician email",
                extra={**safe_link_token_metadata(token, candidate, doctor_id=doctor_id), "doctorId": doctor_id},
            )
            return False

        email_service.send_delegate_proposal_ready_email(
            recipient,
            doctor_name=str(doctor.get("name") or "").strip() or None,
            proposal_label=_delegate_proposal_label(candidate),
            submitted_at=submitted_at,
        )
        _audit_event(
            "proposal_ready_email_sent",
            token=token,
            doctor_id=doctor_id,
            payload={"proposalStatus": "pending"},
        )
        return True
    except Exception:
        logger.exception(
            "[Delegation] Failed to send delegate proposal ready email",
            extra={**safe_link_token_metadata(token, candidate, doctor_id=doctor_id), "doctorId": doctor_id},
        )
        return False


def _research_supply_disclosures(markup_percent: object) -> List[str]:
    return [
        "TrufusionLabs provides research materials only. Products are not intended for human consumption.",
        "TrufusionLabs does not provide prescriptions, treatment, dosing, therapy, or patient instructions.",
        "Physicians are responsible for any independent research protocols.",
        "TrufusionLabs does not direct or control physician activities.",
        _compensation_disclosure(markup_percent),
    ]


def _brochure_disclosures() -> List[str]:
    return _research_supply_disclosures(0)[:-1]


def _audit_key_is_blocked(key: object) -> bool:
    normalized = str(key or "").strip().lower()
    if not normalized:
        return False
    return any(fragment in normalized for fragment in _AUDIT_BLOCKED_KEY_FRAGMENTS)


def _sanitize_audit_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        try:
            numeric = float(value)
        except Exception:
            return None
        if not math.isfinite(numeric):
            return None
        if isinstance(value, int):
            return value
        return round(numeric, 4)
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat() if value.tzinfo else value.replace(tzinfo=timezone.utc).isoformat()
    if isinstance(value, str):
        text = value.strip()
        return text[:255] if text else None
    if isinstance(value, dict):
        sanitized: Dict[str, Any] = {}
        for key, nested in value.items():
            if _audit_key_is_blocked(key):
                continue
            nested_value = _sanitize_audit_value(nested)
            if nested_value in (None, "", [], {}):
                continue
            sanitized[str(key)] = nested_value
        return sanitized
    if isinstance(value, (list, tuple, set)):
        items: List[Any] = []
        for entry in value:
            sanitized_entry = _sanitize_audit_value(entry)
            if sanitized_entry in (None, "", [], {}):
                continue
            items.append(sanitized_entry)
            if len(items) >= 25:
                break
        return items
    return None


def _sanitize_audit_payload(payload: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    sanitized = _sanitize_audit_value(payload)
    return sanitized if isinstance(sanitized, dict) else {}


def _audit_event(
    event_type: str,
    *,
    token: Optional[str] = None,
    doctor_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
) -> None:
    try:
        from flask import g, request
    except Exception:
        return
    actor = getattr(g, "current_user", None) or {}
    request_ip = (
        request.headers.get("CF-Connecting-IP")
        or request.headers.get("X-Forwarded-For")
        or request.remote_addr
        or ""
    )
    token_metadata = safe_link_token_metadata(token, doctor_id=doctor_id)
    patient_links_repository.insert_audit_event(
        token_hash=token_metadata.get("tokenHash"),
        doctor_id=doctor_id,
        actor_user_id=str(actor.get("id") or "").strip() or None,
        actor_role=str(actor.get("role") or "").strip() or None,
        event_type=event_type,
        resource_ref=token_metadata.get("tokenHash") or token_metadata.get("tokenHint"),
        purpose="delegate_link_workflow",
        result="success",
        request_ip=request_ip.split(",")[0].strip() if request_ip else None,
        device_info=request.headers.get("User-Agent"),
        payload=_sanitize_audit_payload(payload or {}),
    )


def _parse_iso_utc(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            seconds = float(value)
        except Exception:
            return None
        if seconds > 10_000_000_000:
            seconds = seconds / 1000.0
        if seconds <= 0:
            return None
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _migrate_legacy_links_to_table() -> None:
    if not _using_mysql():
        return
    global _LEGACY_MIGRATED
    with _LEGACY_MIGRATION_LOCK:
        if _LEGACY_MIGRATED:
            return
        _LEGACY_MIGRATED = True

    now = datetime.now(timezone.utc)

    def parse_links(value: Any) -> List[Dict[str, Any]]:
        if value is None:
            return []
        payload = value
        if isinstance(payload, (bytes, bytearray)):
            try:
                payload = payload.decode("utf-8")
            except Exception:
                payload = None
        if isinstance(payload, str):
            text = payload.strip()
            if not text:
                return []
            try:
                payload = json.loads(text)
            except Exception:
                return []
        if not isinstance(payload, list):
            return []
        return [entry for entry in payload if isinstance(entry, dict)]

    def migrate_doctor_links(doctor_id: str, links: List[Dict[str, Any]]) -> None:
        doctor_id = str(doctor_id or "").strip()
        if not doctor_id:
            return
        # Pull legacy per-doctor markup (if it exists), but do not overwrite newer persisted values.
        legacy_markup = 0.0
        has_legacy_markup = False
        try:
            payload = _sql_read_key(_config_key(doctor_id))
            if payload is None:
                payload = _read_store_dict().get(_config_key(doctor_id))
            if isinstance(payload, dict) and (
                "markupPercent" in payload or "markup_percent" in payload
            ):
                legacy_markup = _normalize_markup_percent(
                    payload.get("markupPercent") if "markupPercent" in payload else payload.get("markup_percent")
                )
                has_legacy_markup = True
        except Exception:
            legacy_markup = 0.0
        doctor_markup = 0.0
        try:
            doctor = user_repository.find_by_id(doctor_id) or None
            if isinstance(doctor, dict) and doctor:
                doctor_markup = _normalize_markup_percent(doctor.get("markupPercent"))
                # Only migrate legacy -> user when legacy is explicitly non-zero and user doesn't have a value yet.
                if has_legacy_markup and legacy_markup > 0.001 and doctor_markup <= 0.001:
                    user_repository.update({**doctor, "markupPercent": legacy_markup})
                    doctor_markup = legacy_markup
        except Exception:
            doctor_markup = legacy_markup if has_legacy_markup else 0.0
        markup_to_persist = legacy_markup if (has_legacy_markup and legacy_markup > 0.001 and doctor_markup <= 0.001) else doctor_markup
        for entry in links or []:
            token = str(entry.get("token") or "").strip()
            if not token:
                continue
            created_dt = _parse_iso_utc(entry.get("createdAt")) or now
            expires_dt = _parse_iso_utc(entry.get("expiresAt"))
            if isinstance(expires_dt, datetime) and expires_dt <= now:
                continue
            reference_label_value = entry.get("referenceLabel")
            if not (isinstance(reference_label_value, str) and str(reference_label_value).strip()):
                reference_label_value = entry.get("reference_label")
            if not (isinstance(reference_label_value, str) and str(reference_label_value).strip()):
                reference_label_value = entry.get("label")
            reference_label = (
                str(reference_label_value).strip()
                if isinstance(reference_label_value, str) and str(reference_label_value).strip()
                else None
            )
            patient_id_value = entry.get("patientId")
            if not (isinstance(patient_id_value, str) and str(patient_id_value).strip()):
                patient_id_value = entry.get("patient_id")
            patient_id = str(patient_id_value).strip() if isinstance(patient_id_value, str) and str(patient_id_value).strip() else None
            last_used = _parse_iso_utc(entry.get("lastUsedAt"))
            revoked = _parse_iso_utc(entry.get("revokedAt"))
            try:
                mysql_client.execute(
                    """
                    INSERT IGNORE INTO patient_links (
                        token, doctor_id, patient_id, reference_label, created_at, expires_at, markup_percent, last_used_at, revoked_at
                    ) VALUES (
                        %(token)s, %(doctor_id)s, %(patient_id)s, %(reference_label)s, %(created_at)s, %(expires_at)s, %(markup_percent)s, %(last_used_at)s, %(revoked_at)s
                    )
                    """,
                    {
                        "token": token,
                        "doctor_id": doctor_id,
                        "patient_id": patient_id,
                        "reference_label": reference_label,
                        "created_at": created_dt.replace(tzinfo=None),
                        "expires_at": expires_dt.replace(tzinfo=None) if isinstance(expires_dt, datetime) else None,
                        "markup_percent": float(markup_to_persist or 0.0),
                        "last_used_at": last_used.replace(tzinfo=None) if isinstance(last_used, datetime) else None,
                        "revoked_at": revoked.replace(tzinfo=None) if isinstance(revoked, datetime) else None,
                    },
                )
            except Exception:
                continue

    # Migrate from MySQL `settings` table (legacy storage).
    try:
        rows = mysql_client.fetch_all(
            "SELECT `key`, value_json FROM settings WHERE `key` LIKE %(prefix)s",
            {"prefix": f"{_LINKS_KEY_PREFIX}%"},
        )
        for row in rows or []:
            key = str(row.get("key") or "")
            if not key.startswith(_LINKS_KEY_PREFIX):
                continue
            doctor_id = key[len(_LINKS_KEY_PREFIX) :].strip()
            migrate_doctor_links(doctor_id, parse_links(row.get("value_json")))
    except Exception:
        pass

    # Migrate from JSON settings store (legacy fallback).
    try:
        store = _read_store_dict()
        for key, value in (store or {}).items():
            if not isinstance(key, str) or not key.startswith(_LINKS_KEY_PREFIX):
                continue
            doctor_id = key[len(_LINKS_KEY_PREFIX) :].strip()
            migrate_doctor_links(doctor_id, parse_links(value))
    except Exception:
        pass

    try:
        patient_links_repository.delete_expired()
    except Exception:
        return


def _read_store_dict() -> Dict[str, Any]:
    if not settings_store:
        return {}
    try:
        raw = settings_store.read() or {}
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _write_store_dict(payload: Dict[str, Any]) -> None:
    if not settings_store:
        return
    try:
        settings_store.write(payload)
    except Exception:
        logger.debug("[Delegation] Failed to persist settings_store payload", exc_info=True)


def _sql_read_key(key: str) -> Optional[Any]:
    if not _using_mysql():
        return None
    try:
        row = mysql_client.fetch_one(
            "SELECT value_json FROM settings WHERE `key` = %(key)s",
            {"key": key},
        )
        if not row or "value_json" not in row:
            return None
        raw = row.get("value_json")
        if isinstance(raw, (bytes, bytearray)):
            try:
                raw = raw.decode("utf-8")
            except Exception:
                raw = None
        if raw is None:
            return None
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except Exception:
                return raw
        return raw
    except Exception:
        return None


def _sql_write_key(key: str, value: Any) -> None:
    if not _using_mysql():
        return
    try:
        mysql_client.execute(
            """
            INSERT INTO settings (`key`, value_json, updated_at)
            VALUES (%(key)s, %(value)s, NOW())
            ON DUPLICATE KEY UPDATE
              updated_at = IF(value_json <=> VALUES(value_json), updated_at, NOW()),
              value_json = VALUES(value_json)
            """,
            {"key": key, "value": json.dumps(value)},
        )
    except Exception:
        logger.warning("[Delegation] Failed to persist settings key=%s", key, exc_info=True)


def _links_key(doctor_id: str) -> str:
    return f"{_LINKS_KEY_PREFIX}{doctor_id}"


def _config_key(doctor_id: str) -> str:
    return f"{_CONFIG_KEY_PREFIX}{doctor_id}"


def _load_links(doctor_id: str) -> List[Dict[str, Any]]:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return []
    key = _links_key(doctor_id)
    payload = _sql_read_key(key)
    if payload is None:
        store = _read_store_dict()
        payload = store.get(key)
    if not isinstance(payload, list):
        return []
    return [entry for entry in payload if isinstance(entry, dict)]


def _persist_links(doctor_id: str, links: List[Dict[str, Any]]) -> None:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return
    key = _links_key(doctor_id)
    store = _read_store_dict()
    store[key] = links
    _write_store_dict(store)
    _sql_write_key(key, links)


def _load_index() -> Dict[str, Any]:
    payload = _sql_read_key(_INDEX_KEY)
    if payload is None:
        store = _read_store_dict()
        payload = store.get(_INDEX_KEY)
    if not isinstance(payload, dict):
        return {}
    return payload


def _persist_index(index: Dict[str, Any]) -> None:
    store = _read_store_dict()
    store[_INDEX_KEY] = index
    _write_store_dict(store)
    _sql_write_key(_INDEX_KEY, index)


def get_doctor_config(doctor_id: str) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return {
            "markupPercent": 0.0,
            "maxMarkupPercent": _patient_link_max_markup_percent(),
            "defaultExpiryHours": _patient_link_default_expiry_hours(),
        }
    if _using_mysql():
        _migrate_legacy_links_to_table()
        doctor = user_repository.find_by_id(doctor_id) or {}
        value = doctor.get("markupPercent") if isinstance(doctor, dict) else 0.0
        try:
            return {
                "markupPercent": _normalize_capped_markup_percent(value),
                "maxMarkupPercent": _patient_link_max_markup_percent(),
                "defaultExpiryHours": _patient_link_default_expiry_hours(),
            }
        except Exception:
            return {
                "markupPercent": 0.0,
                "maxMarkupPercent": _patient_link_max_markup_percent(),
                "defaultExpiryHours": _patient_link_default_expiry_hours(),
            }
    key = _config_key(doctor_id)
    payload = _sql_read_key(key)
    if payload is None:
        store = _read_store_dict()
        payload = store.get(key)
    if not isinstance(payload, dict):
        payload = {}
    markup_percent = _normalize_capped_markup_percent(payload.get("markupPercent") or payload.get("markup_percent") or 0)
    return {
        "markupPercent": markup_percent,
        "maxMarkupPercent": _patient_link_max_markup_percent(),
        "defaultExpiryHours": _patient_link_default_expiry_hours(),
    }


def update_doctor_config(doctor_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        raise ValueError("doctor_id is required")
    markup_percent = _normalize_capped_markup_percent((patch or {}).get("markupPercent"))
    if _using_mysql():
        _migrate_legacy_links_to_table()
        # Persist on the doctor user record (non-volatile across sessions).
        existing = user_repository.find_by_id(doctor_id) or None
        if not isinstance(existing, dict) or not existing:
            raise ValueError("Doctor not found")
        user_repository.update({**existing, "markupPercent": markup_percent})
        return {
            "markupPercent": markup_percent,
            "maxMarkupPercent": _patient_link_max_markup_percent(),
            "defaultExpiryHours": _patient_link_default_expiry_hours(),
        }
    current = get_doctor_config(doctor_id)
    merged = {**current, "markupPercent": markup_percent}
    key = _config_key(doctor_id)
    store = _read_store_dict()
    store[key] = merged
    _write_store_dict(store)
    _sql_write_key(key, merged)
    return {
        **merged,
        "maxMarkupPercent": _patient_link_max_markup_percent(),
        "defaultExpiryHours": _patient_link_default_expiry_hours(),
    }


def list_links(doctor_id: str) -> List[Dict[str, Any]]:
    if _using_mysql():
        _migrate_legacy_links_to_table()
        links = patient_links_repository.list_links(doctor_id)
        normalized: List[Dict[str, Any]] = []
        for link in links or []:
            if not isinstance(link, dict):
                continue
            link_type = _normalize_link_type(link.get("linkType") or link.get("link_type"))
            normalized.append(
                {
                    **link,
                    "markupPercent": 0.0 if link_type == "brochure" else _normalize_capped_markup_percent(link.get("markupPercent")),
                    "usageLimit": _link_usage_limit_for_response(link),
                }
            )
        return normalized
    links = _load_links(doctor_id)
    # Sort most recent first.
    def sort_key(entry: Dict[str, Any]) -> str:
        return str(entry.get("createdAt") or "")
    links.sort(key=sort_key, reverse=True)
    return links


def create_link(
    doctor_id: str,
    *,
    link_type: Optional[str] = None,
    created_by_user_id: Optional[str] = None,
    link_name: Optional[str] = None,
    reference_label: Optional[str] = None,
    patient_id: Optional[str] = None,
    subject_label: Optional[str] = None,
    study_label: Optional[str] = None,
    patient_reference: Optional[str] = None,
    brochure_name: Optional[str] = None,
    delegate_name: Optional[str] = None,
    delegate_contact: Optional[str] = None,
    recipient_name: Optional[str] = None,
    recipient_contact: Optional[str] = None,
    delegate_role: Optional[str] = None,
    product_scope: Optional[str] = None,
    product_scope_items: Optional[Any] = None,
    delegate_permission: Optional[str] = None,
    markup_percent: Optional[object] = None,
    pricing_disclosure: Optional[str] = None,
    zelle_recipient_name: Optional[str] = None,
    payment_confirmation_required: Optional[Any] = None,
    delegate_instructions: Optional[str] = None,
    internal_physician_note: Optional[str] = None,
    terms_version: Optional[str] = None,
    shipping_policy_version: Optional[str] = None,
    privacy_policy_version: Optional[str] = None,
    instructions: Optional[str] = None,
    allowed_products: Optional[Any] = None,
    expires_in_hours: Optional[Any] = None,
    usage_limit: Optional[Any] = None,
    payment_method: Optional[str] = None,
    payment_instructions: Optional[str] = None,
    physician_certified: Optional[Any] = None,
) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        raise ValueError("doctor_id is required")
    link_type_value = _normalize_link_type(link_type)
    capabilities = capabilities_for_link_type(link_type_value)
    tracking_name = recipient_name if link_type_value == "brochure" else delegate_name
    tracking_contact = recipient_contact if link_type_value == "brochure" else delegate_contact
    link_name_value = _validate_non_phi_label(
        link_name or reference_label or (brochure_name if link_type_value == "brochure" else None),
        field_name="linkName",
    )
    brochure_name_value = (
        _validate_non_phi_label(brochure_name or link_name_value, field_name="brochureName")
        if link_type_value == "brochure"
        else None
    )
    if link_type_value == "brochure" and not (link_name_value or brochure_name_value):
        err = ValueError("linkName is required for brochure links.")
        setattr(err, "status", 400)
        raise err
    if _using_mysql():
        _migrate_legacy_links_to_table()
        effective_expires_in_hours = _normalize_link_limit(
            expires_in_hours,
            field_name="expiresInHours",
            default=DEFAULT_DELEGATE_LINK_EXPIRY_HOURS,
            max_value=_expiry_max_for_link_type(link_type_value),
        )
        product_scope_value = _normalize_product_scope(product_scope)
        usage_limit_value = _usage_limit_for_link(link_type_value, usage_limit)
        product_scope_items_value = _normalize_allowed_products(product_scope_items)
        allowed_products_value = _normalize_allowed_products(allowed_products)
        _require_explicit_product_scope(product_scope_value, product_scope_items_value, allowed_products_value)
        default_markup = 0.0
        if link_type_value != "brochure" and markup_percent is None:
            default_markup = _doctor_default_markup_percent(doctor_id)
        markup_value = 0.0 if link_type_value == "brochure" else _normalize_capped_markup_percent(
            default_markup if markup_percent is None else markup_percent
        )
        created = patient_links_repository.create_link(
            doctor_id,
            link_type=link_type_value,
            created_by_user_id=created_by_user_id or doctor_id,
            link_name=link_name_value,
            reference_label=link_name_value,
            patient_id=_validate_non_phi_label(patient_id, field_name="patientId"),
            subject_label=_validate_non_phi_label(subject_label, field_name="subjectLabel"),
            study_label=_validate_non_phi_label(study_label, field_name="studyLabel"),
            patient_reference=_validate_non_phi_label(patient_reference, field_name="patientReference"),
            brochure_name=brochure_name_value,
            delegate_name=_validate_sensitive_session_text(tracking_name, field_name="recipientName" if link_type_value == "brochure" else "delegateName", max_len=190),
            delegate_contact=_validate_sensitive_session_text(tracking_contact, field_name="recipientContact" if link_type_value == "brochure" else "delegateContact", max_len=190),
            delegate_role=None if link_type_value == "brochure" else _normalize_delegate_role(delegate_role),
            product_scope=product_scope_value,
            product_scope_items=product_scope_items_value,
            delegate_permission=BROCHURE_PERMISSION if link_type_value == "brochure" else _normalize_delegate_permission(delegate_permission),
            markup_percent=markup_value,
            pricing_disclosure=_validate_sensitive_session_text(
                None if link_type_value == "brochure" else (pricing_disclosure or DEFAULT_PRICING_DISCLOSURE),
                field_name="pricingDisclosure",
                max_len=1000,
            ),
            zelle_recipient_name=_validate_sensitive_session_text(
                None if link_type_value == "brochure" else zelle_recipient_name,
                field_name="zelleRecipientName",
                max_len=190,
            ),
            payment_confirmation_required=False if link_type_value == "brochure" else _normalize_bool(payment_confirmation_required, default=True),
            delegate_instructions=None if link_type_value == "brochure" else _validate_research_note(delegate_instructions, field_name="delegateInstructions"),
            internal_physician_note=_validate_research_note(internal_physician_note, field_name="internalPhysicianNote"),
            terms_version=_validate_policy_version(terms_version, field_name="termsVersion"),
            shipping_policy_version=_validate_policy_version(shipping_policy_version, field_name="shippingPolicyVersion"),
            privacy_policy_version=_validate_policy_version(privacy_policy_version, field_name="privacyPolicyVersion"),
            instructions=None if link_type_value == "brochure" else _validate_research_note(instructions, field_name="instructions"),
            allowed_products=allowed_products_value,
            expires_in_hours=effective_expires_in_hours,
            usage_limit=usage_limit_value,
            payment_method=None if link_type_value == "brochure" else payment_method,
            payment_instructions=None if link_type_value == "brochure" else _validate_research_note(payment_instructions, field_name="paymentInstructions"),
            physician_certified=physician_certified,
        )
        _audit_event(
            "link_created",
            token=created.get("token"),
            doctor_id=doctor_id,
            payload={
                "allowedProductsCount": len(created.get("allowedProducts") or []),
                "linkType": created.get("linkType") or link_type_value,
                "productScope": created.get("productScope"),
                "delegatePermission": created.get("delegatePermission"),
                "expiresAt": created.get("expiresAt"),
                "markupPercent": created.get("markupPercent"),
                "confirmationRequired": created.get("paymentConfirmationRequired"),
                "policyVersions": {
                    "terms": created.get("termsVersion"),
                    "shipping": created.get("shippingPolicyVersion"),
                    "privacy": created.get("privacyPolicyVersion"),
                },
            },
        )
        return created
    token = secrets.token_urlsafe(24)
    now = datetime.now(timezone.utc).isoformat()
    config = get_doctor_config(doctor_id)
    markup_value = 0.0 if link_type_value == "brochure" else (
        _normalize_capped_markup_percent(config.get("markupPercent"))
        if markup_percent is None
        else _normalize_capped_markup_percent(markup_percent)
    )
    subject_value = _validate_non_phi_label(subject_label or patient_id, field_name="subjectLabel")
    study_value = _validate_non_phi_label(study_label, field_name="studyLabel")
    patient_reference_value = _validate_non_phi_label(patient_reference, field_name="patientReference")
    allowed_products_value = _normalize_allowed_products(allowed_products)
    expires_hours_value = _normalize_link_limit(
        expires_in_hours,
        field_name="expiresInHours",
        default=DEFAULT_DELEGATE_LINK_EXPIRY_HOURS,
        max_value=_expiry_max_for_link_type(link_type_value),
    )
    expires_at = (
        (datetime.now(timezone.utc) + timedelta(hours=expires_hours_value)).isoformat()
        if expires_hours_value is not None
        else None
    )
    product_scope_value = _normalize_product_scope(product_scope)
    product_scope_items_value = _normalize_allowed_products(product_scope_items)
    _require_explicit_product_scope(product_scope_value, product_scope_items_value, allowed_products_value)
    delegate_permission_value = BROCHURE_PERMISSION if link_type_value == "brochure" else _normalize_delegate_permission(delegate_permission)
    usage_limit_value = _usage_limit_for_link(link_type_value, usage_limit)
    link = {
        "token": token,
        "linkType": link_type_value,
        "link_type": link_type_value,
        "capabilities": capabilities,
        "createdByUserId": created_by_user_id or doctor_id,
        "linkName": link_name_value or brochure_name_value,
        "link_name": link_name_value or brochure_name_value,
        "patientId": subject_value,
        "patientReference": patient_reference_value,
        "referenceLabel": link_name_value or brochure_name_value,
        "brochureName": brochure_name_value,
        "brochure_name": brochure_name_value,
        "label": link_name_value or brochure_name_value,
        "subjectLabel": subject_value,
        "studyLabel": study_value,
        "recipientName": _validate_sensitive_session_text(tracking_name, field_name="recipientName", max_len=190) if link_type_value == "brochure" else None,
        "recipientContact": _validate_sensitive_session_text(tracking_contact, field_name="recipientContact", max_len=190) if link_type_value == "brochure" else None,
        "delegateName": _validate_sensitive_session_text(tracking_name, field_name="delegateName", max_len=190) if link_type_value != "brochure" else None,
        "delegateContact": _validate_sensitive_session_text(tracking_contact, field_name="delegateContact", max_len=190) if link_type_value != "brochure" else None,
        "delegateRole": None if link_type_value == "brochure" else _normalize_delegate_role(delegate_role),
        "createdAt": now,
        "expiresAt": expires_at,
        "markupPercent": float(markup_value or 0.0),
        "pricingDisclosure": _validate_sensitive_session_text(
            None if link_type_value == "brochure" else (pricing_disclosure or DEFAULT_PRICING_DISCLOSURE),
            field_name="pricingDisclosure",
            max_len=1000,
        ),
        "zelleRecipientName": _validate_sensitive_session_text(
            None if link_type_value == "brochure" else zelle_recipient_name,
            field_name="zelleRecipientName",
            max_len=190,
        ),
        "paymentConfirmationRequired": False if link_type_value == "brochure" else _normalize_bool(payment_confirmation_required, default=True),
        "delegateInstructions": None if link_type_value == "brochure" else _validate_research_note(delegate_instructions, field_name="delegateInstructions"),
        "internalPhysicianNote": _validate_research_note(internal_physician_note, field_name="internalPhysicianNote"),
        "termsVersion": _validate_policy_version(terms_version, field_name="termsVersion"),
        "shippingPolicyVersion": _validate_policy_version(shipping_policy_version, field_name="shippingPolicyVersion"),
        "privacyPolicyVersion": _validate_policy_version(privacy_policy_version, field_name="privacyPolicyVersion"),
        "productScope": product_scope_value,
        "productScopeItems": product_scope_items_value,
        "delegatePermission": delegate_permission_value,
        "instructions": None if link_type_value == "brochure" else _validate_research_note(instructions, field_name="instructions"),
        "allowedProducts": allowed_products_value,
        "usageLimit": usage_limit_value,
        "usageCount": 0,
        "openCount": 0,
        "viewCount": 0,
        "status": "active",
        "receivedPayment": False,
        "physicianCertified": bool(physician_certified),
        "lastUsedAt": None,
        "lastOpenedAt": None,
        "firstViewedAt": None,
        "lastViewedAt": None,
        "lastOrderAt": None,
        "revokedAt": None,
    }
    links = _load_links(doctor_id)
    links.append(link)
    _persist_links(doctor_id, links)

    index = _load_index()
    index[token] = {"doctorId": doctor_id, "createdAt": now}
    _persist_index(index)
    return link


def update_link(
    doctor_id: str,
    token: str,
    *,
    link_name: Optional[str] = None,
    reference_label: Optional[str] = None,
    patient_id: Optional[str] = None,
    subject_label: Optional[str] = None,
    study_label: Optional[str] = None,
    patient_reference: Optional[str] = None,
    brochure_name: Optional[str] = None,
    delegate_name: Optional[str] = None,
    delegate_contact: Optional[str] = None,
    delegate_role: Optional[str] = None,
    product_scope: Optional[str] = None,
    product_scope_items: Optional[Any] = None,
    delegate_permission: Optional[str] = None,
    revoke: Optional[bool] = None,
    markup_percent: Optional[object] = None,
    pricing_disclosure: Optional[str] = None,
    zelle_recipient_name: Optional[str] = None,
    payment_confirmation_required: Optional[Any] = None,
    delegate_instructions: Optional[str] = None,
    internal_physician_note: Optional[str] = None,
    terms_version: Optional[str] = None,
    shipping_policy_version: Optional[str] = None,
    privacy_policy_version: Optional[str] = None,
    instructions: Optional[str] = None,
    allowed_products: Optional[Any] = None,
    expires_in_hours: Optional[Any] = None,
    usage_limit: Optional[Any] = None,
    payment_method: Optional[str] = None,
    payment_instructions: Optional[str] = None,
    received_payment: Optional[object] = None,
) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    token = _normalize_token(token)
    if not doctor_id:
        raise ValueError("doctor_id is required")
    if not token:
        raise ValueError("token is required")
    if _using_mysql():
        _migrate_legacy_links_to_table()
        markup_value = None if markup_percent is None else _normalize_capped_markup_percent(markup_percent)
        existing_link_type = "delegate"
        existing_link: Dict[str, Any] = {}
        if (
            expires_in_hours is not None
            or usage_limit is not None
            or product_scope is not None
            or product_scope_items is not None
            or allowed_products is not None
        ):
            try:
                existing_link = patient_links_repository.find_by_token(token, include_inactive=True) or {}
                existing_link_type = str(existing_link.get("linkType") or existing_link.get("link_type") or "delegate")
            except Exception:
                existing_link = {}
                existing_link_type = "delegate"
        product_scope_value = _normalize_product_scope(product_scope) if product_scope is not None else None
        product_scope_items_value = _normalize_allowed_products(product_scope_items) if product_scope_items is not None else None
        allowed_products_value = _normalize_allowed_products(allowed_products) if allowed_products is not None else None
        if product_scope_value is not None:
            _require_explicit_product_scope(
                product_scope_value,
                product_scope_items_value if product_scope_items_value is not None else existing_link.get("productScopeItems"),
                allowed_products_value if allowed_products_value is not None else existing_link.get("allowedProducts"),
            )
        updated = patient_links_repository.update_link(
            doctor_id,
            token,
            link_name=(
                _validate_non_phi_label(
                    link_name if link_name is not None else reference_label,
                    field_name="linkName",
                )
                if link_name is not None or reference_label is not None
                else None
            ),
            reference_label=(
                _validate_non_phi_label(
                    link_name if link_name is not None else reference_label,
                    field_name="linkName",
                )
                if link_name is not None or reference_label is not None
                else None
            ),
            patient_id=_validate_non_phi_label(patient_id, field_name="patientId") if patient_id is not None else None,
            subject_label=_validate_non_phi_label(subject_label, field_name="subjectLabel") if subject_label is not None else None,
            study_label=_validate_non_phi_label(study_label, field_name="studyLabel") if study_label is not None else None,
            patient_reference=_validate_non_phi_label(patient_reference, field_name="patientReference") if patient_reference is not None else None,
            brochure_name=_validate_non_phi_label(brochure_name, field_name="brochureName") if brochure_name is not None else None,
            delegate_name=(
                _validate_sensitive_session_text(delegate_name, field_name="delegateName", max_len=190)
                if delegate_name is not None
                else None
            ),
            delegate_contact=(
                _validate_sensitive_session_text(delegate_contact, field_name="delegateContact", max_len=190)
                if delegate_contact is not None
                else None
            ),
            delegate_role=_normalize_delegate_role(delegate_role) if delegate_role is not None else None,
            product_scope=product_scope_value,
            product_scope_items=product_scope_items_value,
            delegate_permission=(
                _normalize_delegate_permission(delegate_permission)
                if delegate_permission is not None
                else None
            ),
            revoke=revoke,
            markup_percent=markup_value,
            pricing_disclosure=(
                _validate_sensitive_session_text(pricing_disclosure, field_name="pricingDisclosure", max_len=1000)
                if pricing_disclosure is not None
                else None
            ),
            zelle_recipient_name=(
                _validate_sensitive_session_text(zelle_recipient_name, field_name="zelleRecipientName", max_len=190)
                if zelle_recipient_name is not None
                else None
            ),
            payment_confirmation_required=payment_confirmation_required,
            delegate_instructions=(
                _validate_research_note(delegate_instructions, field_name="delegateInstructions")
                if delegate_instructions is not None
                else None
            ),
            internal_physician_note=(
                _validate_research_note(internal_physician_note, field_name="internalPhysicianNote")
                if internal_physician_note is not None
                else None
            ),
            terms_version=_validate_policy_version(terms_version, field_name="termsVersion") if terms_version is not None else None,
            shipping_policy_version=(
                _validate_policy_version(shipping_policy_version, field_name="shippingPolicyVersion")
                if shipping_policy_version is not None
                else None
            ),
            privacy_policy_version=(
                _validate_policy_version(privacy_policy_version, field_name="privacyPolicyVersion")
                if privacy_policy_version is not None
                else None
            ),
            instructions=_validate_research_note(instructions, field_name="instructions") if instructions is not None else None,
            allowed_products=allowed_products_value,
            expires_in_hours=(
                _normalize_optional_link_limit(
                    expires_in_hours,
                    field_name="expiresInHours",
                    max_value=_expiry_max_for_link_type(existing_link_type),
                )
                if expires_in_hours is not None
                else None
            ),
            usage_limit=_usage_limit_for_link(existing_link_type, usage_limit) if usage_limit is not None else None,
            payment_method=payment_method,
            payment_instructions=_validate_research_note(payment_instructions, field_name="paymentInstructions") if payment_instructions is not None else None,
            received_payment=received_payment,
        )
        if updated is None:
            err = ValueError("Link not found")
            setattr(err, "status", 404)
            raise err
        _audit_event(
            "link_updated",
            token=token,
            doctor_id=doctor_id,
            payload={
                "revoke": revoke,
                "markupPercent": updated.get("markupPercent"),
                "allowedProductsCount": len(updated.get("allowedProducts") or []),
                "productScope": updated.get("productScope"),
                "delegatePermission": updated.get("delegatePermission"),
                "status": updated.get("status"),
            },
        )
        return updated

    links = _load_links(doctor_id)
    now = datetime.now(timezone.utc).isoformat()
    updated = None
    for entry in links:
        if str(entry.get("token") or "") != token:
            continue
        if patient_reference is not None:
            patient_reference_value = _validate_non_phi_label(patient_reference, field_name="patientReference")
            entry["patientReference"] = patient_reference_value
        if patient_id is not None or subject_label is not None:
            entry["patientId"] = _validate_non_phi_label(subject_label or patient_id, field_name="subjectLabel")
        if study_label is not None:
            entry["studyLabel"] = _validate_non_phi_label(study_label, field_name="studyLabel")
        if brochure_name is not None:
            next_brochure_name = _validate_non_phi_label(brochure_name, field_name="brochureName")
            entry["brochureName"] = next_brochure_name
            if (
                _normalize_link_type(entry.get("linkType") or entry.get("link_type")) == "brochure"
                and link_name is None
                and reference_label is None
            ):
                entry["linkName"] = next_brochure_name
                entry["link_name"] = next_brochure_name
                entry["referenceLabel"] = next_brochure_name
                entry["label"] = next_brochure_name
        if link_name is not None or reference_label is not None:
            next_link_name = _validate_non_phi_label(
                link_name if link_name is not None else reference_label,
                field_name="linkName",
            )
            entry["linkName"] = next_link_name
            entry["link_name"] = next_link_name
            entry["referenceLabel"] = next_link_name
            entry["label"] = next_link_name
        if delegate_name is not None:
            entry["delegateName"] = _validate_sensitive_session_text(delegate_name, field_name="delegateName", max_len=190)
        if delegate_contact is not None:
            entry["delegateContact"] = _validate_sensitive_session_text(delegate_contact, field_name="delegateContact", max_len=190)
        if delegate_role is not None:
            entry["delegateRole"] = _normalize_delegate_role(delegate_role)
        if product_scope is not None:
            entry["productScope"] = _normalize_product_scope(product_scope)
        if product_scope_items is not None:
            entry["productScopeItems"] = _normalize_allowed_products(product_scope_items)
        if delegate_permission is not None:
            entry["delegatePermission"] = _normalize_delegate_permission(delegate_permission)
        if markup_percent is not None:
            entry["markupPercent"] = float(_normalize_capped_markup_percent(markup_percent) or 0.0)
        if pricing_disclosure is not None:
            entry["pricingDisclosure"] = _validate_sensitive_session_text(
                pricing_disclosure,
                field_name="pricingDisclosure",
                max_len=1000,
            )
        if zelle_recipient_name is not None:
            entry["zelleRecipientName"] = _validate_sensitive_session_text(
                zelle_recipient_name,
                field_name="zelleRecipientName",
                max_len=190,
            )
        if payment_confirmation_required is not None:
            entry["paymentConfirmationRequired"] = _normalize_bool(payment_confirmation_required, default=True)
        if delegate_instructions is not None:
            entry["delegateInstructions"] = _validate_research_note(delegate_instructions, field_name="delegateInstructions")
        if internal_physician_note is not None:
            entry["internalPhysicianNote"] = _validate_research_note(internal_physician_note, field_name="internalPhysicianNote")
        if terms_version is not None:
            entry["termsVersion"] = _validate_policy_version(terms_version, field_name="termsVersion")
        if shipping_policy_version is not None:
            entry["shippingPolicyVersion"] = _validate_policy_version(shipping_policy_version, field_name="shippingPolicyVersion")
        if privacy_policy_version is not None:
            entry["privacyPolicyVersion"] = _validate_policy_version(privacy_policy_version, field_name="privacyPolicyVersion")
        if instructions is not None:
            entry["instructions"] = _validate_research_note(instructions, field_name="instructions")
        if allowed_products is not None:
            entry["allowedProducts"] = _normalize_allowed_products(allowed_products)
        if expires_in_hours is not None:
            normalized_expiry_hours = _normalize_optional_link_limit(
                expires_in_hours,
                field_name="expiresInHours",
                max_value=_expiry_max_for_link_type(entry.get("linkType") or entry.get("link_type")),
            )
            entry["expiresAt"] = (
                (datetime.now(timezone.utc) + timedelta(hours=normalized_expiry_hours)).isoformat()
                if normalized_expiry_hours is not None
                else None
            )
        if usage_limit is not None:
            entry["usageLimit"] = _usage_limit_for_link(entry.get("linkType") or entry.get("link_type"), usage_limit)
        if received_payment is not None:
            if isinstance(received_payment, bool):
                entry["receivedPayment"] = bool(received_payment)
            elif isinstance(received_payment, (int, float)):
                entry["receivedPayment"] = int(received_payment) == 1
            elif isinstance(received_payment, str):
                normalized = received_payment.strip().lower()
                if normalized in ("1", "true", "yes", "y", "paid"):
                    entry["receivedPayment"] = True
                elif normalized in ("0", "false", "no", "n", "unpaid"):
                    entry["receivedPayment"] = False
        if revoke is True:
            entry["revokedAt"] = entry.get("revokedAt") or now
            entry["status"] = "revoked"
        if revoke is False:
            entry["revokedAt"] = None
            entry["status"] = "active"
        updated = entry
        break
    if updated is None:
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    _persist_links(doctor_id, links)
    return updated


def delete_link(doctor_id: str, token: str) -> Dict[str, Any]:
    if not _using_mysql():
        err = RuntimeError("MySQL backend is required for delegate links")
        setattr(err, "status", 501)
        raise err
    _migrate_legacy_links_to_table()
    doctor_id = str(doctor_id or "").strip()
    token = _normalize_token(token)
    if not doctor_id:
        err = ValueError("doctor_id is required")
        setattr(err, "status", 400)
        raise err
    if not token:
        err = ValueError("token is required")
        setattr(err, "status", 400)
        raise err

    existing = patient_links_repository.find_by_token(token, include_inactive=True)
    if not isinstance(existing, dict) or str(existing.get("doctorId") or "").strip() != doctor_id:
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    if not str(existing.get("revokedAt") or "").strip():
        err = ValueError("Only revoked links can be deleted")
        setattr(err, "status", 409)
        raise err

    deleted = patient_links_repository.delete_link(doctor_id, token)
    if not deleted:
        err = RuntimeError("Unable to delete link")
        setattr(err, "status", 502)
        raise err

    _audit_event(
        "link_deleted",
        token=token,
        doctor_id=doctor_id,
        payload={"status": existing.get("status"), "revokedAt": existing.get("revokedAt")},
    )
    return {"deleted": True, "token": token}


def resolve_delegate_token(
    token: str,
    *,
    count_page_load: bool = True,
    view_context: Optional[Dict[str, Any]] = None,
    include_brochure_scope: bool = False,
) -> Dict[str, Any]:
    token = _normalize_token(token)
    if not token:
        err = ValueError("token is required")
        setattr(err, "status", 400)
        raise err

    if _using_mysql():
        _migrate_legacy_links_to_table()
        link = patient_links_repository.find_by_token(token, include_inactive=True)
        if not isinstance(link, dict):
            err = ValueError("Invalid or expired delegate link")
            setattr(err, "status", 404)
            raise err
        doctor_id = str(link.get("doctorId") or "").strip()
        if (
            not doctor_id
            or str(link.get("revokedAt") or "").strip()
            or str(link.get("status") or "").strip().lower() in {"revoked", "expired"}
        ):
            err = ValueError("Invalid or expired delegate link")
            setattr(err, "status", 404)
            raise err

        doctor = user_repository.find_by_id(doctor_id) or None
        if not isinstance(doctor, dict) or not doctor:
            err = ValueError("Invalid or expired delegate link")
            setattr(err, "status", 404)
            raise err

        settings = settings_service.get_settings()
        patient_links_enabled = bool(settings.get("patientLinksEnabled", False))
        doctor_role = str(doctor.get("role") or "").strip().lower()
        is_test_doctor = doctor_role == "test_doctor"
        if not patient_links_enabled and not is_test_doctor:
            err = ValueError("Invalid or expired delegate link")
            setattr(err, "status", 404)
            raise err

        if count_page_load:
            try:
                patient_links_repository.touch_last_used(
                    token,
                    ip_hash=_hash_public_view_value((view_context or {}).get("ip")),
                    user_agent_hash=_hash_public_view_value((view_context or {}).get("userAgent")),
                )
            except Exception:
                pass
            opened_at = datetime.now(timezone.utc).isoformat()
            try:
                link["openCount"] = int(link.get("openCount") or 0) + 1
            except Exception:
                link["openCount"] = 1
            link["lastUsedAt"] = opened_at
            link["lastOpenedAt"] = opened_at
            try:
                link["viewCount"] = int(link.get("viewCount") or 0) + 1
            except Exception:
                link["viewCount"] = int(link.get("openCount") or 1)
            link["lastViewedAt"] = opened_at
            if not link.get("firstViewedAt"):
                link["firstViewedAt"] = opened_at
            _audit_event(
                "link_opened",
                token=token,
                doctor_id=doctor_id,
                payload={
                    "status": link.get("status"),
                    "productScope": link.get("productScope"),
                    "delegatePermission": link.get("delegatePermission"),
                },
            )

        doctor_name = (doctor.get("name") or doctor.get("email") or "Doctor") if isinstance(doctor, dict) else "Doctor"

        review_status = _delegate_proposal_review_status(link)
        link_type = _normalize_link_type(link.get("linkType") or link.get("link_type"))
        capabilities = capabilities_for_link_type(link_type)
        expose_scope_items = link_type != "brochure" or include_brochure_scope
        display_link_name = _link_display_name(link)
        brochure_title = (
            _validate_non_phi_label(display_link_name, field_name="brochureTitle")
            if link_type == "brochure"
            else None
        )

        return {
            "token": token,
            "linkType": link_type,
            "link_type": link_type,
            "capabilities": capabilities,
            "linkName": display_link_name,
            "link_name": display_link_name,
            "referenceLabel": display_link_name,
            "label": display_link_name,
            "brochureTitle": brochure_title,
            "pageTitle": brochure_title,
            "doctorId": "" if link_type == "brochure" else doctor_id,
            "doctorName": doctor_name,
            "markupPercent": 0.0 if link_type == "brochure" else _normalize_capped_markup_percent(link.get("markupPercent")),
            "doctorLogoUrl": doctor.get("delegateLogoUrl") if isinstance(doctor, dict) else None,
            "doctorSecondaryColor": doctor.get("delegateSecondaryColor") if isinstance(doctor, dict) else None,
            "doctorBackgroundImageUrl": doctor.get("delegateBackgroundImageUrl") if isinstance(doctor, dict) else None,
            "doctorBackgroundColor": doctor.get("delegateBackgroundColor") if isinstance(doctor, dict) else None,
            "subjectLabel": None if link_type == "brochure" else link.get("subjectLabel"),
            "studyLabel": None if link_type == "brochure" else link.get("studyLabel"),
            "patientReference": None if link_type == "brochure" else link.get("patientReference"),
            "delegateName": link.get("delegateName") if link_type != "brochure" else None,
            "delegateRole": link.get("delegateRole") if link_type != "brochure" else None,
            "productScope": link.get("productScope") or DEFAULT_PRODUCT_SCOPE,
            "productScopeItems": (link.get("productScopeItems") or []) if expose_scope_items else [],
            "delegatePermission": BROCHURE_PERMISSION if link_type == "brochure" else (link.get("delegatePermission") or DEFAULT_DELEGATE_PERMISSION),
            "pricingDisclosure": None if link_type == "brochure" else (link.get("pricingDisclosure") or DEFAULT_PRICING_DISCLOSURE),
            "paymentConfirmationRequired": False if link_type == "brochure" else link.get("paymentConfirmationRequired"),
            "delegateInstructions": None if link_type == "brochure" else link.get("delegateInstructions"),
            "termsVersion": link.get("termsVersion"),
            "shippingPolicyVersion": link.get("shippingPolicyVersion"),
            "privacyPolicyVersion": link.get("privacyPolicyVersion"),
            "instructions": None if link_type == "brochure" else link.get("instructions"),
            "allowedProducts": (link.get("allowedProducts") or []) if expose_scope_items else [],
            "usageLimit": _link_usage_limit_for_response(link),
            "usageCount": link.get("usageCount"),
            "openCount": link.get("openCount"),
            "viewCount": link.get("viewCount") or link.get("openCount"),
            "firstViewedAt": link.get("firstViewedAt"),
            "lastViewedAt": link.get("lastViewedAt") or link.get("lastOpenedAt"),
            "status": link.get("status") or "active",
            "paymentMethod": None if link_type == "brochure" else (link.get("paymentMethod") if isinstance(link, dict) else None),
            "paymentInstructions": None if link_type == "brochure" else (link.get("paymentInstructions") if isinstance(link, dict) else None),
            "createdAt": link.get("createdAt"),
            "expiresAt": link.get("expiresAt"),
            "lastUsedAt": link.get("lastUsedAt"),
            "lastOpenedAt": link.get("lastOpenedAt"),
            "delegateSharedAt": None if link_type == "brochure" else link.get("delegateSharedAt"),
            "delegateOrderId": None if link_type == "brochure" else link.get("delegateOrderId"),
            "proposalStatus": None if link_type == "brochure" else review_status,
            "proposalReviewedAt": None if link_type == "brochure" else link.get("delegateReviewedAt"),
            "proposalReviewOrderId": None if link_type == "brochure" else link.get("delegateReviewOrderId"),
            "proposalReviewNotes": None if link_type == "brochure" else link.get("delegateReviewNotes"),
            "disclosures": _brochure_disclosures() if link_type == "brochure" else _research_supply_disclosures(link.get("markupPercent")),
            "compensationDisclosure": None if link_type == "brochure" else _compensation_disclosure(link.get("markupPercent")),
        }

    index = _load_index()
    entry = index.get(token) if isinstance(index, dict) else None
    doctor_id = str(entry.get("doctorId") or "").strip() if isinstance(entry, dict) else ""
    if not doctor_id:
        err = ValueError("Invalid or expired delegate link")
        setattr(err, "status", 404)
        raise err

    links = _load_links(doctor_id)
    link = next((l for l in links if str(l.get("token") or "") == token), None)
    if not isinstance(link, dict) or str(link.get("revokedAt") or "").strip():
        err = ValueError("Invalid or expired delegate link")
        setattr(err, "status", 404)
        raise err

    if count_page_load:
        now = datetime.now(timezone.utc).isoformat()
        link["lastUsedAt"] = now
        link["lastOpenedAt"] = now
        link["lastViewedAt"] = now
        if not link.get("firstViewedAt"):
            link["firstViewedAt"] = now
        try:
            link["openCount"] = int(link.get("openCount") or 0) + 1
        except Exception:
            link["openCount"] = 1
        try:
            link["viewCount"] = int(link.get("viewCount") or 0) + 1
        except Exception:
            link["viewCount"] = link.get("openCount") or 1
        _persist_links(doctor_id, links)

    doctor = user_repository.find_by_id(doctor_id) or None
    if not isinstance(doctor, dict) or not doctor:
        err = ValueError("Invalid or expired delegate link")
        setattr(err, "status", 404)
        raise err

    settings = settings_service.get_settings()
    patient_links_enabled = bool(settings.get("patientLinksEnabled", False))
    doctor_role = str(doctor.get("role") or "").strip().lower()
    is_test_doctor = doctor_role == "test_doctor"
    if not patient_links_enabled and not is_test_doctor:
        err = ValueError("Invalid or expired delegate link")
        setattr(err, "status", 404)
        raise err

    doctor_name = (doctor.get("name") or doctor.get("email") or "Doctor") if isinstance(doctor, dict) else "Doctor"
    link_type = _normalize_link_type(link.get("linkType") or link.get("link_type"))
    capabilities = capabilities_for_link_type(link_type)
    expose_scope_items = link_type != "brochure" or include_brochure_scope
    display_link_name = _link_display_name(link)
    brochure_title = (
        _validate_non_phi_label(display_link_name, field_name="brochureTitle")
        if link_type == "brochure"
        else None
    )
    return {
        "token": token,
        "linkType": link_type,
        "link_type": link_type,
        "capabilities": capabilities,
        "linkName": display_link_name,
        "link_name": display_link_name,
        "referenceLabel": display_link_name,
        "label": display_link_name,
        "brochureTitle": brochure_title,
        "pageTitle": brochure_title,
        "doctorId": "" if link_type == "brochure" else doctor_id,
        "doctorName": doctor_name,
        "markupPercent": 0.0 if link_type == "brochure" else float(_normalize_capped_markup_percent(link.get("markupPercent")) or 0.0),
        "allowedProducts": (link.get("allowedProducts") or []) if expose_scope_items else [],
        "subjectLabel": None if link_type == "brochure" else link.get("subjectLabel"),
        "studyLabel": None if link_type == "brochure" else link.get("studyLabel"),
        "patientReference": None if link_type == "brochure" else link.get("patientReference"),
        "delegateName": link.get("delegateName") if link_type != "brochure" else None,
        "delegateRole": link.get("delegateRole") if link_type != "brochure" else None,
        "productScope": link.get("productScope") or DEFAULT_PRODUCT_SCOPE,
        "productScopeItems": (link.get("productScopeItems") or []) if expose_scope_items else [],
        "delegatePermission": BROCHURE_PERMISSION if link_type == "brochure" else (link.get("delegatePermission") or DEFAULT_DELEGATE_PERMISSION),
        "pricingDisclosure": None if link_type == "brochure" else (link.get("pricingDisclosure") or DEFAULT_PRICING_DISCLOSURE),
        "paymentConfirmationRequired": False if link_type == "brochure" else link.get("paymentConfirmationRequired"),
        "delegateInstructions": None if link_type == "brochure" else link.get("delegateInstructions"),
        "termsVersion": link.get("termsVersion"),
        "shippingPolicyVersion": link.get("shippingPolicyVersion"),
        "privacyPolicyVersion": link.get("privacyPolicyVersion"),
        "instructions": None if link_type == "brochure" else link.get("instructions"),
        "usageLimit": _link_usage_limit_for_response(link),
        "usageCount": link.get("usageCount"),
        "openCount": link.get("openCount"),
        "viewCount": link.get("viewCount") or link.get("openCount"),
        "status": link.get("status") or "active",
        "lastUsedAt": link.get("lastUsedAt"),
        "lastOpenedAt": link.get("lastOpenedAt"),
        "firstViewedAt": link.get("firstViewedAt"),
        "lastViewedAt": link.get("lastViewedAt") or link.get("lastOpenedAt"),
        "disclosures": _brochure_disclosures() if link_type == "brochure" else _research_supply_disclosures(link.get("markupPercent")),
        "compensationDisclosure": None if link_type == "brochure" else _compensation_disclosure(link.get("markupPercent")),
    }


def store_delegate_submission(
    token: str,
    *,
    cart: Any,
    shipping: Any,
    payment: Any,
    order_id: Optional[str] = None,
    shared_at: Optional[datetime] = None,
) -> None:
    if not _using_mysql():
        return
    _migrate_legacy_links_to_table()
    submitted_at = shared_at.astimezone(timezone.utc) if isinstance(shared_at, datetime) else datetime.now(timezone.utc)
    link = patient_links_repository.find_by_token(token) or {}
    if not isinstance(link, dict) or not link:
        err = ValueError("Invalid or expired delegate link")
        setattr(err, "status", 404)
        raise err
    link_type = _normalize_link_type(link.get("linkType") or link.get("link_type"))
    capabilities = capabilities_for_link_type(link_type)
    if link_type == "brochure" or capabilities.get("canSubmitProposal") is not True:
        err = ValueError("This link cannot submit an order proposal.")
        setattr(err, "status", 403)
        raise err
    usage_limit_value = _link_usage_limit_for_response(link)
    try:
        usage_count_value = int(link.get("usageCount") or 0)
    except Exception:
        usage_count_value = 0
    if usage_limit_value is not None and usage_count_value >= usage_limit_value:
        err = ValueError("This delegate link has already submitted its allowed proposal.")
        setattr(err, "status", 403)
        raise err
    ok = patient_links_repository.store_delegate_payload(
        token,
        cart=cart,
        shipping=shipping,
        payment=payment,
        order_id=order_id,
        shared_at=shared_at,
    )
    if ok:
        risk_flags: List[str] = []
        items = (cart or {}).get("items") if isinstance(cart, dict) else None
        if isinstance(items, list):
            total_quantity = 0
            for item in items:
                if not isinstance(item, dict):
                    continue
                try:
                    total_quantity += max(0, int(float(item.get("quantity") or 0)))
                except Exception:
                    continue
            if total_quantity >= 10:
                risk_flags.append("large_quantity")
        shipping_address = (shipping or {}).get("shippingAddress") if isinstance(shipping, dict) else None
        if isinstance(shipping_address, dict):
            country = str(shipping_address.get("country") or "").strip().upper()
            if country and country != "US":
                risk_flags.append("non_us_destination")
        if str(link.get("delegateSharedAt") or "").strip():
            risk_flags.append("repeat_submission")
        _audit_event(
            "proposal_shared",
            token=token,
            doctor_id=str(link.get("doctorId") or "").strip() or None,
            payload={
                "orderId": order_id,
                "riskFlags": risk_flags,
                "allowedProductsCount": len(link.get("allowedProducts") or []),
                "productScope": link.get("productScope"),
                "delegatePermission": link.get("delegatePermission"),
            },
        )
        updated_link = patient_links_repository.find_by_token(token) or link
        _send_delegate_proposal_ready_email_for_link(token, updated_link, submitted_at=submitted_at)
        return
    err = RuntimeError("Unable to persist delegate payload")
    setattr(err, "status", 502)
    raise err


def get_link_proposal(doctor_id: str, token: str) -> Dict[str, Any]:
    if not _using_mysql():
        err = RuntimeError("MySQL backend is required for delegate links")
        setattr(err, "status", 501)
        raise err
    _migrate_legacy_links_to_table()
    doctor_id = str(doctor_id or "").strip()
    token = _normalize_token(token)
    if not doctor_id:
        err = ValueError("doctor_id is required")
        setattr(err, "status", 400)
        raise err
    if not token:
        err = ValueError("token is required")
        setattr(err, "status", 400)
        raise err

    link = patient_links_repository.find_by_token(token, include_inactive=True)
    if not isinstance(link, dict):
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    if str(link.get("doctorId") or "").strip() != doctor_id:
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err

    review_status = _delegate_proposal_review_status(link)
    display_link_name = _link_display_name(link)

    return {
        "token": token,
        "doctorId": doctor_id,
        "createdAt": link.get("createdAt"),
        "expiresAt": link.get("expiresAt"),
        "patientId": link.get("patientId"),
        "patientReference": link.get("patientReference"),
        "subjectLabel": link.get("subjectLabel"),
        "studyLabel": link.get("studyLabel"),
        "linkName": display_link_name,
        "link_name": display_link_name,
        "referenceLabel": display_link_name,
        "label": display_link_name,
        "delegateName": link.get("delegateName"),
        "delegateContact": link.get("delegateContact"),
        "delegateRole": link.get("delegateRole"),
        "productScope": link.get("productScope") or DEFAULT_PRODUCT_SCOPE,
        "productScopeItems": link.get("productScopeItems") or [],
        "delegatePermission": link.get("delegatePermission") or DEFAULT_DELEGATE_PERMISSION,
        "markupPercent": _normalize_capped_markup_percent(link.get("markupPercent")),
        "pricingDisclosure": link.get("pricingDisclosure") or DEFAULT_PRICING_DISCLOSURE,
        "zelleRecipientName": link.get("zelleRecipientName"),
        "paymentConfirmationRequired": link.get("paymentConfirmationRequired"),
        "delegateInstructions": link.get("delegateInstructions"),
        "internalPhysicianNote": link.get("internalPhysicianNote"),
        "termsVersion": link.get("termsVersion"),
        "shippingPolicyVersion": link.get("shippingPolicyVersion"),
        "privacyPolicyVersion": link.get("privacyPolicyVersion"),
        "instructions": link.get("instructions"),
        "allowedProducts": link.get("allowedProducts") or [],
        "usageLimit": _link_usage_limit_for_response(link),
        "usageCount": link.get("usageCount"),
        "status": link.get("status"),
        "delegateCart": link.get("delegateCart"),
        "delegateShipping": link.get("delegateShipping"),
        "delegatePayment": link.get("delegatePayment"),
        "delegateSharedAt": link.get("delegateSharedAt"),
        "delegateOrderId": link.get("delegateOrderId"),
        "proposalStatus": review_status,
        "proposalReviewedAt": link.get("delegateReviewedAt"),
        "proposalReviewOrderId": link.get("delegateReviewOrderId"),
        "proposalReviewNotes": link.get("delegateReviewNotes"),
    }


def review_link_proposal(
    doctor_id: str,
    token: str,
    *,
    status: str,
    order_id: Optional[str] = None,
    amount_due: Optional[Any] = None,
    amount_due_currency: Optional[str] = None,
    notes: Optional[str] = None,
) -> Dict[str, Any]:
    if not _using_mysql():
        err = RuntimeError("MySQL backend is required for delegate links")
        setattr(err, "status", 501)
        raise err
    _migrate_legacy_links_to_table()
    doctor_id = str(doctor_id or "").strip()
    token = _normalize_token(token)
    if not doctor_id:
        err = ValueError("doctor_id is required")
        setattr(err, "status", 400)
        raise err
    if not token:
        err = ValueError("token is required")
        setattr(err, "status", 400)
        raise err

    link = patient_links_repository.find_by_token(token, include_inactive=True)
    if not isinstance(link, dict):
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    if str(link.get("doctorId") or "").strip() != doctor_id:
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    if not str(link.get("delegateSharedAt") or "").strip():
        err = ValueError("No proposal found for this link")
        setattr(err, "status", 409)
        raise err
    notes_value = _validate_delegate_review_notes(notes)
    amount_due_value = _normalize_currency_amount(amount_due)
    amount_due_currency_value = _normalize_currency_code(amount_due_currency) or "USD"
    delegate_payment_value: Optional[Dict[str, Any]] = None
    if amount_due_value is not None:
        existing_delegate_payment = link.get("delegatePayment")
        delegate_payment_value = (
            {**existing_delegate_payment}
            if isinstance(existing_delegate_payment, dict)
            else {}
        )
        delegate_payment_value["amountDue"] = amount_due_value
        delegate_payment_value["amountDueCurrency"] = amount_due_currency_value
        delegate_payment_value["amountDueUpdatedAt"] = datetime.now(timezone.utc).isoformat()

    ok = patient_links_repository.set_delegate_review_status(
        doctor_id,
        token,
        status=status,
        order_id=order_id,
        notes=notes_value,
        delegate_payment=delegate_payment_value,
        reviewed_at=datetime.now(timezone.utc),
    )
    if not ok:
        err = RuntimeError("Unable to update proposal status")
        setattr(err, "status", 502)
        raise err

    _audit_event(
        "proposal_reviewed",
        token=token,
        doctor_id=doctor_id,
        payload={
            "status": status,
            "orderId": order_id,
            "hasNotes": bool(notes_value),
            "amountDue": amount_due_value,
            "amountDueCurrency": amount_due_currency_value if amount_due_value is not None else None,
        },
    )

    updated = patient_links_repository.find_by_token(token, include_inactive=True) or {}
    review_status = (
        str(updated.get("delegateReviewStatus") or "").strip().lower()
        if isinstance(updated.get("delegateReviewStatus"), str)
        else None
    )
    resolved_order_id = (
        str(order_id or "").strip()
        or str(updated.get("delegateReviewOrderId") or "").strip()
    )
    if resolved_order_id:
        as_delegate_label = _link_display_name(updated) or "Delegate proposal"
        try:
            linked_order = order_repository.find_by_order_identifier(resolved_order_id)
            if isinstance(linked_order, dict):
                existing_label = str(
                    linked_order.get("asDelegate")
                    or linked_order.get("as_delegate")
                    or ""
                ).strip()
                if not existing_label and as_delegate_label:
                    linked_order["asDelegate"] = as_delegate_label[:190]
                    order_repository.update(linked_order)
        except Exception:
            token_metadata = safe_link_token_metadata(token, updated, doctor_id=doctor_id)
            logger.debug(
                "[Delegation] Unable to backfill as_delegate label for order_id=%s tokenHint=%s tokenHash=%s",
                resolved_order_id,
                token_metadata.get("tokenHint"),
                token_metadata.get("tokenHash"),
                exc_info=True,
            )
    return {
        "token": token,
        "proposalStatus": review_status or status,
        "proposalReviewedAt": updated.get("delegateReviewedAt"),
        "proposalReviewOrderId": updated.get("delegateReviewOrderId"),
        "proposalReviewNotes": updated.get("delegateReviewNotes"),
        "amountDue": (
            updated.get("delegatePayment").get("amountDue")
            if isinstance(updated.get("delegatePayment"), dict)
            else None
        ),
        "amountDueCurrency": (
            updated.get("delegatePayment").get("amountDueCurrency")
            if isinstance(updated.get("delegatePayment"), dict)
            else None
        ),
    }


def validate_delegate_items(token: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    normalized_token = _normalize_token(token)
    if not normalized_token:
        err = ValueError("token is required")
        setattr(err, "status", 400)
        raise err
    link = patient_links_repository.find_by_token(normalized_token)
    if not isinstance(link, dict):
        err = ValueError("Invalid or expired delegate link")
        setattr(err, "status", 404)
        raise err
    raw_product_scope = str(link.get("productScope") or DEFAULT_PRODUCT_SCOPE).strip().lower()
    if raw_product_scope == "category_or_protocol":
        err = ValueError("Category or protocol scoped delegate links are not enabled.")
        setattr(err, "status", 403)
        raise err
    product_scope = _normalize_product_scope(raw_product_scope)
    allowed_products = _normalize_allowed_products(link.get("allowedProducts") or [])
    if not allowed_products:
        allowed_products = _normalize_allowed_products(link.get("productScopeItems") or [])
    if not allowed_products:
        if product_scope in {"specific_products", "specific_cart_only", "category_or_protocol"}:
            err = ValueError("This link has no approved product scope.")
            setattr(err, "status", 403)
            raise err
        return {"link": link, "allowedProducts": [], "validatedItems": items or []}
    allowed_set = {entry.upper() for entry in allowed_products}
    validated_items: List[Dict[str, Any]] = []
    rejected_products: List[str] = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        sku = str(item.get("sku") or "").strip().upper()
        product_id = str(item.get("productId") or item.get("id") or "").strip().upper()
        if sku and sku in allowed_set:
            validated_items.append(item)
            continue
        if product_id and product_id in allowed_set:
            validated_items.append(item)
            continue
        rejected_products.append(str(item.get("name") or sku or product_id or "Unknown item"))
    if rejected_products:
        _audit_event(
            "disallowed_product_attempt",
            token=normalized_token,
            doctor_id=str(link.get("doctorId") or "").strip() or None,
            payload={"rejectedProducts": rejected_products, "allowedProducts": allowed_products},
        )
        err = ValueError("This delegate link is limited to approved products only.")
        setattr(err, "status", 403)
        raise err
    return {"link": link, "allowedProducts": allowed_products, "validatedItems": validated_items}
