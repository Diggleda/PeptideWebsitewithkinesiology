from __future__ import annotations

import logging
import json
from typing import Any, Dict, Optional

from ..database import mysql_client
from ..services import get_config
from ..storage import settings_store

logger = logging.getLogger(__name__)

DEFAULT_SETTINGS: Dict[str, Any] = {
    "shopEnabled": True,
    # "test" | "live" | None (None = follow env)
    "stripeMode": None,
}


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


def normalize_settings(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    merged: Dict[str, Any] = {**DEFAULT_SETTINGS, **(data or {})}
    merged["shopEnabled"] = _to_bool(merged.get("shopEnabled", True))
    merged["stripeMode"] = _normalize_mode(merged.get("stripeMode"))
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
        rows = mysql_client.fetch_all(
            "SELECT `key`, value_json FROM settings WHERE `key` IN (%(k1)s,%(k2)s)",
            {"k1": "shopEnabled", "k2": "stripeMode"},
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
                ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = NOW()
                """,
                {"key": key, "value": value_json},
            )
            logger.debug("Settings key persisted to SQL", extra={"key": key})
        logger.info("Settings SQL write completed", extra={"keys": list(DEFAULT_SETTINGS.keys())})
    except Exception:
        logger.error("settings SQL write failed", exc_info=True)


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
    _persist_to_sql(merged)
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
    live_key = str(config.stripe.get("publishable_key_live") or config.stripe.get("publishable_key") or "").strip()
    test_key = str(config.stripe.get("publishable_key_test") or "").strip()
    if effective == "live":
        return live_key
    return test_key or live_key


def resolve_stripe_secret_key(mode: Optional[str] = None) -> str:
    config = get_config()
    effective = mode or get_effective_stripe_mode()
    live_key = str(config.stripe.get("secret_key_live") or config.stripe.get("secret_key") or "").strip()
    test_key = str(config.stripe.get("secret_key_test") or "").strip()
    if effective == "live":
        return live_key
    return test_key or live_key
