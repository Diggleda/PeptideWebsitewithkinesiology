from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List

from ..services import get_config
from ..integrations import woo_commerce
from ..repositories import product_document_repository
from ..database import mysql_client

logger = logging.getLogger(__name__)

_SYNC_THREAD_STARTED = False
_SYNC_LOCK = threading.Lock()

_LAST_RUN_SETTINGS_KEY = "productDocsWooSyncLastRunAt"


def _enabled() -> bool:
    raw = str(os.environ.get("WOO_PRODUCT_DOC_SYNC_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _mode() -> str:
    # "thread" (default): run inside the web process.
    # "queue": disable the thread; expect an external scheduler to enqueue `jobs.product_docs.sync_product_documents`.
    return str(os.environ.get("WOO_PRODUCT_DOC_SYNC_MODE", "thread")).strip().lower() or "thread"


def _interval_seconds() -> int:
    raw = str(os.environ.get("WOO_PRODUCT_DOC_SYNC_INTERVAL_SECONDS", "180")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 180
    return max(60, min(value, 3600))


def _try_acquire_lock(name: str) -> bool:
    try:
        row = mysql_client.fetch_one("SELECT GET_LOCK(%(name)s, 0) AS acquired", {"name": name})
        return bool(row and int(row.get("acquired") or 0) == 1)
    except Exception:
        return False


def _release_lock(name: str) -> None:
    try:
        mysql_client.fetch_one("SELECT RELEASE_LOCK(%(name)s) AS released", {"name": name})
    except Exception:
        return


def _parse_settings_json_value(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except Exception:
            return None
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return None
        # JSON column sometimes returns the already-decoded scalar, but for safety parse JSON strings.
        # Common case is '"2025-01-01T00:00:00Z"' or 'null'.
        if text == "null":
            return None
        if (text.startswith('"') and text.endswith('"')) or text.startswith("{") or text.startswith("["):
            try:
                import json

                return json.loads(text)
            except Exception:
                return text
        return text
    return raw


def _parse_iso_utc(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _get_last_run_at() -> datetime | None:
    try:
        row = mysql_client.fetch_one(
            "SELECT value_json FROM settings WHERE `key` = %(key)s",
            {"key": _LAST_RUN_SETTINGS_KEY},
        )
        raw = _parse_settings_json_value((row or {}).get("value_json"))
        return _parse_iso_utc(raw)
    except Exception:
        return None


def _set_last_run_at(value: datetime) -> None:
    try:
        import json

        stamp = value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        mysql_client.execute(
            """
            INSERT INTO settings (`key`, value_json, updated_at)
            VALUES (%(key)s, %(value)s, NOW())
            ON DUPLICATE KEY UPDATE
              value_json = VALUES(value_json),
              updated_at = NOW()
            """,
            {"key": _LAST_RUN_SETTINGS_KEY, "value": json.dumps(stamp)},
        )
    except Exception:
        return


def _fetch_all_products_minimal() -> List[Dict[str, Any]]:
    per_page = 100
    page = 1
    results: List[Dict[str, Any]] = []
    max_pages = 200

    while page <= max_pages:
        data, _meta = woo_commerce.fetch_catalog_proxy(
            "products",
            {
                "per_page": per_page,
                "page": page,
                "status": "publish",
                "orderby": "id",
                "order": "asc",
            },
        )
        if not isinstance(data, list) or len(data) == 0:
            break
        for item in data:
            if not isinstance(item, dict):
                continue
            woo_id = item.get("id")
            try:
                woo_id_int = int(woo_id)
            except Exception:
                continue
            results.append(
                {
                    "woo_product_id": woo_id_int,
                    "product_name": item.get("name") if isinstance(item.get("name"), str) else None,
                    "product_sku": item.get("sku") if isinstance(item.get("sku"), str) else None,
                }
            )
        if len(data) < per_page:
            break
        page += 1

    return results


def sync_woo_products_to_product_documents() -> Dict[str, Any]:
    config = get_config()
    if not bool(config.mysql.get("enabled")):
        return {"ok": False, "skipped": True, "reason": "mysql_disabled"}
    if not woo_commerce.is_configured():
        return {"ok": False, "skipped": True, "reason": "woo_disabled"}
    if not _enabled():
        return {"ok": False, "skipped": True, "reason": "sync_disabled"}

    lock_name = "peppro:sync:woo-product-docs"
    if not _try_acquire_lock(lock_name):
        return {"ok": False, "skipped": True, "reason": "lock_busy"}

    try:
        # Passenger commonly runs multiple workers; each worker starts this thread.
        # The MySQL named lock prevents concurrent syncs, but without a shared cooldown,
        # workers can run sequential syncs back-to-back at startup. Use a shared
        # SQL timestamp to enforce at most one sync per interval across all workers.
        interval = _interval_seconds()
        now = datetime.now(timezone.utc)
        last_run_at = _get_last_run_at()
        if last_run_at and (now - last_run_at).total_seconds() < float(interval):
            return {
                "ok": False,
                "skipped": True,
                "reason": "cooldown",
                "intervalSeconds": interval,
                "secondsSinceLastRun": int((now - last_run_at).total_seconds()),
            }

        # Claim this run immediately (so sequential workers started at the same time
        # don't run again once the lock is released).
        _set_last_run_at(now)
        products = _fetch_all_products_minimal()
        upserted = product_document_repository.upsert_stubs_for_products(products)
        return {"ok": True, "products": len(products), "upserted": upserted, "intervalSeconds": interval}
    finally:
        _release_lock(lock_name)


def _worker() -> None:
    interval = _interval_seconds()
    logger.info("[product-docs] sync thread started", extra={"intervalSeconds": interval})
    # Give the app a moment to finish starting.
    time.sleep(5)
    while True:
        try:
            result = sync_woo_products_to_product_documents()
            if result.get("ok"):
                logger.info("[product-docs] sync complete", extra=result)
            else:
                # keep logs low-noise; only debug skips
                logger.debug("[product-docs] sync skipped", extra=result)
        except Exception:
            logger.exception("[product-docs] sync failed")
        time.sleep(interval)


def start_product_document_sync() -> None:
    if _mode() != "thread":
        logger.info("[product-docs] sync thread disabled", extra={"mode": _mode()})
        return
    global _SYNC_THREAD_STARTED
    if _SYNC_THREAD_STARTED:
        return
    with _SYNC_LOCK:
        if _SYNC_THREAD_STARTED:
            return
        _SYNC_THREAD_STARTED = True
        thread = threading.Thread(target=_worker, name="peppro-product-doc-sync", daemon=True)
        thread.start()
