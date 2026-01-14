from __future__ import annotations

import base64
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from ..storage import peptide_forum_store

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _to_str(value: Any) -> str:
    return "" if value is None else str(value)


def _norm_text(value: Any) -> str:
    return _to_str(value).strip()


def _try_parse_date(value: Any) -> Tuple[Optional[str], Optional[str]]:
    raw = _norm_text(value)
    if not raw:
        return None, None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), raw
    except Exception:
        return None, raw


def list_items() -> Dict[str, Any]:
    if not peptide_forum_store:
        return {"updatedAt": None, "items": []}
    payload = peptide_forum_store.read() or {}
    updated_at = payload.get("updatedAt") if isinstance(payload.get("updatedAt"), str) else None
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    return {"updatedAt": updated_at, "items": items}


def _normalize_item(item: Any, index: int) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    title = _norm_text((item or {}).get("title") if isinstance(item, dict) else "")
    description = _norm_text((item or {}).get("description") if isinstance(item, dict) else "")
    link = _norm_text((item or {}).get("link") if isinstance(item, dict) else "")
    date_iso, date_raw = _try_parse_date((item or {}).get("date") if isinstance(item, dict) else None)

    if not title and not link:
        return None, f"Row {index}: missing title and link"

    id_base = f"{title or 'post'}|{date_iso or date_raw or 'nodate'}|{link or 'nolink'}"
    post_id = base64.urlsafe_b64encode(id_base.encode("utf-8")).decode("utf-8").rstrip("=")[:48]

    return (
        {
            "id": post_id,
            "title": title or ("The Peptide Forum" if link else "Untitled"),
            "date": date_iso or date_raw or None,
            "description": description or None,
            "link": link or None,
        },
        None,
    )


def replace_from_webhook(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    normalized_items: List[Dict[str, Any]] = []
    errors: List[str] = []

    rows = items if isinstance(items, list) else []
    for idx, row in enumerate(rows):
        value, error = _normalize_item(row, idx)
        if error:
            errors.append(error)
            continue
        if value:
            normalized_items.append(value)

    payload = {"updatedAt": _now_iso(), "items": normalized_items}

    if peptide_forum_store:
        peptide_forum_store.write(payload)
    else:
        logger.warning("peptide_forum_store not initialized; skipping persistence")

    return {
        "updatedAt": payload["updatedAt"],
        "received": len(rows),
        "stored": len(normalized_items),
        "errors": errors,
    }

