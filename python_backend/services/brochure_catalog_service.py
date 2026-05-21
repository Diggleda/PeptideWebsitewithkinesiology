from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Iterable, List, Optional

from ..database import mysql_client
from ..repositories import product_document_repository
from . import get_config
from . import delegation_service
from .catalog_snapshot_service import KIND_CATALOG_PRODUCT_FULL, KIND_CATALOG_PRODUCT_LIGHT

logger = logging.getLogger(__name__)


def _decode_json(raw: Any) -> Optional[Dict[str, Any]]:
    if isinstance(raw, memoryview):
        raw = raw.tobytes()
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except Exception:
            return None
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _text(value: Any) -> str:
    return str(value or "").strip()


def _normalize_sku(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", _text(value).lower())


def _exact_key(value: Any) -> str:
    return _text(value).lower()


def _int_value(value: Any) -> Optional[int]:
    try:
        parsed = int(str(value).strip())
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _first_image(product: Dict[str, Any]) -> Optional[str]:
    images = product.get("images")
    if isinstance(images, list):
        for image in images:
            if isinstance(image, dict) and _text(image.get("src")):
                return _text(image.get("src"))
            if isinstance(image, str) and image.strip():
                return image.strip()
    return None


def _categories(product: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = product.get("categories")
    if not isinstance(raw, list):
        return []
    categories: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = _text(item.get("name"))
        if not name:
            continue
        categories.append(
            {
                "id": _int_value(item.get("id")),
                "name": name,
                "slug": _text(item.get("slug")) or None,
            }
        )
    return categories


def _primary_category(product: Dict[str, Any]) -> Optional[str]:
    categories = [cat.get("name") for cat in _categories(product) if cat.get("name")]
    without_uncategorized = [name for name in categories if str(name).lower() != "uncategorized"]
    return (without_uncategorized or categories or [None])[0]


def _scope_tokens(link: Dict[str, Any]) -> set[str]:
    values: List[Any] = []
    for key in ("productScopeItems", "product_scope_items", "allowedProducts", "allowed_products"):
        raw = link.get(key)
        if isinstance(raw, list):
            values.extend(raw)
        elif isinstance(raw, str):
            values.extend(raw.replace("\n", ",").split(","))
    return {_text(value).lower() for value in values if _text(value)}


def _product_scope_matches(product: Dict[str, Any], link: Dict[str, Any]) -> bool:
    scope = _text(link.get("productScope") or link.get("product_scope") or "all_physician_approved").lower()
    tokens = _scope_tokens(link)
    if scope in ("", "all_physician_approved"):
        return True
    if not tokens:
        return scope not in ("specific_products", "specific_cart_only")

    product_id = _text(product.get("id")).lower()
    sku = _text(product.get("sku")).lower()
    normalized_sku = _normalize_sku(sku)
    category_tokens = {
        _text(cat.get("name")).lower()
        for cat in _categories(product)
        if _text(cat.get("name"))
    } | {
        _text(cat.get("slug")).lower()
        for cat in _categories(product)
        if _text(cat.get("slug"))
    }
    product_tokens = {
        product_id,
        f"woo-{product_id}" if product_id else "",
        sku,
        normalized_sku,
        _text(product.get("name")).lower(),
        *category_tokens,
    }
    for variation in product.get("variations") if isinstance(product.get("variations"), list) else []:
        if not isinstance(variation, dict):
            continue
        variation_id = _text(variation.get("id")).lower()
        variation_sku = _text(variation.get("sku")).lower()
        product_tokens.update(
            {
                variation_id,
                f"woo-variation-{variation_id}" if variation_id else "",
                variation_sku,
                _normalize_sku(variation_sku),
            }
        )
    return bool(tokens & {token for token in product_tokens if token})


def _load_brochure_rows() -> List[Dict[str, Any]]:
    rows = mysql_client.fetch_all(
        """
        SELECT *
        FROM product_brochure_info
        WHERE COALESCE(TRIM(product_description), '') <> ''
           OR COALESCE(TRIM(product_information), '') <> ''
        """,
    )
    return [row for row in rows or [] if isinstance(row, dict)]


def _load_snapshot_products() -> List[Dict[str, Any]]:
    rows = mysql_client.fetch_all(
        """
        SELECT woo_product_id, kind, data
        FROM product_documents
        WHERE kind IN (%(kind_full)s, %(kind_light)s)
          AND woo_product_id <> 0
          AND data IS NOT NULL
          AND OCTET_LENGTH(data) > 0
        ORDER BY woo_product_id ASC,
          CASE WHEN kind = %(kind_full)s THEN 0 ELSE 1 END
        """,
        {"kind_full": KIND_CATALOG_PRODUCT_FULL, "kind_light": KIND_CATALOG_PRODUCT_LIGHT},
    )
    seen: set[int] = set()
    products: List[Dict[str, Any]] = []
    for row in rows or []:
        try:
            woo_id = int(row.get("woo_product_id"))
        except Exception:
            continue
        if woo_id in seen:
            continue
        parsed = _decode_json(row.get("data"))
        if isinstance(parsed, dict):
            seen.add(woo_id)
            products.append(parsed)
    return products


def _coa_available_by_product_id(product_ids: Iterable[int]) -> Dict[int, bool]:
    normalized_ids: set[int] = set()
    for pid in product_ids:
        parsed = _int_value(pid)
        if parsed is not None:
            normalized_ids.add(parsed)
    ids = sorted(normalized_ids)
    if not ids:
        return {}
    params: Dict[str, Any] = {"kind": product_document_repository.DEFAULT_KIND_COA}
    placeholders: List[str] = []
    for index, product_id in enumerate(ids):
        key = f"pid_{index}"
        params[key] = product_id
        placeholders.append(f"%({key})s")
    rows = mysql_client.fetch_all(
        f"""
        SELECT woo_product_id, sha256, OCTET_LENGTH(data) AS data_bytes
        FROM product_documents
        WHERE kind = %(kind)s
          AND woo_product_id IN ({", ".join(placeholders)})
        """,
        params,
    )
    availability: Dict[int, bool] = {}
    for row in rows or []:
        product_id = _int_value(row.get("woo_product_id"))
        if product_id is None:
            continue
        try:
            bytes_value = int(row.get("data_bytes") or 0)
        except Exception:
            bytes_value = 0
        availability[product_id] = bool(bytes_value > 0 and _text(row.get("sha256")))
    return availability


def _build_brochure_matcher(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    by_exact_sku: Dict[str, Dict[str, Any]] = {}
    by_normalized_sku: Dict[str, Dict[str, Any]] = {}
    by_product_id: Dict[int, Dict[str, Any]] = {}
    by_variation_id: Dict[int, Dict[str, Any]] = {}
    for row in rows:
        sku = _text(row.get("product_sku"))
        if sku:
            by_exact_sku.setdefault(_exact_key(sku), row)
            by_normalized_sku.setdefault(_normalize_sku(sku), row)
        for key, target in (
            ("product_id", by_product_id),
            ("parent_product_id", by_product_id),
            ("variation_id", by_variation_id),
        ):
            row_id = _int_value(row.get(key))
            if row_id is not None:
                target.setdefault(row_id, row)
    return {
        "by_exact_sku": by_exact_sku,
        "by_normalized_sku": by_normalized_sku,
        "by_product_id": by_product_id,
        "by_variation_id": by_variation_id,
    }


def _match_brochure_row(product: Dict[str, Any], matcher: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    product_id = _int_value(product.get("id"))
    if product_id is not None:
        matched = matcher["by_product_id"].get(product_id)
        if matched:
            return matched
    sku = _text(product.get("sku"))
    if sku:
        matched = matcher["by_exact_sku"].get(_exact_key(sku)) or matcher["by_normalized_sku"].get(_normalize_sku(sku))
        if matched:
            return matched
    variations = product.get("variations")
    if isinstance(variations, list):
        for variation in variations:
            if not isinstance(variation, dict):
                continue
            variation_id = _int_value(variation.get("id"))
            if variation_id is not None:
                matched = matcher["by_variation_id"].get(variation_id)
                if matched:
                    return matched
            variation_sku = _text(variation.get("sku"))
            if variation_sku:
                matched = matcher["by_exact_sku"].get(_exact_key(variation_sku)) or matcher["by_normalized_sku"].get(_normalize_sku(variation_sku))
                if matched:
                    return matched
    return None


def _brochure_dto(product: Dict[str, Any], info: Dict[str, Any], *, coa_available: bool) -> Dict[str, Any]:
    product_id = _int_value(product.get("id"))
    categories = _categories(product)
    product_sku = _text(product.get("sku"))
    brochure_sku = _text(info.get("product_sku"))
    parent_sku = _text(info.get("parent_sku")) or product_sku or None
    return {
        "id": f"woo-{product_id}" if product_id is not None else brochure_sku or product_sku or _text(product.get("name")),
        "wooProductId": product_id,
        "sku": brochure_sku or product_sku or None,
        "parentSku": parent_sku,
        "name": _text(product.get("name")) or _text(info.get("product_name")) or "Product",
        "category": _primary_category(product),
        "categories": categories,
        "imageUrl": _first_image(product),
        "productDescription": _text(info.get("product_description")) or None,
        "productInformation": _text(info.get("product_information")) or None,
        "coaAvailable": bool(coa_available),
        "documentation": {"coaAvailable": bool(coa_available)},
    }


def resolve_brochure_link(token: str, *, count_page_load: bool = False, view_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    resolved = delegation_service.resolve_delegate_token(
        token,
        count_page_load=count_page_load,
        view_context=view_context,
        include_brochure_scope=True,
    )
    link_type = _text(resolved.get("linkType") or resolved.get("link_type")).lower()
    capabilities = resolved.get("capabilities") if isinstance(resolved.get("capabilities"), dict) else {}
    if link_type != "brochure" or capabilities.get("canViewProducts") is not True:
        err = ValueError("Invalid or expired brochure link")
        setattr(err, "status", 404)
        raise err
    return resolved


def get_brochure_products(token: str) -> Dict[str, Any]:
    if not bool(get_config().mysql.get("enabled")):
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err

    link = resolve_brochure_link(token, count_page_load=False)
    rows = _load_brochure_rows()
    matcher = _build_brochure_matcher(rows)
    products = _load_snapshot_products()
    coa_map = _coa_available_by_product_id(
        product_id for product_id in (_int_value(product.get("id")) for product in products) if product_id is not None
    )

    items: List[Dict[str, Any]] = []
    unmatched: List[str] = []
    for product in products:
        if not _product_scope_matches(product, link):
            continue
        info = _match_brochure_row(product, matcher)
        if not info:
            sku = _text(product.get("sku"))
            if sku:
                unmatched.append(sku)
            continue
        product_id = _int_value(product.get("id"))
        items.append(_brochure_dto(product, info, coa_available=bool(product_id and coa_map.get(product_id))))

    if unmatched:
        logger.info("[brochure-catalog] products missing brochure copy", extra={"count": len(unmatched), "sampleSkus": unmatched[:25]})

    return {
        "products": items,
        "capabilities": link.get("capabilities"),
        "linkType": "brochure",
    }
