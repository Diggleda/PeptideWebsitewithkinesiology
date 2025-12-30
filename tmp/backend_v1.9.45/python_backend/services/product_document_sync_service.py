from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict, List

from ..services import get_config
from ..integrations import woo_commerce
from ..repositories import product_document_repository
from ..database import mysql_client

logger = logging.getLogger(__name__)

_SYNC_THREAD_STARTED = False
_SYNC_LOCK = threading.Lock()


def _enabled() -> bool:
    raw = str(os.environ.get("WOO_PRODUCT_DOC_SYNC_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


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
        products = _fetch_all_products_minimal()
        upserted = product_document_repository.upsert_stubs_for_products(products)
        return {"ok": True, "products": len(products), "upserted": upserted}
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
    global _SYNC_THREAD_STARTED
    if _SYNC_THREAD_STARTED:
        return
    with _SYNC_LOCK:
        if _SYNC_THREAD_STARTED:
            return
        _SYNC_THREAD_STARTED = True
        thread = threading.Thread(target=_worker, name="peppro-product-doc-sync", daemon=True)
        thread.start()

