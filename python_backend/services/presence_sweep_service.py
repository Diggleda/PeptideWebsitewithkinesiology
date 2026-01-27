from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict

from ..database import mysql_client
from ..repositories import user_repository
from . import get_config, presence_service

logger = logging.getLogger(__name__)

_THREAD_STARTED = False
_THREAD_LOCK = threading.Lock()


def _enabled() -> bool:
    raw = str(os.environ.get("PRESENCE_SWEEP_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _mode() -> str:
    # "thread" (default): run inside the web process.
    # "disabled": do not start; expect an external scheduler to handle cleanup.
    return str(os.environ.get("PRESENCE_SWEEP_MODE", "thread")).strip().lower() or "thread"


def _interval_seconds() -> int:
    raw = str(os.environ.get("PRESENCE_SWEEP_INTERVAL_SECONDS", "60")).strip()
    try:
        value = int(float(raw))
    except Exception:
        value = 60
    return max(10, min(value, 3600))


def _online_threshold_seconds() -> float:
    raw = os.environ.get("USER_PRESENCE_ONLINE_SECONDS")
    try:
        threshold = float(raw) if raw is not None else 300.0
    except Exception:
        threshold = 300.0
    return max(15.0, min(threshold, 60 * 60))


def _grace_seconds() -> float:
    raw = os.environ.get("PRESENCE_SWEEP_GRACE_SECONDS")
    try:
        grace = float(raw) if raw is not None else 30.0
    except Exception:
        grace = 30.0
    return max(0.0, min(grace, 10 * 60))


def _try_acquire_lock(name: str) -> bool:
    try:
        row = mysql_client.fetch_one("SELECT GET_LOCK(%(name)s, 0) AS acquired", {"name": name})
        return bool(row and int(row.get("acquired") or 0) == 1)
    except Exception:
        return False


def _release_lock(name: str) -> None:
    try:
        mysql_client.fetch_one("SELECT RELEASE_LOCK(%(name)s) AS released", {"name": name})
    except Exception:
        return


def _parse_iso_utc(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        try:
            seconds = float(value)
        except Exception:
            return None
        if seconds > 10_000_000_000:
            seconds = seconds / 1000.0
        if seconds <= 0:
            return None
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
        try:
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.astimezone(timezone.utc)
        except Exception:
            return None
    return None


def sweep_once() -> Dict[str, Any]:
    """
    Mark users offline when their last_seen_at is stale.

    This protects against "sticky online" when a browser closes without sending
    `/auth/logout` (or the keepalive request is dropped).
    """
    if not _enabled():
        return {"ok": False, "skipped": True, "reason": "disabled"}

    online_threshold_s = _online_threshold_seconds()
    grace_s = _grace_seconds()
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=float(online_threshold_s + grace_s))
    cutoff_sql = cutoff.strftime("%Y-%m-%d %H:%M:%S")

    pruned = 0
    try:
        # Keep in-memory map bounded (12x threshold ~= "a few hours" by default).
        pruned = presence_service.prune_stale(max_age_s=max(60.0, float(online_threshold_s + grace_s) * 12))
    except Exception:
        pruned = 0

    config = get_config()
    if bool(getattr(config, "mysql", {}).get("enabled")):
        lock_name = "peppro:presence:sweep"
        if not _try_acquire_lock(lock_name):
            return {"ok": False, "skipped": True, "reason": "lock_busy", "cutoff": cutoff_sql, "pruned": pruned}
        try:
            updated = mysql_client.execute(
                """
                UPDATE users
                SET is_online = 0
                WHERE is_online = 1
                  AND last_seen_at IS NOT NULL
                  AND last_seen_at < %(cutoff)s
                """,
                {"cutoff": cutoff_sql},
            )
            return {"ok": True, "updated": int(updated or 0), "cutoff": cutoff_sql, "pruned": pruned}
        finally:
            _release_lock(lock_name)

    # JSON-store fallback.
    updated = 0
    try:
        users = user_repository.get_all() or []
    except Exception:
        users = []
    for user in users:
        if not isinstance(user, dict) or not bool(user.get("isOnline")):
            continue
        last_seen = _parse_iso_utc(user.get("lastSeenAt"))
        if not last_seen:
            continue
        if last_seen.astimezone(timezone.utc) < cutoff:
            try:
                user_repository.update({**user, "isOnline": False})
                updated += 1
            except Exception:
                continue

    return {"ok": True, "updated": updated, "cutoff": cutoff_sql, "pruned": pruned, "backend": "json"}


def _run_loop() -> None:
    interval_s = _interval_seconds()
    while True:
        try:
            result = sweep_once()
            if result.get("ok") and int(result.get("updated") or 0) > 0:
                logger.info("Presence sweep marked users offline", extra=result)
        except Exception:
            logger.exception("Presence sweep failed")
        time.sleep(interval_s)


def start_presence_sweep() -> None:
    if not _enabled() or _mode() != "thread":
        return
    global _THREAD_STARTED
    with _THREAD_LOCK:
        if _THREAD_STARTED:
            return
        thread = threading.Thread(target=_run_loop, name="presence-sweep", daemon=True)
        thread.start()
        _THREAD_STARTED = True

