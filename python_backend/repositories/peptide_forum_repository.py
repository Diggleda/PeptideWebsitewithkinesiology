from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..services import get_config


def _mysql_enabled() -> bool:
    return bool(get_config().mysql.get("enabled"))


PST = timezone(timedelta(hours=-8))


def _to_iso(dt: Optional[datetime], *, tz=None) -> Optional[str]:
    if not dt:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    tz = tz or timezone.utc
    converted = dt.astimezone(tz)
    # Keep RFC3339 style for UTC; otherwise emit explicit offset (-08:00 / -07:00).
    if tz is timezone.utc:
        return converted.isoformat().replace("+00:00", "Z")
    return converted.isoformat()


def _parse_date_raw(date_raw: Optional[str]) -> Optional[tuple[int, int, int]]:
    raw = (date_raw or "").strip()
    if not raw:
        return None

    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})$", raw)
    if m:
        return int(m.group(1)), int(m.group(2)), int(m.group(3))

    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", raw)
    if m:
        month = int(m.group(1))
        day = int(m.group(2))
        year = int(m.group(3))
        if year < 100:
            year = 2000 + year
        return year, month, day

    return None


def _parse_time_raw(time_raw: Optional[str]) -> Optional[tuple[int, int, int]]:
    raw = (time_raw or "").strip()
    if not raw:
        return None

    m = re.match(r"^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*([AaPp][Mm])?$", raw)
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


def _derive_pst_iso(date_raw: Optional[str], time_raw: Optional[str]) -> Optional[str]:
    # Prefer the Sheet's raw date/time as source of truth for display.
    date_parts = _parse_date_raw(date_raw)
    if not date_parts:
        return None
    time_parts = _parse_time_raw(time_raw) or (0, 0, 0)
    year, month, day = date_parts
    hour, minute, second = time_parts
    try:
        return datetime(year, month, day, hour, minute, second, tzinfo=PST).isoformat()
    except Exception:
        return None


def list_posts(limit: int = 250) -> List[Dict[str, Any]]:
    if not _mysql_enabled():
        return []
    limit = max(1, min(int(limit or 250), 1000))
    rows = mysql_client.fetch_all(
        """
        SELECT id, title, date_at, date_raw, time_raw, description, link, created_at, updated_at
        FROM peptide_forum_posts
        ORDER BY
          (CASE WHEN date_at IS NULL THEN 1 ELSE 0 END),
          date_at DESC,
          updated_at DESC
        LIMIT %(limit)s
        """,
        {"limit": limit},
    )
    result: List[Dict[str, Any]] = []
    for row in rows or []:
        date_at = row.get("date_at")
        date_raw = row.get("date_raw")
        time_raw = row.get("time_raw")
        derived_iso = _derive_pst_iso(
            str(date_raw) if date_raw else None,
            str(time_raw) if time_raw else None,
        )
        date_fallback = derived_iso or (f"{date_raw} {time_raw}".strip() if date_raw and time_raw else None)
        result.append(
            {
                "id": row.get("id"),
                "title": row.get("title"),
                # Emit fixed PST for backend consistency; frontend will still render in user-local time.
                # Use date_at for ordering but prefer derived PST date/time from raw values for display
                # (this prevents subtle drift if an older sync stored date_at incorrectly).
                "date": derived_iso or _to_iso(date_at, tz=PST) or (date_fallback or (str(date_raw) if date_raw else None)),
                "dateRaw": str(date_raw) if date_raw else None,
                "timeRaw": str(time_raw) if time_raw else None,
                "description": row.get("description"),
                "link": row.get("link"),
                "createdAt": _to_iso(row.get("created_at"), tz=PST),
                "updatedAt": _to_iso(row.get("updated_at"), tz=PST),
            }
        )
    return result


def upsert_post(post: Dict[str, Any]) -> None:
    if not _mysql_enabled():
        return
    mysql_client.execute(
        """
        INSERT INTO peptide_forum_posts
          (id, title, date_at, date_raw, time_raw, description, link, created_at, updated_at)
        VALUES
          (%(id)s, %(title)s, %(date_at)s, %(date_raw)s, %(time_raw)s, %(description)s, %(link)s, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          title = VALUES(title),
          date_at = VALUES(date_at),
          date_raw = VALUES(date_raw),
          time_raw = VALUES(time_raw),
          description = VALUES(description),
          link = VALUES(link),
          updated_at = NOW()
        """,
        {
            "id": post.get("id"),
            "title": post.get("title"),
            "date_at": post.get("date_at"),
            "date_raw": post.get("date_raw"),
            "time_raw": post.get("time_raw"),
            "description": post.get("description"),
            "link": post.get("link"),
        },
    )


def delete_missing_ids(keep_ids: List[str]) -> int:
    if not _mysql_enabled():
        return 0

    ids = [str(i) for i in (keep_ids or []) if str(i).strip()]
    if not ids:
        return mysql_client.execute("DELETE FROM peptide_forum_posts")

    placeholders = ",".join([f"%({f'id{i+1}'})s" for i in range(len(ids))])
    params = {f"id{i+1}": ids[i] for i in range(len(ids))}
    return mysql_client.execute(
        f"DELETE FROM peptide_forum_posts WHERE id NOT IN ({placeholders})",
        params,
    )
