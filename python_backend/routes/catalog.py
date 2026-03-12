from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from flask import Blueprint, request, jsonify

from ..database import mysql_client
from ..integrations import woo_commerce
from ..services.catalog_snapshot_service import (
    KIND_CATALOG_PRODUCT_FULL,
    KIND_CATALOG_PRODUCT_LIGHT,
    get_catalog_categories,
)
from ..utils.http import handle_action


blueprint = Blueprint("catalog", __name__, url_prefix="/api/catalog")


def _with_publish_status(args) -> dict:
    params = dict(args or {})
    params["status"] = "publish"
    return params


def _json_with_cache_headers(data, *, cache: str, ttl_seconds: int, no_store: bool = False):
    response = jsonify(data)
    response.headers["Cache-Control"] = "no-store" if no_store else f"public, max-age={ttl_seconds}"
    response.headers["X-PepPro-Cache"] = cache
    return response


def _snapshot_max_age_seconds() -> int:
    raw = str(os.environ.get("CATALOG_SNAPSHOT_MAX_AGE_SECONDS", "300")).strip()
    try:
        parsed = int(raw)
    except Exception:
        parsed = 300
    return max(30, min(parsed, 3600))


def _force_live_requested() -> bool:
    raw = str(request.args.get("force", "")).strip().lower()
    return raw in ("1", "true", "yes", "on")


def _parse_sql_utc(value) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _is_snapshot_fresh(value) -> bool:
    ts = _parse_sql_utc(value)
    if ts is None:
        return False
    age_seconds = (datetime.now(timezone.utc) - ts).total_seconds()
    return age_seconds <= _snapshot_max_age_seconds()


def _load_product_snapshot_page(page: int, per_page: int):
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
    items = []
    freshest_synced_at = None
    stalest_synced_at = None
    for row in rows or []:
        raw = (row or {}).get("data")
        synced_at = (row or {}).get("woo_synced_at")
        if isinstance(raw, (bytes, bytearray)):
            try:
                parsed = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            if isinstance(parsed, dict):
                items.append(parsed)
                if isinstance(synced_at, str) and synced_at.strip():
                    freshest_synced_at = synced_at if freshest_synced_at is None or synced_at > freshest_synced_at else freshest_synced_at
                    stalest_synced_at = synced_at if stalest_synced_at is None or synced_at < stalest_synced_at else stalest_synced_at
    return {"items": items, "freshest_synced_at": freshest_synced_at, "stalest_synced_at": stalest_synced_at}


def _load_variation_snapshot(product_id: int):
    row = mysql_client.fetch_one(
        """
        SELECT data, woo_synced_at
        FROM product_documents
        WHERE woo_product_id = %(woo_product_id)s AND kind = %(kind)s
        """,
        {"woo_product_id": int(product_id), "kind": KIND_CATALOG_PRODUCT_FULL},
    )
    raw = (row or {}).get("data") if isinstance(row, dict) else None
    synced_at = (row or {}).get("woo_synced_at") if isinstance(row, dict) else None
    if not isinstance(raw, (bytes, bytearray)):
        return {"variations": [], "woo_synced_at": synced_at}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return {"variations": [], "woo_synced_at": synced_at}
    variations = parsed.get("variations") if isinstance(parsed, dict) else None
    return {
        "variations": variations if isinstance(variations, list) else [],
        "woo_synced_at": synced_at,
    }


@blueprint.get("/products")
def list_catalog_products():
    def action():
        if not _force_live_requested():
            page = request.args.get("page", "1")
            per_page = request.args.get("per_page", request.args.get("perPage", "100"))
            snapshot = _load_product_snapshot_page(page=int(page), per_page=int(per_page))
            if snapshot["items"] and _is_snapshot_fresh(snapshot["stalest_synced_at"]):
                return _json_with_cache_headers(
                    snapshot["items"],
                    cache="SNAPSHOT",
                    ttl_seconds=min(_snapshot_max_age_seconds(), 60),
                    no_store=True,
                )
        data, meta = woo_commerce.fetch_catalog_proxy("products", _with_publish_status(request.args))
        return _json_with_cache_headers(
            data,
            cache=str(meta.get("cache") or "MISS"),
            ttl_seconds=int(meta.get("ttlSeconds") or 60),
            no_store=bool(meta.get("noStore")),
        )

    return handle_action(action)


@blueprint.get("/categories")
def list_catalog_categories():
    def action():
        return get_catalog_categories()

    return handle_action(action)


@blueprint.get("/products/<int:product_id>/variations")
def list_catalog_variations(product_id: int):
    def action():
        if not _force_live_requested():
            snapshot = _load_variation_snapshot(product_id)
            if snapshot["variations"] and _is_snapshot_fresh(snapshot["woo_synced_at"]):
                return _json_with_cache_headers(
                    snapshot["variations"],
                    cache="SNAPSHOT",
                    ttl_seconds=min(_snapshot_max_age_seconds(), 60),
                    no_store=True,
                )
        endpoint = f"products/{product_id}/variations"
        data, meta = woo_commerce.fetch_catalog_proxy(endpoint, _with_publish_status(request.args))
        return _json_with_cache_headers(
            data,
            cache=str(meta.get("cache") or "MISS"),
            ttl_seconds=int(meta.get("ttlSeconds") or 60),
            no_store=bool(meta.get("noStore")),
        )

    return handle_action(action)
