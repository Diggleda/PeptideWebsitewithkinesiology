from __future__ import annotations

import hashlib
import secrets
import threading
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple

from ..database import mysql_client


DEFAULT_LAUNCH_TTL_SECONDS = 60
DEFAULT_SESSION_TTL_SECONDS = 30 * 60

_MEMORY_LOCK = threading.Lock()
_MEMORY_RECORDS: Dict[str, Dict] = {}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _to_iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _to_sql(value: datetime | None) -> str | None:
    if value is None:
        return None
    aware = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _from_value(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            seconds = float(value)
            if seconds > 10_000_000_000:
                seconds = seconds / 1000.0
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except Exception:
            return None
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        pass
    try:
        return datetime.strptime(text[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _using_mysql() -> bool:
    return mysql_client.is_enabled()


def _normalize_record(record: Optional[Dict]) -> Optional[Dict]:
    if not isinstance(record, dict):
        return None
    created_at = _from_value(record.get("createdAt") or record.get("created_at"))
    launch_expires_at = _from_value(record.get("launchExpiresAt") or record.get("launch_expires_at"))
    launch_consumed_at = _from_value(record.get("launchConsumedAt") or record.get("launch_consumed_at"))
    session_expires_at = _from_value(record.get("sessionExpiresAt") or record.get("session_expires_at"))
    last_seen_at = _from_value(record.get("lastSeenAt") or record.get("last_seen_at"))
    ended_at = _from_value(record.get("endedAt") or record.get("ended_at"))
    return {
        "id": str(record.get("id") or "").strip(),
        "launchTokenSha256": str(record.get("launchTokenSha256") or record.get("launch_token_sha256") or "").strip(),
        "adminUserId": str(record.get("adminUserId") or record.get("admin_user_id") or "").strip(),
        "targetUserId": str(record.get("targetUserId") or record.get("target_user_id") or "").strip(),
        "targetRole": str(record.get("targetRole") or record.get("target_role") or "").strip(),
        "createdAt": _to_iso(created_at),
        "launchExpiresAt": _to_iso(launch_expires_at),
        "launchConsumedAt": _to_iso(launch_consumed_at),
        "sessionExpiresAt": _to_iso(session_expires_at),
        "lastSeenAt": _to_iso(last_seen_at),
        "endedAt": _to_iso(ended_at),
    }


def create_session(
    *,
    admin_user_id: str,
    target_user_id: str,
    target_role: str,
    launch_ttl_seconds: int = DEFAULT_LAUNCH_TTL_SECONDS,
    session_ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS,
) -> Tuple[Dict, str]:
    raw_launch_token = secrets.token_urlsafe(32)
    launch_token_sha256 = _sha256_hex(raw_launch_token)
    now = _now_utc()
    record = {
        "id": secrets.token_urlsafe(18),
        "launchTokenSha256": launch_token_sha256,
        "adminUserId": str(admin_user_id or "").strip(),
        "targetUserId": str(target_user_id or "").strip(),
        "targetRole": str(target_role or "").strip(),
        "createdAt": _to_iso(now),
        "launchExpiresAt": _to_iso(now + timedelta(seconds=max(1, int(launch_ttl_seconds or DEFAULT_LAUNCH_TTL_SECONDS)))),
        "launchConsumedAt": None,
        "sessionExpiresAt": _to_iso(now + timedelta(seconds=max(60, int(session_ttl_seconds or DEFAULT_SESSION_TTL_SECONDS)))),
        "lastSeenAt": None,
        "endedAt": None,
    }
    if _using_mysql():
        mysql_client.execute(
            """
            INSERT INTO admin_shadow_sessions (
                id,
                launch_token_sha256,
                admin_user_id,
                target_user_id,
                target_role,
                created_at,
                launch_expires_at,
                launch_consumed_at,
                session_expires_at,
                last_seen_at,
                ended_at
            ) VALUES (
                %(id)s,
                %(launch_token_sha256)s,
                %(admin_user_id)s,
                %(target_user_id)s,
                %(target_role)s,
                %(created_at)s,
                %(launch_expires_at)s,
                %(launch_consumed_at)s,
                %(session_expires_at)s,
                %(last_seen_at)s,
                %(ended_at)s
            )
            """,
            {
                "id": record["id"],
                "launch_token_sha256": record["launchTokenSha256"],
                "admin_user_id": record["adminUserId"],
                "target_user_id": record["targetUserId"],
                "target_role": record["targetRole"],
                "created_at": _to_sql(_from_value(record["createdAt"])),
                "launch_expires_at": _to_sql(_from_value(record["launchExpiresAt"])),
                "launch_consumed_at": None,
                "session_expires_at": _to_sql(_from_value(record["sessionExpiresAt"])),
                "last_seen_at": None,
                "ended_at": None,
            },
        )
        stored = find_by_id(record["id"]) or record
        return stored, raw_launch_token

    with _MEMORY_LOCK:
        _MEMORY_RECORDS[record["id"]] = dict(record)
    return dict(record), raw_launch_token


def find_by_id(session_id: str) -> Optional[Dict]:
    normalized = str(session_id or "").strip()
    if not normalized:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT * FROM admin_shadow_sessions WHERE id = %(id)s",
            {"id": normalized},
        )
        return _normalize_record(row)
    with _MEMORY_LOCK:
        return _normalize_record(_MEMORY_RECORDS.get(normalized))


def find_by_launch_token(raw_launch_token: str) -> Optional[Dict]:
    normalized = str(raw_launch_token or "").strip()
    if not normalized:
        return None
    token_sha256 = _sha256_hex(normalized)
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT * FROM admin_shadow_sessions WHERE launch_token_sha256 = %(token_sha256)s",
            {"token_sha256": token_sha256},
        )
        return _normalize_record(row)
    with _MEMORY_LOCK:
        for record in _MEMORY_RECORDS.values():
            if str(record.get("launchTokenSha256") or "") == token_sha256:
                return _normalize_record(record)
    return None


def consume_launch_token(raw_launch_token: str) -> Optional[Dict]:
    normalized = str(raw_launch_token or "").strip()
    if not normalized:
        return None
    token_sha256 = _sha256_hex(normalized)
    now = _now_utc()
    if _using_mysql():
        rows = mysql_client.execute(
            """
            UPDATE admin_shadow_sessions
            SET launch_consumed_at = %(now)s
            WHERE launch_token_sha256 = %(token_sha256)s
              AND launch_consumed_at IS NULL
              AND ended_at IS NULL
              AND launch_expires_at > %(now)s
            """,
            {"token_sha256": token_sha256, "now": _to_sql(now)},
        )
        if int(rows or 0) <= 0:
            return None
        row = mysql_client.fetch_one(
            "SELECT * FROM admin_shadow_sessions WHERE launch_token_sha256 = %(token_sha256)s",
            {"token_sha256": token_sha256},
        )
        return _normalize_record(row)

    with _MEMORY_LOCK:
        for key, record in list(_MEMORY_RECORDS.items()):
            if str(record.get("launchTokenSha256") or "") != token_sha256:
                continue
            launch_consumed_at = _from_value(record.get("launchConsumedAt"))
            ended_at = _from_value(record.get("endedAt"))
            launch_expires_at = _from_value(record.get("launchExpiresAt"))
            if launch_consumed_at or ended_at or not launch_expires_at or launch_expires_at <= now:
                return None
            next_record = {**record, "launchConsumedAt": _to_iso(now)}
            _MEMORY_RECORDS[key] = next_record
            return _normalize_record(next_record)
    return None


def touch_last_seen(session_id: str) -> Optional[Dict]:
    normalized = str(session_id or "").strip()
    if not normalized:
        return None
    now = _now_utc()
    if _using_mysql():
        mysql_client.execute(
            """
            UPDATE admin_shadow_sessions
            SET last_seen_at = %(now)s
            WHERE id = %(id)s
            """,
            {"id": normalized, "now": _to_sql(now)},
        )
        return find_by_id(normalized)

    with _MEMORY_LOCK:
        record = _MEMORY_RECORDS.get(normalized)
        if not record:
            return None
        next_record = {**record, "lastSeenAt": _to_iso(now)}
        _MEMORY_RECORDS[normalized] = next_record
        return _normalize_record(next_record)


def end_session(session_id: str) -> Optional[Dict]:
    normalized = str(session_id or "").strip()
    if not normalized:
        return None
    now = _now_utc()
    if _using_mysql():
        mysql_client.execute(
            """
            UPDATE admin_shadow_sessions
            SET ended_at = COALESCE(ended_at, %(now)s),
                last_seen_at = %(now)s
            WHERE id = %(id)s
            """,
            {"id": normalized, "now": _to_sql(now)},
        )
        return find_by_id(normalized)

    with _MEMORY_LOCK:
        record = _MEMORY_RECORDS.get(normalized)
        if not record:
            return None
        next_record = {
            **record,
            "endedAt": record.get("endedAt") or _to_iso(now),
            "lastSeenAt": _to_iso(now),
        }
        _MEMORY_RECORDS[normalized] = next_record
        return _normalize_record(next_record)


def reset_in_memory_state() -> None:
    with _MEMORY_LOCK:
        _MEMORY_RECORDS.clear()
