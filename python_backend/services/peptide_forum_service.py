from __future__ import annotations

import base64
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

try:  # Python 3.9+
    from zoneinfo import ZoneInfo  # type: ignore
except Exception:  # pragma: no cover
    ZoneInfo = None  # type: ignore

from ..repositories import peptide_forum_repository
from ..services import get_config
from ..storage import peptide_forum_store

logger = logging.getLogger(__name__)

PST = timezone(timedelta(hours=-8))


def _now_iso() -> str:
    # Backend time is fixed PST by request (no DST).
    return datetime.now(PST).isoformat()


def _to_str(value: Any) -> str:
    return "" if value is None else str(value)


def _norm_text(value: Any) -> str:
    return _to_str(value).strip()


def _parse_time_parts(raw: str) -> Optional[Tuple[int, int, int]]:
    raw = (raw or "").strip()
    if not raw:
        return None
    m = __import__("re").match(r"^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp][Mm])?$", raw)
    if not m:
        return None
    hour = int(m.group(1))
    minute = int(m.group(2) or 0)
    second = int(m.group(3) or 0)
    ampm = (m.group(4) or "").lower()
    if ampm == "pm" and hour < 12:
        hour += 12
    if ampm == "am" and hour == 12:
        hour = 0
    if not (0 <= hour <= 23 and 0 <= minute <= 59 and 0 <= second <= 59):
        return None
    return hour, minute, second


def _try_parse_datetime(date_value: Any, time_value: Any = None) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    date_raw = _norm_text(date_value)
    time_raw = _norm_text(time_value)

    if not date_raw and not time_raw:
        return None, None, None

    # 1) ISO input (preferred): accept full timestamps with timezone or trailing Z.
    if date_raw:
        try:
            parsed = datetime.fromisoformat(date_raw.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"), date_raw, (time_raw or None)
        except Exception:
            pass

    # 2) Sheet-style "date" + optional "time" in fixed PST (UTC-08:00, no DST).
    #    Supports: YYYY-MM-DD, M/D/YYYY, MM/DD/YY.
    if not date_raw:
        return None, None, (time_raw or None)

    import re

    y = mth = d = None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", date_raw)
    if m:
        y, mth, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", date_raw)
        if m:
            mth, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            if y < 100:
                y = 2000 + y

    if y is None or mth is None or d is None:
        # Preserve raw date string so it can still render, but don't treat as sortable datetime.
        return None, date_raw, (time_raw or None)

    hour = minute = second = 0
    if time_raw:
        parts = _parse_time_parts(time_raw)
        if parts:
            hour, minute, second = parts

    try:
        local_dt = datetime(y, mth, d, hour, minute, second, tzinfo=PST)
        iso = local_dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        return iso, date_raw, (time_raw or None)
    except Exception:
        return None, date_raw, (time_raw or None)


def list_items() -> Dict[str, Any]:
    config = get_config()
    if bool(config.mysql.get("enabled")):
        items = peptide_forum_repository.list_posts(limit=500)
        return {"updatedAt": _now_iso(), "items": items}

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
    date_iso, date_raw, time_raw = _try_parse_datetime(
        (item or {}).get("date") if isinstance(item, dict) else None,
        (item or {}).get("time") if isinstance(item, dict) else None,
    )

    if not title and not link:
        return None, f"Row {index}: missing title and link"

    id_base = f"{title or 'post'}|{date_iso or date_raw or 'nodate'}|{time_raw or ''}|{link or 'nolink'}"
    post_id = base64.urlsafe_b64encode(id_base.encode("utf-8")).decode("utf-8").rstrip("=")[:48]

    return (
        {
            "id": post_id,
            "title": title or ("The Peptide Forum" if link else "Untitled"),
            "date": date_iso or date_raw or None,
            "time": time_raw or None,
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

    config = get_config()
    updated_at = _now_iso()

    if bool(config.mysql.get("enabled")):
        for post in normalized_items:
            date_value = post.get("date")
            time_value = post.get("time")
            date_iso, date_raw, time_raw = _try_parse_datetime(date_value, time_value)
            date_at = None
            if date_iso:
                try:
                    date_at = (
                        datetime.fromisoformat(date_iso.replace("Z", "+00:00"))
                        .astimezone(timezone.utc)
                        .replace(tzinfo=None)
                    )
                except Exception:
                    date_at = None

            peptide_forum_repository.upsert_post(
                {
                    "id": post.get("id"),
                    "title": post.get("title"),
                    "date_at": date_at,
                    "date_raw": date_raw,
                    "time_raw": time_raw,
                    "description": post.get("description"),
                    "link": post.get("link"),
                }
            )

        # Treat webhook payload as authoritative (mirror the sheet).
        peptide_forum_repository.delete_missing_ids(
            [p.get("id") for p in normalized_items if p.get("id")]
        )
    else:
        payload = {"updatedAt": updated_at, "items": normalized_items}
        if peptide_forum_store:
            peptide_forum_store.write(payload)
        else:
            logger.warning("peptide_forum_store not initialized; skipping persistence")

    return {
        "updatedAt": updated_at,
        "received": len(rows),
        "stored": len(normalized_items),
        "errors": errors,
    }
