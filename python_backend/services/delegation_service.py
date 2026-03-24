from __future__ import annotations

import json
import logging
import re
import secrets
import threading
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


def _patient_link_default_expiry_hours() -> int:
    try:
        value = int(float(_patient_link_settings().get("patientLinkDefaultExpiryHours") or patient_links_repository.TTL_HOURS))
    except Exception:
        value = patient_links_repository.TTL_HOURS
    return max(1, min(value, 24 * 30))


def _patient_link_max_markup_percent() -> float:
    try:
        value = float(_patient_link_settings().get("patientLinkMaxMarkupPercent") or 20.0)
    except Exception:
        value = 20.0
    return max(0.0, min(value, 100.0))


def _normalize_capped_markup_percent(value: object) -> float:
    capped = min(_normalize_markup_percent(value), _patient_link_max_markup_percent())
    return round(capped + 1e-9, 2)


def _normalize_usage_limit(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        parsed = int(float(value))
    except Exception:
        return None
    return max(1, min(parsed, 10_000))


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
    return "Your physician does not receive compensation from this PepPro transaction."


def _research_supply_disclosures(markup_percent: object) -> List[str]:
    return [
        "PepPro provides research materials only. Products are not intended for human consumption.",
        "PepPro does not provide prescriptions, treatment, dosing, therapy, or patient instructions.",
        "Physicians are responsible for any independent research protocols.",
        "PepPro does not direct or control physician activities.",
        _compensation_disclosure(markup_percent),
    ]


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
    metadata = {
        **(payload or {}),
        "ip": request_ip.split(",")[0].strip() if request_ip else None,
        "userAgent": request.headers.get("User-Agent"),
    }
    patient_links_repository.insert_audit_event(
        token=token,
        doctor_id=doctor_id,
        actor_user_id=str(actor.get("id") or "").strip() or None,
        actor_role=str(actor.get("role") or "").strip() or None,
        event_type=event_type,
        payload=metadata,
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
            expires_dt = created_dt + timedelta(hours=patient_links_repository.TTL_HOURS)
            if expires_dt <= now:
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
                        "expires_at": expires_dt.replace(tzinfo=None),
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
        return patient_links_repository.list_links(doctor_id)
    links = _load_links(doctor_id)
    # Sort most recent first.
    def sort_key(entry: Dict[str, Any]) -> str:
        return str(entry.get("createdAt") or "")
    links.sort(key=sort_key, reverse=True)
    return links


def create_link(
    doctor_id: str,
    *,
    reference_label: Optional[str] = None,
    patient_id: Optional[str] = None,
    subject_label: Optional[str] = None,
    study_label: Optional[str] = None,
    patient_reference: Optional[str] = None,
    markup_percent: Optional[object] = None,
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
    if _using_mysql():
        _migrate_legacy_links_to_table()
        markup_value = None if markup_percent is None else _normalize_capped_markup_percent(markup_percent)
        created = patient_links_repository.create_link(
            doctor_id,
            reference_label=_validate_non_phi_label(reference_label, field_name="referenceLabel"),
            patient_id=_validate_non_phi_label(patient_id, field_name="patientId"),
            subject_label=_validate_non_phi_label(subject_label, field_name="subjectLabel"),
            study_label=_validate_non_phi_label(study_label, field_name="studyLabel"),
            patient_reference=_validate_non_phi_label(patient_reference, field_name="patientReference"),
            markup_percent=markup_value,
            instructions=_validate_research_note(instructions, field_name="instructions"),
            allowed_products=_normalize_allowed_products(allowed_products),
            expires_in_hours=_normalize_usage_limit(expires_in_hours) or _patient_link_default_expiry_hours(),
            usage_limit=_normalize_usage_limit(usage_limit),
            payment_method=payment_method,
            payment_instructions=_validate_research_note(payment_instructions, field_name="paymentInstructions"),
            physician_certified=physician_certified,
        )
        _audit_event(
            "link_created",
            token=created.get("token"),
            doctor_id=doctor_id,
            payload={
                "subjectLabel": created.get("subjectLabel"),
                "studyLabel": created.get("studyLabel"),
                "patientReference": created.get("patientReference"),
                "allowedProducts": created.get("allowedProducts"),
                "expiresAt": created.get("expiresAt"),
                "usageLimit": created.get("usageLimit"),
                "markupPercent": created.get("markupPercent"),
            },
        )
        return created
    token = secrets.token_urlsafe(24)
    now = datetime.now(timezone.utc).isoformat()
    config = get_doctor_config(doctor_id)
    markup_value = (
        _normalize_capped_markup_percent(config.get("markupPercent"))
        if markup_percent is None
        else _normalize_capped_markup_percent(markup_percent)
    )
    subject_value = _validate_non_phi_label(subject_label or patient_id, field_name="subjectLabel")
    study_value = _validate_non_phi_label(study_label, field_name="studyLabel")
    patient_reference_value = _validate_non_phi_label(patient_reference or reference_label, field_name="patientReference")
    allowed_products_value = _normalize_allowed_products(allowed_products)
    usage_limit_value = _normalize_usage_limit(usage_limit)
    expires_hours_value = _normalize_usage_limit(expires_in_hours) or _patient_link_default_expiry_hours()
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=expires_hours_value)).isoformat()
    link = {
        "token": token,
        "patientId": subject_value,
        "patientReference": patient_reference_value,
        "referenceLabel": patient_reference_value or study_value,
        "label": patient_reference_value or study_value,
        "subjectLabel": subject_value,
        "studyLabel": study_value,
        "createdAt": now,
        "expiresAt": expires_at,
        "markupPercent": float(markup_value or 0.0),
        "instructions": _validate_research_note(instructions, field_name="instructions"),
        "allowedProducts": allowed_products_value,
        "usageLimit": usage_limit_value,
        "usageCount": 0,
        "openCount": 0,
        "status": "active",
        "receivedPayment": False,
        "physicianCertified": bool(physician_certified),
        "lastUsedAt": None,
        "lastOpenedAt": None,
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
    reference_label: Optional[str] = None,
    patient_id: Optional[str] = None,
    subject_label: Optional[str] = None,
    study_label: Optional[str] = None,
    patient_reference: Optional[str] = None,
    revoke: Optional[bool] = None,
    markup_percent: Optional[object] = None,
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
        updated = patient_links_repository.update_link(
            doctor_id,
            token,
            reference_label=_validate_non_phi_label(reference_label, field_name="referenceLabel") if reference_label is not None else None,
            patient_id=_validate_non_phi_label(patient_id, field_name="patientId") if patient_id is not None else None,
            subject_label=_validate_non_phi_label(subject_label, field_name="subjectLabel") if subject_label is not None else None,
            study_label=_validate_non_phi_label(study_label, field_name="studyLabel") if study_label is not None else None,
            patient_reference=_validate_non_phi_label(patient_reference, field_name="patientReference") if patient_reference is not None else None,
            revoke=revoke,
            markup_percent=markup_value,
            instructions=_validate_research_note(instructions, field_name="instructions") if instructions is not None else None,
            allowed_products=_normalize_allowed_products(allowed_products) if allowed_products is not None else None,
            expires_in_hours=_normalize_usage_limit(expires_in_hours) if expires_in_hours is not None else None,
            usage_limit=_normalize_usage_limit(usage_limit) if usage_limit is not None else None,
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
                "usageLimit": updated.get("usageLimit"),
                "allowedProducts": updated.get("allowedProducts"),
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
        if reference_label is not None or patient_reference is not None:
            patient_reference_value = _validate_non_phi_label(patient_reference or reference_label, field_name="patientReference")
            entry["patientReference"] = patient_reference_value
            entry["referenceLabel"] = patient_reference_value
        if patient_id is not None or subject_label is not None:
            entry["patientId"] = _validate_non_phi_label(subject_label or patient_id, field_name="subjectLabel")
        if study_label is not None:
            entry["studyLabel"] = _validate_non_phi_label(study_label, field_name="studyLabel")
        if markup_percent is not None:
            entry["markupPercent"] = float(_normalize_capped_markup_percent(markup_percent) or 0.0)
        if instructions is not None:
            entry["instructions"] = _validate_research_note(instructions, field_name="instructions")
        if allowed_products is not None:
            entry["allowedProducts"] = _normalize_allowed_products(allowed_products)
        if usage_limit is not None:
            entry["usageLimit"] = _normalize_usage_limit(usage_limit)
        if expires_in_hours is not None:
            entry["expiresAt"] = (datetime.now(timezone.utc) + timedelta(hours=_normalize_usage_limit(expires_in_hours) or _patient_link_default_expiry_hours())).isoformat()
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


def resolve_delegate_token(token: str) -> Dict[str, Any]:
    token = _normalize_token(token)
    if not token:
        err = ValueError("token is required")
        setattr(err, "status", 400)
        raise err

    if _using_mysql():
        _migrate_legacy_links_to_table()
        # Allow exhausted links to be resolved so delegates can still view
        # proposal review outcomes (accepted/modified/rejected + notes).
        # Revoked/expired links remain inaccessible.
        link = patient_links_repository.find_by_token(token, include_inactive=True)
        if not isinstance(link, dict):
            err = ValueError("Invalid or expired delegate link")
            setattr(err, "status", 404)
            raise err
        doctor_id = str(link.get("doctorId") or "").strip()
        if not doctor_id or str(link.get("revokedAt") or "").strip():
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

        try:
            patient_links_repository.touch_last_used(token)
        except Exception:
            pass
        _audit_event("link_opened", token=token, doctor_id=doctor_id, payload={"status": link.get("status")})

        doctor_name = (doctor.get("name") or doctor.get("email") or "Doctor") if isinstance(doctor, dict) else "Doctor"

        review_status = (
            str(link.get("delegateReviewStatus") or "").strip().lower()
            if isinstance(link.get("delegateReviewStatus"), str)
            else None
        )
        if not review_status:
            review_status = "pending" if str(link.get("delegateSharedAt") or "").strip() else None

        return {
            "token": token,
            "doctorId": doctor_id,
            "doctorName": doctor_name,
            "markupPercent": _normalize_capped_markup_percent(link.get("markupPercent")),
            "doctorLogoUrl": doctor.get("delegateLogoUrl") if isinstance(doctor, dict) else None,
            "doctorSecondaryColor": doctor.get("delegateSecondaryColor") if isinstance(doctor, dict) else None,
            "subjectLabel": link.get("subjectLabel"),
            "studyLabel": link.get("studyLabel"),
            "patientReference": link.get("patientReference"),
            "instructions": link.get("instructions"),
            "allowedProducts": link.get("allowedProducts") or [],
            "usageLimit": link.get("usageLimit"),
            "usageCount": link.get("usageCount"),
            "status": link.get("status") or "active",
            "paymentMethod": link.get("paymentMethod") if isinstance(link, dict) else None,
            "paymentInstructions": link.get("paymentInstructions") if isinstance(link, dict) else None,
            "createdAt": link.get("createdAt"),
            "expiresAt": link.get("expiresAt"),
            "delegateSharedAt": link.get("delegateSharedAt"),
            "delegateOrderId": link.get("delegateOrderId"),
            "proposalStatus": review_status,
            "proposalReviewedAt": link.get("delegateReviewedAt"),
            "proposalReviewOrderId": link.get("delegateReviewOrderId"),
            "proposalReviewNotes": link.get("delegateReviewNotes"),
            "disclosures": _research_supply_disclosures(link.get("markupPercent")),
            "compensationDisclosure": _compensation_disclosure(link.get("markupPercent")),
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

    now = datetime.now(timezone.utc).isoformat()
    link["lastUsedAt"] = now
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
    return {
        "token": token,
        "doctorId": doctor_id,
        "doctorName": doctor_name,
        "markupPercent": float(_normalize_capped_markup_percent(link.get("markupPercent")) or 0.0),
        "allowedProducts": link.get("allowedProducts") or [],
        "subjectLabel": link.get("subjectLabel"),
        "studyLabel": link.get("studyLabel"),
        "patientReference": link.get("patientReference"),
        "instructions": link.get("instructions"),
        "disclosures": _research_supply_disclosures(link.get("markupPercent")),
        "compensationDisclosure": _compensation_disclosure(link.get("markupPercent")),
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
    link = patient_links_repository.find_by_token(token, include_inactive=True) or {}
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
                "allowedProducts": link.get("allowedProducts") or [],
            },
        )
        doctor_id = str(link.get("doctorId") or "").strip()
        if doctor_id:
            try:
                doctor = user_repository.find_by_id(doctor_id) or {}
                recipient = str(doctor.get("email") or "").strip()
                if recipient:
                    proposal_label = (
                        str(link.get("referenceLabel") or "").strip()
                        or str(link.get("patientReference") or "").strip()
                        or str(link.get("studyLabel") or "").strip()
                        or str(link.get("subjectLabel") or "").strip()
                        or "Delegate proposal"
                    )
                    email_service.send_delegate_proposal_ready_email(
                        recipient,
                        doctor_name=str(doctor.get("name") or "").strip() or None,
                        proposal_label=proposal_label,
                        submitted_at=submitted_at,
                    )
            except Exception:
                logger.exception(
                    "[Delegation] Failed to send delegate proposal ready email",
                    extra={"token": token, "doctorId": doctor_id},
                )
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

    review_status = (
        str(link.get("delegateReviewStatus") or "").strip().lower()
        if isinstance(link.get("delegateReviewStatus"), str)
        else None
    )
    if not review_status:
        review_status = "pending" if str(link.get("delegateSharedAt") or "").strip() else None

    return {
        "token": token,
        "doctorId": doctor_id,
        "createdAt": link.get("createdAt"),
        "expiresAt": link.get("expiresAt"),
        "patientId": link.get("patientId"),
        "patientReference": link.get("patientReference"),
        "subjectLabel": link.get("subjectLabel"),
        "studyLabel": link.get("studyLabel"),
        "referenceLabel": link.get("referenceLabel") or link.get("label"),
        "label": link.get("referenceLabel") or link.get("label"),
        "markupPercent": link.get("markupPercent"),
        "instructions": link.get("instructions"),
        "allowedProducts": link.get("allowedProducts") or [],
        "usageLimit": link.get("usageLimit"),
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

    ok = patient_links_repository.set_delegate_review_status(
        doctor_id,
        token,
        status=status,
        order_id=order_id,
        notes=notes_value,
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
        payload={"status": status, "orderId": order_id, "hasNotes": bool(notes_value)},
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
        as_delegate_label = (
            str(updated.get("referenceLabel") or "").strip()
            or str(updated.get("reference_label") or "").strip()
            or str(updated.get("label") or "").strip()
            or "Delegate Order"
        )
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
            logger.debug(
                "[Delegation] Unable to backfill as_delegate label for order_id=%s token=%s",
                resolved_order_id,
                token,
                exc_info=True,
            )
    return {
        "token": token,
        "proposalStatus": review_status or status,
        "proposalReviewedAt": updated.get("delegateReviewedAt"),
        "proposalReviewOrderId": updated.get("delegateReviewOrderId"),
        "proposalReviewNotes": updated.get("delegateReviewNotes"),
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
    allowed_products = _normalize_allowed_products(link.get("allowedProducts") or [])
    if not allowed_products:
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
