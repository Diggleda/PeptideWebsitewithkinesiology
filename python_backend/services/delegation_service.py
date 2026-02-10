from __future__ import annotations

import json
import logging
import secrets
import threading
from datetime import timedelta
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from ..database import mysql_client
from ..repositories import patient_links_repository
from ..repositories import user_repository
from ..services import get_config
from ..services import settings_service  # type: ignore[attr-defined]
from ..storage import settings_store

logger = logging.getLogger(__name__)

_LINKS_KEY_PREFIX = "delegation_links_v1:"
_CONFIG_KEY_PREFIX = "delegation_config_v1:"
_INDEX_KEY = "delegation_link_index_v1"
_LEGACY_MIGRATED = False
_LEGACY_MIGRATION_LOCK = threading.Lock()


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
        return {"markupPercent": 0.0}
    if _using_mysql():
        _migrate_legacy_links_to_table()
        doctor = user_repository.find_by_id(doctor_id) or {}
        value = doctor.get("markupPercent") if isinstance(doctor, dict) else 0.0
        try:
            return {"markupPercent": _normalize_markup_percent(value)}
        except Exception:
            return {"markupPercent": 0.0}
    key = _config_key(doctor_id)
    payload = _sql_read_key(key)
    if payload is None:
        store = _read_store_dict()
        payload = store.get(key)
    if not isinstance(payload, dict):
        payload = {}
    markup_percent = _normalize_markup_percent(payload.get("markupPercent") or payload.get("markup_percent") or 0)
    return {"markupPercent": markup_percent}


def update_doctor_config(doctor_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        raise ValueError("doctor_id is required")
    markup_percent = _normalize_markup_percent((patch or {}).get("markupPercent"))
    if _using_mysql():
        _migrate_legacy_links_to_table()
        # Persist on the doctor user record (non-volatile across sessions).
        existing = user_repository.find_by_id(doctor_id) or None
        if not isinstance(existing, dict) or not existing:
            raise ValueError("Doctor not found")
        user_repository.update({**existing, "markupPercent": markup_percent})
        return {"markupPercent": markup_percent}
    current = get_doctor_config(doctor_id)
    merged = {**current, "markupPercent": markup_percent}
    key = _config_key(doctor_id)
    store = _read_store_dict()
    store[key] = merged
    _write_store_dict(store)
    _sql_write_key(key, merged)
    return merged


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
    markup_percent: Optional[object] = None,
) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        raise ValueError("doctor_id is required")
    if _using_mysql():
        _migrate_legacy_links_to_table()
        markup_value = None if markup_percent is None else _normalize_markup_percent(markup_percent)
        return patient_links_repository.create_link(
            doctor_id,
            reference_label=reference_label,
            patient_id=patient_id,
            markup_percent=markup_value,
        )
    token = secrets.token_urlsafe(24)
    now = datetime.now(timezone.utc).isoformat()
    config = get_doctor_config(doctor_id)
    markup_value = (
        _normalize_markup_percent(config.get("markupPercent"))
        if markup_percent is None
        else _normalize_markup_percent(markup_percent)
    )
    link = {
        "token": token,
        "patientId": str(patient_id).strip() if isinstance(patient_id, str) and str(patient_id).strip() else None,
        "referenceLabel": (
            str(reference_label).strip() if isinstance(reference_label, str) and str(reference_label).strip() else None
        ),
        "createdAt": now,
        "markupPercent": float(markup_value or 0.0),
        "lastUsedAt": None,
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
    revoke: Optional[bool] = None,
    markup_percent: Optional[object] = None,
) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    token = _normalize_token(token)
    if not doctor_id:
        raise ValueError("doctor_id is required")
    if not token:
        raise ValueError("token is required")
    if _using_mysql():
        _migrate_legacy_links_to_table()
        markup_value = None if markup_percent is None else _normalize_markup_percent(markup_percent)
        updated = patient_links_repository.update_link(
            doctor_id,
            token,
            reference_label=reference_label,
            patient_id=patient_id,
            revoke=revoke,
            markup_percent=markup_value,
        )
        if updated is None:
            err = ValueError("Link not found")
            setattr(err, "status", 404)
            raise err
        return updated

    links = _load_links(doctor_id)
    now = datetime.now(timezone.utc).isoformat()
    updated = None
    for entry in links:
        if str(entry.get("token") or "") != token:
            continue
        if reference_label is not None:
            entry["referenceLabel"] = (
                str(reference_label).strip()
                if isinstance(reference_label, str) and str(reference_label).strip()
                else None
            )
        if patient_id is not None:
            entry["patientId"] = str(patient_id).strip() if isinstance(patient_id, str) and str(patient_id).strip() else None
        if markup_percent is not None:
            entry["markupPercent"] = float(_normalize_markup_percent(markup_percent) or 0.0)
        if revoke is True:
            entry["revokedAt"] = entry.get("revokedAt") or now
        if revoke is False:
            entry["revokedAt"] = None
        updated = entry
        break
    if updated is None:
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    _persist_links(doctor_id, links)
    return updated


def resolve_delegate_token(token: str) -> Dict[str, Any]:
    token = _normalize_token(token)
    if not token:
        err = ValueError("token is required")
        setattr(err, "status", 400)
        raise err

    if _using_mysql():
        _migrate_legacy_links_to_table()
        link = patient_links_repository.find_by_token(token)
        if not isinstance(link, dict):
            err = ValueError("Invalid or expired delegation link")
            setattr(err, "status", 404)
            raise err
        doctor_id = str(link.get("doctorId") or "").strip()
        if not doctor_id or str(link.get("revokedAt") or "").strip():
            err = ValueError("Invalid or expired delegation link")
            setattr(err, "status", 404)
            raise err

        doctor = user_repository.find_by_id(doctor_id) or None
        if not isinstance(doctor, dict) or not doctor:
            err = ValueError("Invalid or expired delegation link")
            setattr(err, "status", 404)
            raise err

        settings = settings_service.get_settings()
        patient_links_enabled = bool(settings.get("patientLinksEnabled", False))
        doctor_role = str(doctor.get("role") or "").strip().lower()
        is_test_doctor = doctor_role == "test_doctor"
        if not patient_links_enabled and not is_test_doctor:
            err = ValueError("Invalid or expired delegation link")
            setattr(err, "status", 404)
            raise err

        try:
            patient_links_repository.touch_last_used(token)
        except Exception:
            pass

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
            "markupPercent": _normalize_markup_percent(link.get("markupPercent")),
            "doctorLogoUrl": doctor.get("delegateLogoUrl") if isinstance(doctor, dict) else None,
            "createdAt": link.get("createdAt"),
            "expiresAt": link.get("expiresAt"),
            "delegateSharedAt": link.get("delegateSharedAt"),
            "delegateOrderId": link.get("delegateOrderId"),
            "proposalStatus": review_status,
            "proposalReviewedAt": link.get("delegateReviewedAt"),
            "proposalReviewOrderId": link.get("delegateReviewOrderId"),
        }

    index = _load_index()
    entry = index.get(token) if isinstance(index, dict) else None
    doctor_id = str(entry.get("doctorId") or "").strip() if isinstance(entry, dict) else ""
    if not doctor_id:
        err = ValueError("Invalid or expired delegation link")
        setattr(err, "status", 404)
        raise err

    links = _load_links(doctor_id)
    link = next((l for l in links if str(l.get("token") or "") == token), None)
    if not isinstance(link, dict) or str(link.get("revokedAt") or "").strip():
        err = ValueError("Invalid or expired delegation link")
        setattr(err, "status", 404)
        raise err

    now = datetime.now(timezone.utc).isoformat()
    link["lastUsedAt"] = now
    _persist_links(doctor_id, links)

    doctor = user_repository.find_by_id(doctor_id) or None
    if not isinstance(doctor, dict) or not doctor:
        err = ValueError("Invalid or expired delegation link")
        setattr(err, "status", 404)
        raise err

    settings = settings_service.get_settings()
    patient_links_enabled = bool(settings.get("patientLinksEnabled", False))
    doctor_role = str(doctor.get("role") or "").strip().lower()
    is_test_doctor = doctor_role == "test_doctor"
    if not patient_links_enabled and not is_test_doctor:
        err = ValueError("Invalid or expired delegation link")
        setattr(err, "status", 404)
        raise err

    doctor_name = (doctor.get("name") or doctor.get("email") or "Doctor") if isinstance(doctor, dict) else "Doctor"
    return {
        "token": token,
        "doctorId": doctor_id,
        "doctorName": doctor_name,
        "markupPercent": float(_normalize_markup_percent(link.get("markupPercent")) or 0.0),
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
    ok = patient_links_repository.store_delegate_payload(
        token,
        cart=cart,
        shipping=shipping,
        payment=payment,
        order_id=order_id,
        shared_at=shared_at,
    )
    if ok:
        return
    err = RuntimeError("Unable to persist delegate payload")
    setattr(err, "status", 502)
    raise err


def get_link_proposal(doctor_id: str, token: str) -> Dict[str, Any]:
    if not _using_mysql():
        err = RuntimeError("MySQL backend is required for patient links")
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

    link = patient_links_repository.find_by_token(token)
    if not isinstance(link, dict):
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    if str(link.get("doctorId") or "").strip() != doctor_id or str(link.get("revokedAt") or "").strip():
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
        "referenceLabel": link.get("referenceLabel") or link.get("label"),
        "label": link.get("referenceLabel") or link.get("label"),
        "markupPercent": link.get("markupPercent"),
        "delegateCart": link.get("delegateCart"),
        "delegateShipping": link.get("delegateShipping"),
        "delegatePayment": link.get("delegatePayment"),
        "delegateSharedAt": link.get("delegateSharedAt"),
        "delegateOrderId": link.get("delegateOrderId"),
        "proposalStatus": review_status,
        "proposalReviewedAt": link.get("delegateReviewedAt"),
        "proposalReviewOrderId": link.get("delegateReviewOrderId"),
    }


def review_link_proposal(
    doctor_id: str,
    token: str,
    *,
    status: str,
    order_id: Optional[str] = None,
) -> Dict[str, Any]:
    if not _using_mysql():
        err = RuntimeError("MySQL backend is required for patient links")
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

    link = patient_links_repository.find_by_token(token)
    if not isinstance(link, dict):
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    if str(link.get("doctorId") or "").strip() != doctor_id or str(link.get("revokedAt") or "").strip():
        err = ValueError("Link not found")
        setattr(err, "status", 404)
        raise err
    if not str(link.get("delegateSharedAt") or "").strip():
        err = ValueError("No proposal found for this link")
        setattr(err, "status", 409)
        raise err

    ok = patient_links_repository.set_delegate_review_status(
        doctor_id,
        token,
        status=status,
        order_id=order_id,
        reviewed_at=datetime.now(timezone.utc),
    )
    if not ok:
        err = RuntimeError("Unable to update proposal status")
        setattr(err, "status", 502)
        raise err

    updated = patient_links_repository.find_by_token(token) or {}
    review_status = (
        str(updated.get("delegateReviewStatus") or "").strip().lower()
        if isinstance(updated.get("delegateReviewStatus"), str)
        else None
    )
    return {
        "token": token,
        "proposalStatus": review_status or status,
        "proposalReviewedAt": updated.get("delegateReviewedAt"),
        "proposalReviewOrderId": updated.get("delegateReviewOrderId"),
    }
