from __future__ import annotations

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
        date_fallback = None
        if date_raw and time_raw:
            date_fallback = f"{date_raw} {time_raw}".strip()
        result.append(
            {
                "id": row.get("id"),
                "title": row.get("title"),
                # Emit fixed PST for backend consistency; frontend will still render in user-local time.
                "date": _to_iso(date_at, tz=PST)
                or (date_fallback or (str(date_raw) if date_raw else None)),
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
