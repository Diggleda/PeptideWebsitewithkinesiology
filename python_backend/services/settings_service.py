from __future__ import annotations

import logging
import json
from typing import Any, Dict, Optional
from datetime import datetime, timezone

from ..database import mysql_client
from ..services import get_config
from ..storage import settings_store

logger = logging.getLogger(__name__)

DEFAULT_SETTINGS: Dict[str, Any] = {
    "shopEnabled": True,
    "peptideForumEnabled": True,
    "researchDashboardEnabled": False,
    # When enabled, show Patient Links tab for all doctors (test doctors always have access).
    "patientLinksEnabled": False,
    # "test" | "live" | None (None = follow env)
    "stripeMode": None,
    # When enabled, allow $0.01 "test" checkouts for admin/test_doctor.
    "testPaymentsOverrideEnabled": False,
    # ISO timestamp (admin report)
    "salesBySalesRepCsvDownloadedAt": None,
    # ISO timestamp (sales lead report)
    "salesLeadSalesBySalesRepCsvDownloadedAt": None,
    # ISO timestamp (admin report)
    "taxesByStateCsvDownloadedAt": None,
    # ISO timestamp (admin report)
    "productsCommissionCsvDownloadedAt": None,
}

_STRIPE_SECRET_PREFIXES = {
    "live": ("sk_live", "rk_live"),
    "test": ("sk_test", "rk_test"),
}
_STRIPE_PUBLISHABLE_PREFIXES = {
    "live": ("pk_live",),
    "test": ("pk_test",),
}


def _matches_prefix(value: str, prefixes: tuple[str, ...]) -> bool:
    cleaned = (value or "").strip()
    if not cleaned:
        return False
    return any(cleaned.startswith(prefix) for prefix in prefixes)


def _resolve_stripe_key_for_mode(
    *,
    effective_mode: str,
    live_key: str,
    test_key: str,
    prefixes: Dict[str, tuple[str, ...]],
) -> str:
    mode = "live" if str(effective_mode).strip().lower() == "live" else "test"
    expected = prefixes.get(mode) or ()
    if _matches_prefix(live_key, expected):
        return live_key
    if _matches_prefix(test_key, expected):
        return test_key
    return ""


def _to_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    return text in ("1", "true", "yes", "on")


def _normalize_mode(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("test", "live"):
        return text
    return None


def _normalize_iso_timestamp(value: Any) -> Optional[str]:
    if value is None:
        return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        parsed = parsed.astimezone(timezone.utc)
        return parsed.isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def normalize_settings(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    merged: Dict[str, Any] = {**DEFAULT_SETTINGS, **(data or {})}
    merged["shopEnabled"] = _to_bool(merged.get("shopEnabled", True))
    merged["peptideForumEnabled"] = _to_bool(merged.get("peptideForumEnabled", True))
    merged["researchDashboardEnabled"] = _to_bool(merged.get("researchDashboardEnabled", False))
    merged["patientLinksEnabled"] = _to_bool(merged.get("patientLinksEnabled", False))
    merged["stripeMode"] = _normalize_mode(merged.get("stripeMode"))
    merged["testPaymentsOverrideEnabled"] = _to_bool(merged.get("testPaymentsOverrideEnabled", False))
    merged["salesBySalesRepCsvDownloadedAt"] = _normalize_iso_timestamp(
        merged.get("salesBySalesRepCsvDownloadedAt")
    )
    merged["salesLeadSalesBySalesRepCsvDownloadedAt"] = _normalize_iso_timestamp(
        merged.get("salesLeadSalesBySalesRepCsvDownloadedAt")
    )
    merged["taxesByStateCsvDownloadedAt"] = _normalize_iso_timestamp(
        merged.get("taxesByStateCsvDownloadedAt")
    )
    merged["productsCommissionCsvDownloadedAt"] = _normalize_iso_timestamp(
        merged.get("productsCommissionCsvDownloadedAt")
    )
    return merged


def _load_from_store() -> Optional[Dict[str, Any]]:
    if not settings_store:
        return None
    try:
        raw = settings_store.read() or {}
        if isinstance(raw, dict):
            return normalize_settings(raw)
    except Exception:
        logger.debug("settings_store read failed", exc_info=True)
    return None


def _load_from_sql() -> Optional[Dict[str, Any]]:
    if not bool(get_config().mysql.get("enabled")):
        logger.debug("Settings SQL read skipped (MySQL disabled)")
        return None
    try:
        keys = list(DEFAULT_SETTINGS.keys())
        placeholders = ",".join([f"%({f'k{i+1}'})s" for i in range(len(keys))])
        params = {f"k{i+1}": keys[i] for i in range(len(keys))}
        rows = mysql_client.fetch_all(
            f"SELECT `key`, value_json FROM settings WHERE `key` IN ({placeholders})",
            params,
        )
        if not rows or not isinstance(rows, list):
            return None
        merged = dict(DEFAULT_SETTINGS)
        for row in rows:
            key = (row or {}).get("key")
            if key in DEFAULT_SETTINGS and "value_json" in row:
                raw = row.get("value_json")
                if isinstance(raw, (bytes, bytearray)):
                    try:
                        raw = raw.decode("utf-8")
                    except Exception:
                        raw = None
                if isinstance(raw, str):
                    try:
                        merged[key] = json.loads(raw)
                    except Exception:
                        merged[key] = raw
                else:
                    merged[key] = raw
        return normalize_settings(merged)
    except Exception:
        logger.warning("settings SQL read failed", exc_info=True)
        return None


def _persist_to_store(settings: Dict[str, Any]) -> None:
    if not settings_store:
        return
    try:
        settings_store.write(normalize_settings(settings))
    except Exception:
        logger.debug("settings_store write failed", exc_info=True)


def _persist_to_sql(settings: Dict[str, Any]) -> None:
    if not bool(get_config().mysql.get("enabled")):
        logger.debug("Settings SQL write skipped (MySQL disabled)")
        return
    normalized = normalize_settings(settings)
    try:
        for key in DEFAULT_SETTINGS.keys():
            value_json = json.dumps(normalized.get(key))
            mysql_client.execute(
                """
                INSERT INTO settings (`key`, value_json, updated_at)
                VALUES (%(key)s, %(value)s, NOW())
                ON DUPLICATE KEY UPDATE
                  updated_at = IF(value_json <=> VALUES(value_json), updated_at, NOW()),
                  value_json = VALUES(value_json)
                """,
                {"key": key, "value": value_json},
            )
            logger.debug("Settings key persisted to SQL", extra={"key": key})
        logger.info("Settings SQL write completed", extra={"keys": list(DEFAULT_SETTINGS.keys())})
    except Exception:
        logger.error("settings SQL write failed", exc_info=True)
        raise


def get_settings() -> Dict[str, Any]:
    # Prefer MySQL when enabled (shared source of truth), otherwise use local JSON store.
    if bool(get_config().mysql.get("enabled")):
        sql = _load_from_sql()
        if sql is not None:
            _persist_to_store(sql)
            return sql
        store = _load_from_store()
        if store is not None:
            return store
        return dict(DEFAULT_SETTINGS)

    store = _load_from_store()
    if store is not None:
        return store
    return dict(DEFAULT_SETTINGS)


def update_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    current = get_settings()
    merged = normalize_settings({**current, **(patch or {})})
    _persist_to_store(merged)
    if bool(get_config().mysql.get("enabled")):
        _persist_to_sql(merged)
        confirmed = _load_from_sql()
        if confirmed is not None:
            _persist_to_store(confirmed)
            return confirmed
    return merged


def get_effective_stripe_mode() -> str:
    settings = get_settings()
    override = settings.get("stripeMode")
    if override in ("test", "live"):
        return override
    config = get_config()
    raw = str(config.stripe.get("mode") or "test").strip().lower()
    return "live" if raw == "live" else "test"


def resolve_stripe_publishable_key(mode: Optional[str] = None) -> str:
    config = get_config()
    effective = mode or get_effective_stripe_mode()
    live_key = str(
        config.stripe.get("publishable_key_live")
        or config.stripe.get("publishable_key")
        or ""
    ).strip()
    test_key = str(config.stripe.get("publishable_key_test") or "").strip()
    return _resolve_stripe_key_for_mode(
        effective_mode=effective,
        live_key=live_key,
        test_key=test_key,
        prefixes=_STRIPE_PUBLISHABLE_PREFIXES,
    )


def resolve_stripe_secret_key(mode: Optional[str] = None) -> str:
    config = get_config()
    effective = mode or get_effective_stripe_mode()
    live_key = str(config.stripe.get("secret_key_live") or config.stripe.get("secret_key") or "").strip()
    test_key = str(config.stripe.get("secret_key_test") or "").strip()
    return _resolve_stripe_key_for_mode(
        effective_mode=effective,
        live_key=live_key,
        test_key=test_key,
        prefixes=_STRIPE_SECRET_PREFIXES,
    )
