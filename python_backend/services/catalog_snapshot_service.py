from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..integrations import woo_commerce
from ..repositories import product_document_repository
from . import get_config

logger = logging.getLogger(__name__)

KIND_CATALOG_PRODUCT_LIGHT = "catalog_product_light"
KIND_CATALOG_PRODUCT_FULL = "catalog_product_full"
KIND_CATALOG_CATEGORIES = "catalog_categories"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _utc_now_sql() -> str:
    return _utc_now().strftime("%Y-%m-%d %H:%M:%S")


def _enabled() -> bool:
    raw = str(os.environ.get("CATALOG_SNAPSHOT_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


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


def _compact_json(data: Any) -> bytes:
    return json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _product_light_snapshot(product: Dict[str, Any]) -> Dict[str, Any]:
    """
    Keep this intentionally small: enough for catalog browsing without variations.
    """
    return {
        "id": product.get("id"),
        "name": product.get("name"),
        "slug": product.get("slug"),
        "sku": product.get("sku"),
        "type": product.get("type"),
        "status": product.get("status"),
        "price": product.get("price"),
        "regular_price": product.get("regular_price"),
        "sale_price": product.get("sale_price"),
        "stock_status": product.get("stock_status"),
        "stock_quantity": product.get("stock_quantity"),
        "images": product.get("images") if isinstance(product.get("images"), list) else [],
        "categories": product.get("categories") if isinstance(product.get("categories"), list) else [],
        "attributes": product.get("attributes") if isinstance(product.get("attributes"), list) else [],
        "meta_data": product.get("meta_data") if isinstance(product.get("meta_data"), list) else [],
        "updated_at": product.get("date_modified_gmt") or product.get("date_modified") or None,
    }


def _product_full_snapshot(product: Dict[str, Any], variations: List[Dict[str, Any]]) -> Dict[str, Any]:
    base = _product_light_snapshot(product)
    base["variations"] = variations
    return base


def _fetch_all_products() -> List[Dict[str, Any]]:
    per_page = 100
    page = 1
    results: List[Dict[str, Any]] = []
    max_pages = 250

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
        results.extend([item for item in data if isinstance(item, dict)])
        if len(data) < per_page:
            break
        page += 1
    return results


def _fetch_product_variations(product_id: int) -> List[Dict[str, Any]]:
    data, _meta = woo_commerce.fetch_catalog_proxy(
        f"products/{product_id}/variations",
        {"per_page": 100, "status": "publish"},
    )
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def _fetch_categories() -> List[Dict[str, Any]]:
    data, _meta = woo_commerce.fetch_catalog_proxy("products/categories", {"per_page": 100})
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def sync_catalog_snapshots(*, include_variations: bool = True) -> Dict[str, Any]:
    config = get_config()
    if not bool(config.mysql.get("enabled")):
        return {"ok": False, "skipped": True, "reason": "mysql_disabled"}
    if not woo_commerce.is_configured():
        return {"ok": False, "skipped": True, "reason": "woo_disabled"}
    if not _enabled():
        return {"ok": False, "skipped": True, "reason": "snapshot_disabled"}

    lock_name = "peppro:sync:catalog-snapshot"
    if not _try_acquire_lock(lock_name):
        return {"ok": False, "skipped": True, "reason": "lock_busy"}

    started_at = _utc_now()
    now_sql = _utc_now_sql()

    products = _fetch_all_products()
    categories = _fetch_categories()

    product_count = 0
    variation_products = 0
    variation_rows = 0

    # Limit concurrent variation pulls so we never stampede Woo.
    concurrency = int(os.environ.get("CATALOG_SNAPSHOT_VARIATION_CONCURRENCY", "2").strip() or 2)
    concurrency = max(1, min(concurrency, 8))
    semaphore = threading.BoundedSemaphore(concurrency)

    def sync_one(product: Dict[str, Any]) -> None:
        nonlocal product_count, variation_products, variation_rows
        try:
            woo_id_raw = product.get("id")
            if not isinstance(woo_id_raw, int):
                woo_id_raw = int(str(woo_id_raw))
            woo_id = int(woo_id_raw)
        except Exception:
            return
        name = product.get("name") if isinstance(product.get("name"), str) else None
        sku = product.get("sku") if isinstance(product.get("sku"), str) else None

        light = _product_light_snapshot(product)
        product_document_repository.upsert_payload(
            woo_product_id=woo_id,
            kind=KIND_CATALOG_PRODUCT_LIGHT,
            mime_type="application/json",
            filename=None,
            data=_compact_json(light),
            product_name=name,
            product_sku=sku,
            woo_synced_at=now_sql,
        )

        product_count += 1

        if not include_variations:
            return
        is_variable = str(product.get("type") or "").strip().lower() == "variable"
        if not is_variable:
            return

        acquired = semaphore.acquire(timeout=10)
        if not acquired:
            return
        try:
            variations = _fetch_product_variations(woo_id)
        finally:
            try:
                semaphore.release()
            except ValueError:
                pass
        variation_products += 1
        variation_rows += len(variations)

        full = _product_full_snapshot(product, variations)
        product_document_repository.upsert_payload(
            woo_product_id=woo_id,
            kind=KIND_CATALOG_PRODUCT_FULL,
            mime_type="application/json",
            filename=None,
            data=_compact_json(full),
            product_name=name,
            product_sku=sku,
            woo_synced_at=now_sql,
        )

    try:
        threads: List[threading.Thread] = []
        for product in products:
            t = threading.Thread(target=sync_one, args=(product,), daemon=True)
            threads.append(t)
            t.start()
        for t in threads:
            t.join()

        product_document_repository.upsert_payload(
            woo_product_id=0,
            kind=KIND_CATALOG_CATEGORIES,
            mime_type="application/json",
            filename=None,
            data=_compact_json({"categories": categories, "syncedAt": started_at.isoformat()}),
            product_name=None,
            product_sku=None,
            woo_synced_at=now_sql,
        )

        return {
            "ok": True,
            "products": product_count,
            "variableProducts": variation_products,
            "variationRows": variation_rows,
            "durationMs": int((_utc_now() - started_at).total_seconds() * 1000),
        }
    finally:
        _release_lock(lock_name)


def get_catalog_products(*, page: int = 1, per_page: int = 100) -> List[Dict[str, Any]]:
    if not bool(get_config().mysql.get("enabled")):
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    safe_page = max(1, int(page))
    safe_per_page = max(1, min(int(per_page), 200))
    offset = (safe_page - 1) * safe_per_page
    rows = mysql_client.fetch_all(
        """
        SELECT woo_product_id, data, woo_synced_at
        FROM product_documents
        WHERE kind = %(kind)s AND data IS NOT NULL AND OCTET_LENGTH(data) > 0
        ORDER BY woo_product_id ASC
        LIMIT %(limit)s OFFSET %(offset)s
        """,
        {"kind": KIND_CATALOG_PRODUCT_LIGHT, "limit": safe_per_page, "offset": offset},
    )
    items: List[Dict[str, Any]] = []
    for row in rows or []:
        raw = (row or {}).get("data")
        if isinstance(raw, (bytes, bytearray)):
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            if isinstance(parsed, dict):
                items.append(parsed)
    return items


def get_catalog_categories() -> List[Dict[str, Any]]:
    if not bool(get_config().mysql.get("enabled")):
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    row = mysql_client.fetch_one(
        """
        SELECT data
        FROM product_documents
        WHERE woo_product_id = 0 AND kind = %(kind)s
        """,
        {"kind": KIND_CATALOG_CATEGORIES},
    )
    raw = (row or {}).get("data") if isinstance(row, dict) else None
    if isinstance(raw, (bytes, bytearray)):
        try:
            parsed = json.loads(raw.decode("utf-8"))
            cats = parsed.get("categories") if isinstance(parsed, dict) else None
            return cats if isinstance(cats, list) else []
        except Exception:
            return []
    return []


def get_catalog_product_variations(product_id: int) -> List[Dict[str, Any]]:
    if not bool(get_config().mysql.get("enabled")):
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    pid = int(product_id)
    row = mysql_client.fetch_one(
        """
        SELECT data
        FROM product_documents
        WHERE woo_product_id = %(woo_product_id)s AND kind = %(kind)s
        """,
        {"woo_product_id": pid, "kind": KIND_CATALOG_PRODUCT_FULL},
    )
    raw = (row or {}).get("data") if isinstance(row, dict) else None
    if isinstance(raw, (bytes, bytearray)):
        try:
            parsed = json.loads(raw.decode("utf-8"))
            variations = parsed.get("variations") if isinstance(parsed, dict) else None
            return variations if isinstance(variations, list) else []
        except Exception:
            return []
    return []
