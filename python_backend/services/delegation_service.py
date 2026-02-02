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
        for entry in links or []:
            token = str(entry.get("token") or "").strip()
            if not token:
                continue
            created_dt = _parse_iso_utc(entry.get("createdAt")) or now
            expires_dt = created_dt + timedelta(hours=patient_links_repository.TTL_HOURS)
            if expires_dt <= now:
                continue
            label_value = entry.get("label")
            label = str(label_value).strip() if isinstance(label_value, str) and str(label_value).strip() else None
            last_used = _parse_iso_utc(entry.get("lastUsedAt"))
            revoked = _parse_iso_utc(entry.get("revokedAt"))
            try:
                mysql_client.execute(
                    """
                    INSERT IGNORE INTO patient_links (
                        token, doctor_id, label, created_at, expires_at, last_used_at, revoked_at
                    ) VALUES (
                        %(token)s, %(doctor_id)s, %(label)s, %(created_at)s, %(expires_at)s, %(last_used_at)s, %(revoked_at)s
                    )
                    """,
                    {
                        "token": token,
                        "doctor_id": doctor_id,
                        "label": label,
                        "created_at": created_dt.replace(tzinfo=None),
                        "expires_at": expires_dt.replace(tzinfo=None),
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
    current = get_doctor_config(doctor_id)
    markup_percent = _normalize_markup_percent((patch or {}).get("markupPercent"))
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


def create_link(doctor_id: str, *, label: Optional[str] = None) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        raise ValueError("doctor_id is required")
    if _using_mysql():
        _migrate_legacy_links_to_table()
        return patient_links_repository.create_link(doctor_id, label=label)
    token = secrets.token_urlsafe(24)
    now = datetime.now(timezone.utc).isoformat()
    link = {
        "token": token,
        "label": str(label).strip() if isinstance(label, str) and str(label).strip() else None,
        "createdAt": now,
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
    label: Optional[str] = None,
    revoke: Optional[bool] = None,
) -> Dict[str, Any]:
    doctor_id = str(doctor_id or "").strip()
    token = _normalize_token(token)
    if not doctor_id:
        raise ValueError("doctor_id is required")
    if not token:
        raise ValueError("token is required")
    if _using_mysql():
        _migrate_legacy_links_to_table()
        updated = patient_links_repository.update_link(doctor_id, token, label=label, revoke=revoke)
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
        if label is not None:
            entry["label"] = str(label).strip() if isinstance(label, str) and str(label).strip() else None
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
        config = get_doctor_config(doctor_id)

        return {
            "token": token,
            "doctorId": doctor_id,
            "doctorName": doctor_name,
            "markupPercent": float(config.get("markupPercent") or 0.0),
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
    config = get_doctor_config(doctor_id)

    return {
        "token": token,
        "doctorId": doctor_id,
        "doctorName": doctor_name,
        "markupPercent": float(config.get("markupPercent") or 0.0),
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
