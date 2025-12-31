from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from typing import Optional, Dict, Any, Iterable

from ..services import get_config
from ..database import mysql_client


DEFAULT_KIND_COA = "certificate_of_analysis"


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _utc_now_sql() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def get_document(woo_product_id: int, kind: str = DEFAULT_KIND_COA) -> Optional[Dict[str, Any]]:
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    row = mysql_client.fetch_one(
        """
        SELECT woo_product_id, kind, mime_type, filename, sha256, data, created_at, updated_at
        FROM product_documents
        WHERE woo_product_id = %(woo_product_id)s AND kind = %(kind)s
        """,
        {"woo_product_id": int(woo_product_id), "kind": str(kind)},
    )
    return row if isinstance(row, dict) else None


def get_document_metadata(woo_product_id: int, kind: str = DEFAULT_KIND_COA) -> Optional[Dict[str, Any]]:
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    row = mysql_client.fetch_one(
        """
        SELECT
            woo_product_id,
            kind,
            mime_type,
            filename,
            sha256,
            OCTET_LENGTH(data) AS data_bytes,
            created_at,
            updated_at
        FROM product_documents
        WHERE woo_product_id = %(woo_product_id)s AND kind = %(kind)s
        """,
        {"woo_product_id": int(woo_product_id), "kind": str(kind)},
    )
    return row if isinstance(row, dict) else None


def upsert_stubs_for_products(
    products: Iterable[Dict[str, Any]],
    *,
    kind: str = DEFAULT_KIND_COA,
) -> int:
    """
    Seed product_documents rows for Woo products so certificates can be attached later.
    Does not overwrite existing binary data/sha/filename.
    """
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err

    rows = []
    for product in products or []:
        try:
            woo_id = int(product.get("woo_product_id") or product.get("id"))
        except Exception:
            continue
        name = product.get("product_name") or product.get("name") or None
        sku = product.get("product_sku") or product.get("sku") or None
        rows.append(
            {
                "woo_product_id": woo_id,
                "product_name": str(name).strip()[:255] if isinstance(name, str) and name.strip() else None,
                "product_sku": str(sku).strip()[:64] if isinstance(sku, str) and sku.strip() else None,
            }
        )

    if not rows:
        return 0

    now = _utc_now_sql()
    normalized_kind = str(kind or DEFAULT_KIND_COA).strip() or DEFAULT_KIND_COA

    # Build a single multi-row insert for efficiency.
    values_sql = []
    params: Dict[str, Any] = {}
    for index, row in enumerate(rows):
        values_sql.append(
            f"(%(woo_product_id_{index})s, %(kind_{index})s, %(product_name_{index})s, %(product_sku_{index})s, %(mime_type_{index})s, %(created_at_{index})s, %(updated_at_{index})s, %(woo_synced_at_{index})s)"
        )
        params[f"woo_product_id_{index}"] = int(row["woo_product_id"])
        params[f"kind_{index}"] = normalized_kind
        params[f"product_name_{index}"] = row.get("product_name")
        params[f"product_sku_{index}"] = row.get("product_sku")
        params[f"mime_type_{index}"] = "image/png"
        params[f"created_at_{index}"] = now
        params[f"updated_at_{index}"] = now
        params[f"woo_synced_at_{index}"] = now

    sql = f"""
        INSERT INTO product_documents (
            woo_product_id, kind, product_name, product_sku, mime_type, created_at, updated_at, woo_synced_at
        ) VALUES {", ".join(values_sql)}
        ON DUPLICATE KEY UPDATE
            product_name = VALUES(product_name),
            product_sku = VALUES(product_sku),
            woo_synced_at = VALUES(woo_synced_at),
            updated_at = VALUES(updated_at),
            mime_type = IFNULL(product_documents.mime_type, VALUES(mime_type))
    """
    return int(mysql_client.execute(sql, params))


def upsert_document(
    *,
    woo_product_id: int,
    data: bytes,
    kind: str = DEFAULT_KIND_COA,
    mime_type: str = "image/png",
    filename: str | None = None,
) -> Dict[str, Any]:
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    if not isinstance(data, (bytes, bytearray)) or len(data) == 0:
        err = ValueError("Document data is required")
        setattr(err, "status", 400)
        raise err
    normalized_kind = str(kind or DEFAULT_KIND_COA).strip() or DEFAULT_KIND_COA
    normalized_mime = str(mime_type or "image/png").strip() or "image/png"
    normalized_filename = str(filename).strip() if isinstance(filename, str) and filename.strip() else None

    digest = hashlib.sha256(data).hexdigest()
    now = _utc_now_sql()

    mysql_client.execute(
        """
        INSERT INTO product_documents (
            woo_product_id, kind, mime_type, filename, sha256, data, created_at, updated_at, woo_synced_at
        ) VALUES (
            %(woo_product_id)s, %(kind)s, %(mime_type)s, %(filename)s, %(sha256)s, %(data)s, %(created_at)s, %(updated_at)s, %(woo_synced_at)s
        )
        ON DUPLICATE KEY UPDATE
            product_name = IFNULL(product_documents.product_name, VALUES(product_name)),
            product_sku = IFNULL(product_documents.product_sku, VALUES(product_sku)),
            mime_type = VALUES(mime_type),
            filename = VALUES(filename),
            sha256 = VALUES(sha256),
            data = VALUES(data),
            updated_at = VALUES(updated_at),
            woo_synced_at = VALUES(woo_synced_at)
        """,
        {
            "woo_product_id": int(woo_product_id),
            "kind": normalized_kind,
            "mime_type": normalized_mime[:64],
            "filename": normalized_filename[:255] if normalized_filename else None,
            "sha256": digest,
            "data": data,
            "created_at": now,
            "updated_at": now,
            "woo_synced_at": now,
            "product_name": None,
            "product_sku": None,
        },
    )

    return {
        "woo_product_id": int(woo_product_id),
        "kind": normalized_kind,
        "mime_type": normalized_mime[:64],
        "filename": normalized_filename,
        "sha256": digest,
        "updated_at": now,
    }


def delete_document(woo_product_id: int, kind: str = DEFAULT_KIND_COA) -> bool:
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    result = mysql_client.execute(
        "DELETE FROM product_documents WHERE woo_product_id = %(woo_product_id)s AND kind = %(kind)s",
        {"woo_product_id": int(woo_product_id), "kind": str(kind)},
    )
    return result > 0


def clear_document_payload(woo_product_id: int, kind: str = DEFAULT_KIND_COA) -> bool:
    """
    Clear binary payload + hash while keeping the stub row (so missing lists still include it).
    """
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    now = _utc_now_sql()
    result = mysql_client.execute(
        """
        UPDATE product_documents
        SET data = NULL,
            sha256 = NULL,
            filename = NULL,
            updated_at = %(updated_at)s
        WHERE woo_product_id = %(woo_product_id)s AND kind = %(kind)s
        """,
        {"woo_product_id": int(woo_product_id), "kind": str(kind), "updated_at": now},
    )
    return result > 0


def list_missing_documents(kind: str = DEFAULT_KIND_COA, limit: int = 5000) -> list[Dict[str, Any]]:
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    normalized_kind = str(kind or DEFAULT_KIND_COA).strip() or DEFAULT_KIND_COA
    safe_limit = int(limit) if isinstance(limit, int) else 5000
    safe_limit = max(1, min(safe_limit, 20000))
    rows = mysql_client.fetch_all(
        """
        SELECT
            woo_product_id,
            kind,
            product_name,
            product_sku,
            woo_synced_at,
            updated_at
        FROM product_documents
        WHERE kind = %(kind)s
          AND (data IS NULL OR OCTET_LENGTH(data) = 0 OR sha256 IS NULL OR sha256 = '')
        ORDER BY
          (product_name IS NULL) ASC,
          product_name ASC,
          woo_product_id ASC
        LIMIT %(limit)s
        """,
        {"kind": normalized_kind, "limit": safe_limit},
    )
    return rows if isinstance(rows, list) else []


def list_documents(kind: str = DEFAULT_KIND_COA, limit: int = 5000) -> list[Dict[str, Any]]:
    if not _using_mysql():
        err = RuntimeError("MySQL is not enabled")
        setattr(err, "status", 503)
        raise err
    normalized_kind = str(kind or DEFAULT_KIND_COA).strip() or DEFAULT_KIND_COA
    safe_limit = int(limit) if isinstance(limit, int) else 5000
    safe_limit = max(1, min(safe_limit, 20000))
    rows = mysql_client.fetch_all(
        """
        SELECT
            woo_product_id,
            kind,
            product_name,
            product_sku,
            filename,
            sha256,
            OCTET_LENGTH(data) AS data_bytes,
            woo_synced_at,
            updated_at
        FROM product_documents
        WHERE kind = %(kind)s
        ORDER BY
          (product_name IS NULL) ASC,
          product_name ASC,
          woo_product_id ASC
        LIMIT %(limit)s
        """,
        {"kind": normalized_kind, "limit": safe_limit},
    )
    return rows if isinstance(rows, list) else []
