from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

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


def _prune_enabled() -> bool:
    raw = str(os.environ.get("CATALOG_SNAPSHOT_PRUNE_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _prune_min_products() -> int:
    raw = str(os.environ.get("CATALOG_SNAPSHOT_PRUNE_MIN_PRODUCTS", "1")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 1
    return max(0, min(value, 1000))


def _prune_coa_stubs_enabled() -> bool:
    raw = str(os.environ.get("CATALOG_SNAPSHOT_PRUNE_COA_STUBS", "true")).strip().lower()
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


def _chunked(values: List[int], *, size: int) -> List[List[int]]:
    if not values:
        return []
    safe_size = max(1, min(int(size), 2000))
    return [values[i : i + safe_size] for i in range(0, len(values), safe_size)]


def _existing_snapshot_product_ids() -> Set[int]:
    rows = mysql_client.fetch_all(
        """
        SELECT DISTINCT woo_product_id
        FROM product_documents
        WHERE kind IN (%(kind_light)s, %(kind_full)s)
          AND woo_product_id <> 0
        """,
        {"kind_light": KIND_CATALOG_PRODUCT_LIGHT, "kind_full": KIND_CATALOG_PRODUCT_FULL},
    )
    ids: Set[int] = set()
    for row in rows or []:
        try:
            ids.add(int((row or {}).get("woo_product_id")))
        except Exception:
            continue
    return ids


def _delete_snapshot_rows(woo_product_ids: List[int]) -> int:
    deleted = 0
    for batch in _chunked(sorted(set(woo_product_ids)), size=500):
        placeholders: List[str] = []
        params: Dict[str, Any] = {
            "kind_light": KIND_CATALOG_PRODUCT_LIGHT,
            "kind_full": KIND_CATALOG_PRODUCT_FULL,
        }
        for index, woo_id in enumerate(batch):
            key = f"woo_id_{index}"
            placeholders.append(f"%({key})s")
            params[key] = int(woo_id)
        deleted += int(
            mysql_client.execute(
                f"""
                DELETE FROM product_documents
                WHERE woo_product_id IN ({", ".join(placeholders)})
                  AND kind IN (%(kind_light)s, %(kind_full)s)
                """,
                params,
            )
        )
    return deleted


def _delete_coa_stub_rows(woo_product_ids: List[int]) -> int:
    if not _prune_coa_stubs_enabled():
        return 0
    deleted = 0
    for batch in _chunked(sorted(set(woo_product_ids)), size=500):
        placeholders: List[str] = []
        params: Dict[str, Any] = {"kind": product_document_repository.DEFAULT_KIND_COA}
        for index, woo_id in enumerate(batch):
            key = f"woo_id_{index}"
            placeholders.append(f"%({key})s")
            params[key] = int(woo_id)
        deleted += int(
            mysql_client.execute(
                f"""
                DELETE FROM product_documents
                WHERE woo_product_id IN ({", ".join(placeholders)})
                  AND kind = %(kind)s
                  AND (data IS NULL OR OCTET_LENGTH(data) = 0)
                  AND (sha256 IS NULL OR sha256 = '')
                """,
                params,
            )
        )
    return deleted


def _prune_missing_products(seen_woo_product_ids: Set[int], *, fetch_hit_limit: bool) -> Dict[str, Any]:
    """
    Remove MySQL snapshot rows for products no longer present in WooCommerce.

    Safety rails:
      - Skips if Woo fetch returned too few products (likely a transient upstream issue).
      - Skips if the Woo fetch hit the page limit (incomplete view of catalog).
      - Only deletes catalog snapshot kinds, plus (optionally) COA *stubs* with no payload.
    """
    if not _prune_enabled():
        return {"ok": False, "skipped": True, "reason": "prune_disabled"}
    if fetch_hit_limit:
        return {"ok": False, "skipped": True, "reason": "fetch_incomplete"}
    min_products = _prune_min_products()
    if len(seen_woo_product_ids) < min_products:
        return {"ok": False, "skipped": True, "reason": "too_few_products", "minProducts": min_products}

    existing_ids = _existing_snapshot_product_ids()
    stale_ids = sorted(existing_ids - set(int(x) for x in seen_woo_product_ids))
    if not stale_ids:
        return {"ok": True, "prunedProducts": 0, "deletedSnapshotRows": 0, "deletedCoaStubRows": 0}

    deleted_snapshot_rows = _delete_snapshot_rows(stale_ids)
    deleted_coa_stub_rows = _delete_coa_stub_rows(stale_ids)
    return {
        "ok": True,
        "prunedProducts": len(stale_ids),
        "deletedSnapshotRows": deleted_snapshot_rows,
        "deletedCoaStubRows": deleted_coa_stub_rows,
    }


def _normalize_product_categories(
    product: Dict[str, Any],
    *,
    category_by_id: Dict[int, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    raw = product.get("categories")
    if not isinstance(raw, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for cat in raw:
        if isinstance(cat, dict):
            cat_id = cat.get("id")
            try:
                cat_id_int = int(cat_id) if cat_id is not None else None
            except Exception:
                cat_id_int = None

            name = cat.get("name")
            if (not isinstance(name, str) or not name.strip()) and cat_id_int is not None:
                fallback = category_by_id.get(cat_id_int)
                if isinstance(fallback, dict):
                    name = fallback.get("name")

            normalized.append(
                {
                    "id": cat_id_int,
                    "name": name,
                    "slug": cat.get("slug") or (category_by_id.get(cat_id_int, {}) if cat_id_int is not None else {}).get("slug"),
                }
            )
        else:
            try:
                cat_id_int = int(cat)
            except Exception:
                continue
            fallback = category_by_id.get(cat_id_int) or {}
            normalized.append({"id": cat_id_int, "name": fallback.get("name"), "slug": fallback.get("slug")})
    return normalized


def _product_light_snapshot(product: Dict[str, Any], *, category_by_id: Dict[int, Dict[str, Any]]) -> Dict[str, Any]:
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
        "categories": _normalize_product_categories(product, category_by_id=category_by_id),
        "attributes": product.get("attributes") if isinstance(product.get("attributes"), list) else [],
        "meta_data": product.get("meta_data") if isinstance(product.get("meta_data"), list) else [],
        "updated_at": product.get("date_modified_gmt") or product.get("date_modified") or None,
    }


def _product_full_snapshot(
    product: Dict[str, Any],
    variations: List[Dict[str, Any]],
    *,
    category_by_id: Dict[int, Dict[str, Any]],
) -> Dict[str, Any]:
    base = _product_light_snapshot(product, category_by_id=category_by_id)
    base["variations"] = variations
    return base


def _fetch_all_products() -> Tuple[List[Dict[str, Any]], bool]:
    per_page = 100
    page = 1
    results: List[Dict[str, Any]] = []
    max_pages = 250
    hit_limit = False

    while page <= max_pages:
        data, _meta = woo_commerce.fetch_catalog_fresh(
            "products",
            {
                "per_page": per_page,
                "page": page,
                "status": "publish",
                "orderby": "id",
                "order": "asc",
            },
            acquire_timeout=8,
        )
        if not isinstance(data, list) or len(data) == 0:
            break
        results.extend([item for item in data if isinstance(item, dict)])
        if len(data) < per_page:
            break
        if page == max_pages:
            hit_limit = True
            break
        page += 1
    return results, hit_limit


def _fetch_product_variations(product_id: int) -> List[Dict[str, Any]]:
    data, _meta = woo_commerce.fetch_catalog_fresh(
        f"products/{product_id}/variations",
        {"per_page": 100, "status": "publish"},
        acquire_timeout=15,
    )
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def _fetch_categories() -> List[Dict[str, Any]]:
    data, _meta = woo_commerce.fetch_catalog_fresh(
        "products/categories",
        {"per_page": 100},
        acquire_timeout=8,
    )
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

    products, hit_limit = _fetch_all_products()
    categories = _fetch_categories()
    category_by_id: Dict[int, Dict[str, Any]] = {}
    for cat in categories:
        try:
            cat_id = int(cat.get("id")) if isinstance(cat, dict) and cat.get("id") is not None else None
        except Exception:
            cat_id = None
        if cat_id is None:
            continue
        category_by_id[cat_id] = {"id": cat_id, "name": cat.get("name"), "slug": cat.get("slug")}

    product_count = 0
    variation_products = 0
    variation_rows = 0

    # Limit concurrent variation pulls so we never stampede Woo.
    concurrency = int(os.environ.get("CATALOG_SNAPSHOT_VARIATION_CONCURRENCY", "2").strip() or 2)
    concurrency = max(1, min(concurrency, 8))
    semaphore = threading.BoundedSemaphore(concurrency)
    variation_acquire_timeout = float(os.environ.get("CATALOG_SNAPSHOT_VARIATION_ACQUIRE_TIMEOUT_SECONDS", "120").strip() or 120)
    variation_acquire_timeout = max(5.0, min(variation_acquire_timeout, 900.0))

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

        light = _product_light_snapshot(product, category_by_id=category_by_id)
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

        acquired = semaphore.acquire(timeout=variation_acquire_timeout)
        if not acquired:
            logger.warning(
                "[catalog-snapshot] variation fetch skipped (semaphore timeout)",
                extra={"wooProductId": woo_id, "timeoutSeconds": variation_acquire_timeout, "concurrency": concurrency},
            )
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

        full = _product_full_snapshot(product, variations, category_by_id=category_by_id)
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

        seen_ids: Set[int] = set()
        for product in products:
            try:
                seen_ids.add(int((product or {}).get("id")))
            except Exception:
                continue

        prune_result = _prune_missing_products(seen_ids, fetch_hit_limit=hit_limit)

        return {
            "ok": True,
            "products": product_count,
            "variableProducts": variation_products,
            "variationRows": variation_rows,
            "prune": prune_result,
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
