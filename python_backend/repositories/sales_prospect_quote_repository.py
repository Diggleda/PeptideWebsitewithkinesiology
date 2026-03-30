from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .. import storage
from ..database import mysql_client
from ..services import get_config
from ..utils.crypto_envelope import decrypt_json, encrypt_json
from ..utils.http import utc_now_iso as _now
from ._mysql_datetime import to_mysql_datetime


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _get_store():
    store = storage.sales_prospect_quote_store
    if store is None:
        raise RuntimeError("sales_prospect_quote_store is not initialised")
    return store


def _normalize_id(value: object) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _to_money(value: object) -> float:
    try:
        numeric = float(value or 0)
    except Exception:
        return 0.0
    return round(numeric + 1e-12, 2)


def _to_iso_string(value: object) -> Optional[str]:
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        parsed = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat().replace("+00:00", "Z")
        except Exception:
            return None

    text = str(value).strip()
    if not text:
        return None
    normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
    if " " in normalized and "T" not in normalized:
        normalized = normalized.replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return text


def _quote_field_aad(quote_id: object, field: str) -> Dict[str, str]:
    return {
        "table": "sales_prospect_quotes",
        "record_ref": str(quote_id or "pending"),
        "field": field,
    }


def _try_decrypt_payload(value: object, *, quote_id: object) -> Any:
    if value is None:
        return None
    aad = _quote_field_aad(quote_id, "quote_payload_json")
    try:
        decrypted = decrypt_json(value, aad=aad)
        if decrypted is not None:
            return decrypted
    except Exception:
        pass
    try:
        decrypted = decrypt_json(value)
        if decrypted is not None:
            return decrypted
    except Exception:
        pass
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return None
    return None


def _ensure_defaults(record: Dict) -> Dict:
    normalized = dict(record or {})
    quote_id = _normalize_id(normalized.get("id"))
    created_at = _to_iso_string(normalized.get("createdAt") or normalized.get("created_at")) or _now()
    updated_at = _to_iso_string(normalized.get("updatedAt") or normalized.get("updated_at")) or created_at
    exported_at = _to_iso_string(normalized.get("exportedAt") or normalized.get("exported_at"))
    payload = _try_decrypt_payload(
        normalized.get("quotePayloadJson")
        if "quotePayloadJson" in normalized
        else normalized.get("quote_payload_json") or normalized.get("quote_payload_encrypted"),
        quote_id=quote_id,
    )

    try:
        revision_number = max(1, int(float(normalized.get("revisionNumber") or normalized.get("revision_number") or 1)))
    except Exception:
        revision_number = 1

    return {
        "id": quote_id,
        "prospectId": _normalize_id(normalized.get("prospectId") or normalized.get("prospect_id")),
        "salesRepId": _normalize_id(normalized.get("salesRepId") or normalized.get("sales_rep_id")),
        "revisionNumber": revision_number,
        "status": (str(normalized.get("status") or "draft").strip().lower() or "draft"),
        "title": _normalize_id(normalized.get("title")) or "Quote",
        "currency": (str(normalized.get("currency") or "USD").strip().upper() or "USD"),
        "subtotal": _to_money(normalized.get("subtotal")),
        "quotePayloadJson": payload,
        "createdAt": created_at,
        "updatedAt": updated_at,
        "exportedAt": exported_at,
    }


def _row_to_record(row: Optional[Dict]) -> Optional[Dict]:
    if not row:
        return None
    return _ensure_defaults(row)


def _to_db_params(record: Dict) -> Dict:
    payload = record.get("quotePayloadJson")
    return {
        "id": record.get("id"),
        "prospect_id": record.get("prospectId"),
        "sales_rep_id": record.get("salesRepId"),
        "revision_number": int(record.get("revisionNumber") or 1),
        "status": record.get("status") or "draft",
        "title": record.get("title") or "Quote",
        "currency": record.get("currency") or "USD",
        "subtotal": _to_money(record.get("subtotal")),
        "quote_payload_json": encrypt_json(
            payload,
            aad=_quote_field_aad(record.get("id"), "quote_payload_json"),
        )
        if isinstance(payload, dict)
        else None,
        "created_at": to_mysql_datetime(record.get("createdAt")),
        "updated_at": to_mysql_datetime(record.get("updatedAt")),
        "exported_at": to_mysql_datetime(record.get("exportedAt")),
    }


def _sort_quotes_descending(records: List[Dict]) -> List[Dict]:
    return sorted(
        list(records or []),
        key=lambda record: (
            -(int(record.get("revisionNumber") or 0)),
            -(int(datetime.fromisoformat(str(record.get("createdAt") or "1970-01-01T00:00:00+00:00").replace("Z", "+00:00")).timestamp())
              if str(record.get("createdAt") or "").strip()
              else 0),
            str(record.get("id") or ""),
        ),
    )


def get_all() -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM sales_prospect_quotes", {})
        return [_row_to_record(row) for row in rows if row]
    return [_ensure_defaults(item) for item in _get_store().read()]


def find_by_id(quote_id: str) -> Optional[Dict]:
    normalized = _normalize_id(quote_id)
    if not normalized:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT * FROM sales_prospect_quotes WHERE id = %(id)s LIMIT 1",
            {"id": normalized},
        )
        return _row_to_record(row)
    return next(
        (_ensure_defaults(record) for record in _get_store().read() if _normalize_id(record.get("id")) == normalized),
        None,
    )


def list_by_prospect_id(prospect_id: str) -> List[Dict]:
    normalized = _normalize_id(prospect_id)
    if not normalized:
        return []
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT *
            FROM sales_prospect_quotes
            WHERE prospect_id = %(prospect_id)s
            ORDER BY revision_number DESC, created_at DESC
            """,
            {"prospect_id": normalized},
        )
        return _sort_quotes_descending([_row_to_record(row) for row in rows if row])
    records = [
        _ensure_defaults(record)
        for record in _get_store().read()
        if _normalize_id(record.get("prospectId") or record.get("prospect_id")) == normalized
    ]
    return _sort_quotes_descending(records)


def find_active_draft_by_prospect_id(prospect_id: str) -> Optional[Dict]:
    return next((record for record in list_by_prospect_id(prospect_id) if record.get("status") == "draft"), None)


def delete_by_id(quote_id: str) -> bool:
    normalized = _normalize_id(quote_id)
    if not normalized:
        return False

    if _using_mysql():
        result = mysql_client.execute(
            "DELETE FROM sales_prospect_quotes WHERE id = %(id)s",
            {"id": normalized},
        )
        if isinstance(result, int):
            return result > 0
        affected_rows = getattr(result, "affected_rows", None)
        if isinstance(affected_rows, int):
            return affected_rows > 0
        return bool(result)

    records = list(_get_store().read())
    filtered = [record for record in records if _normalize_id(record.get("id")) != normalized]
    if len(filtered) == len(records):
        return False
    _get_store().write(filtered)
    return True


def upsert(quote: Dict) -> Dict:
    incoming = dict(quote or {})
    existing = find_by_id(incoming.get("id")) if incoming.get("id") else None
    normalized = _ensure_defaults(
        {
            **(existing or {}),
            **incoming,
            "id": _normalize_id(incoming.get("id")) or _normalize_id((existing or {}).get("id")) or uuid.uuid4().hex,
            "createdAt": (existing or {}).get("createdAt") or incoming.get("createdAt") or _now(),
            "updatedAt": incoming.get("updatedAt") or _now(),
        }
    )

    if not normalized.get("id"):
        raise RuntimeError("quote id is required")
    if not normalized.get("prospectId"):
        raise RuntimeError("prospectId is required")
    if not normalized.get("salesRepId"):
        raise RuntimeError("salesRepId is required")

    if _using_mysql():
        params = _to_db_params(normalized)
        mysql_client.execute(
            """
            INSERT INTO sales_prospect_quotes (
                id,
                prospect_id,
                sales_rep_id,
                revision_number,
                status,
                title,
                currency,
                subtotal,
                quote_payload_json,
                created_at,
                updated_at,
                exported_at
            ) VALUES (
                %(id)s,
                %(prospect_id)s,
                %(sales_rep_id)s,
                %(revision_number)s,
                %(status)s,
                %(title)s,
                %(currency)s,
                %(subtotal)s,
                %(quote_payload_json)s,
                %(created_at)s,
                %(updated_at)s,
                %(exported_at)s
            )
            ON DUPLICATE KEY UPDATE
                prospect_id = VALUES(prospect_id),
                sales_rep_id = VALUES(sales_rep_id),
                revision_number = VALUES(revision_number),
                status = VALUES(status),
                title = VALUES(title),
                currency = VALUES(currency),
                subtotal = VALUES(subtotal),
                quote_payload_json = VALUES(quote_payload_json),
                updated_at = VALUES(updated_at),
                exported_at = VALUES(exported_at)
            """,
            params,
        )
        return find_by_id(str(normalized.get("id"))) or normalized

    records = list(_get_store().read())
    index = next(
        (idx for idx, record in enumerate(records) if _normalize_id(record.get("id")) == normalized.get("id")),
        None,
    )
    if index is None:
        records.append(normalized)
    else:
        records[index] = normalized
    _get_store().write(records)
    return normalized
