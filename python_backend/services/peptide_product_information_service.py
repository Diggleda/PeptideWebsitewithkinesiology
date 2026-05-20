from __future__ import annotations

import re
from typing import Any, Dict, List

from ..database import mysql_client
from ..utils.http import service_error


_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS product_brochure_info (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    product_name VARCHAR(255) NOT NULL,
    product_sku VARCHAR(128) NOT NULL,
    product_description LONGTEXT NULL,
    product_information LONGTEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_product_brochure_info_sku (product_sku),
    INDEX idx_product_brochure_info_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""


def _normalize_text(value: Any, max_length: int | None = None) -> str:
    text = re.sub(r"[\r\t]+", " ", str(value or "").strip())
    if max_length is not None:
        return text[:max_length]
    return text


def _normalize_optional_text(value: Any) -> str | None:
    text = _normalize_text(value)
    return text or None


def _normalize_product(row: Dict[str, Any], index: int) -> Dict[str, Any]:
    product_name = _normalize_text(row.get("productName") or row.get("name") or row.get("product_name"), 255)
    product_sku = _normalize_text(row.get("productSku") or row.get("sku") or row.get("product_sku"), 128)
    product_description = _normalize_optional_text(
        row.get("productDescription") or row.get("description") or row.get("product_description")
    )
    product_information = _normalize_optional_text(
        row.get("productInformation") or row.get("information") or row.get("product_information")
    )

    if not product_name and not product_sku and not product_description and not product_information:
        return {"ok": False, "skip": True, "result": {"status": "skipped", "error": "EMPTY_RECORD"}}
    if not product_name:
        return {"ok": False, "error": f"Row {index}: missing product_name", "result": {"status": "error", "error": "MISSING_PRODUCT_NAME"}}
    if not product_sku:
        return {"ok": False, "error": f"Row {index}: missing product_sku", "result": {"status": "error", "error": "MISSING_SKU"}}

    return {
        "ok": True,
        "value": {
            "request_index": index,
            "product_name": product_name,
            "product_sku": product_sku,
            "product_description": product_description,
            "product_information": product_information,
        },
        "result": {
            "productSku": product_sku,
            "status": "pending",
            "key": product_sku.lower(),
        },
    }


def replace_from_webhook(rows: List[Dict[str, Any]], *, full_sync: bool = True) -> Dict[str, Any]:
    if not mysql_client.is_enabled():
        raise service_error("SQL backend is required for peptide product sync", 503)

    incoming = rows if isinstance(rows, list) else []
    clean: List[Dict[str, Any]] = []
    results: List[Dict[str, Any]] = []
    errors: List[str] = []
    seen_skus: Dict[str, int] = {}
    duplicate_skus: List[Dict[str, Any]] = []

    for index, row in enumerate(incoming):
        normalized = _normalize_product(row if isinstance(row, dict) else {}, index)
        results.append(normalized.get("result") or {"status": "error", "error": "INVALID_RECORD"})
        if normalized.get("skip"):
            continue
        if not normalized.get("ok"):
            error = normalized.get("error")
            if error:
                errors.append(str(error))
            continue

        value = normalized["value"]
        sku_key = str(value["product_sku"]).lower()
        if sku_key in seen_skus:
            duplicate = {"productSku": value["product_sku"], "rows": [seen_skus[sku_key], index]}
            duplicate_skus.append(duplicate)
            errors.append(
                f"Duplicate product_sku {value['product_sku']!r} on rows {seen_skus[sku_key]}, {index}"
            )
            results[index] = {"productSku": value["product_sku"], "status": "error", "error": "DUPLICATE_SKU"}
            continue

        seen_skus[sku_key] = index
        clean.append(value)

    if errors:
        return {
            "ok": False,
            "error": "VALIDATION_FAILED",
            "received": len(incoming),
            "stored": 0,
            "skipped": len(incoming) - len(clean),
            "errors": errors,
            "duplicates": duplicate_skus,
            "results": results,
        }

    deleted_skus: List[str] = []
    with mysql_client.cursor() as cur:
        cur.execute(_CREATE_TABLE_SQL)

        for product in clean:
            cur.execute(
                """
                INSERT INTO product_brochure_info (
                    product_name,
                    product_sku,
                    product_description,
                    product_information
                ) VALUES (
                    %(product_name)s,
                    %(product_sku)s,
                    %(product_description)s,
                    %(product_information)s
                )
                ON DUPLICATE KEY UPDATE
                    product_name = VALUES(product_name),
                    product_description = VALUES(product_description),
                    product_information = VALUES(product_information),
                    updated_at = CURRENT_TIMESTAMP
                """,
                {
                    "product_name": product["product_name"],
                    "product_sku": product["product_sku"],
                    "product_description": product["product_description"],
                    "product_information": product["product_information"],
                },
            )
            results[product["request_index"]] = {
                "productSku": product["product_sku"],
                "status": "upserted",
                "key": str(product["product_sku"]).lower(),
            }

        if full_sync:
            if clean:
                params = {f"sku_{idx}": product["product_sku"] for idx, product in enumerate(clean)}
                placeholders = ", ".join(f"%({name})s" for name in params)
                cur.execute(
                    f"SELECT product_sku FROM product_brochure_info WHERE product_sku NOT IN ({placeholders})",
                    params,
                )
                deleted_skus = [str(row.get("product_sku") or "") for row in cur.fetchall() if row.get("product_sku")]
                cur.execute(
                    f"DELETE FROM product_brochure_info WHERE product_sku NOT IN ({placeholders})",
                    params,
                )
            else:
                cur.execute("SELECT product_sku FROM product_brochure_info")
                deleted_skus = [str(row.get("product_sku") or "") for row in cur.fetchall() if row.get("product_sku")]
                cur.execute("DELETE FROM product_brochure_info")

    return {
        "ok": True,
        "received": len(incoming),
        "stored": len(clean),
        "skipped": len(incoming) - len(clean),
        "fullSync": bool(full_sync),
        "deleted": len(deleted_skus),
        "deletedSkus": deleted_skus,
        "errors": [],
        "results": results,
    }
