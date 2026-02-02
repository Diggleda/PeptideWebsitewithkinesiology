from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict

from ..database import mysql_client
from ..repositories import patient_links_repository
from . import get_config

logger = logging.getLogger(__name__)

_THREAD_STARTED = False
_THREAD_LOCK = threading.Lock()


def _enabled() -> bool:
    raw = str(os.environ.get("PATIENT_LINKS_SWEEP_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _mode() -> str:
    # "thread" (default): run inside the web process.
    # "disabled": do not start; expect an external scheduler to handle cleanup.
    return str(os.environ.get("PATIENT_LINKS_SWEEP_MODE", "thread")).strip().lower() or "thread"


def _interval_seconds() -> int:
    raw = str(os.environ.get("PATIENT_LINKS_SWEEP_INTERVAL_SECONDS", "900")).strip()
    try:
        value = int(float(raw))
    except Exception:
        value = 900
    return max(60, min(value, 24 * 60 * 60))


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


def sweep_once() -> Dict[str, Any]:
    if not _enabled():
        return {"ok": False, "skipped": True, "reason": "disabled"}

    try:
        if not bool(get_config().mysql.get("enabled")):
            return {"ok": False, "skipped": True, "reason": "mysql_disabled"}
    except Exception:
        return {"ok": False, "skipped": True, "reason": "mysql_disabled"}

    lock_name = "peppro:patient_links:sweep"
    if not _try_acquire_lock(lock_name):
        return {"ok": False, "skipped": True, "reason": "lock_busy"}

    try:
        deleted = int(patient_links_repository.delete_expired() or 0)
        return {"ok": True, "deleted": deleted}
    finally:
        _release_lock(lock_name)


def _run_loop() -> None:
    interval_s = _interval_seconds()
    while True:
        try:
            result = sweep_once()
            if result.get("ok") and int(result.get("deleted") or 0) > 0:
                logger.info("Patient link sweep deleted expired links", extra=result)
        except Exception:
            logger.exception("Patient link sweep failed")
        time.sleep(interval_s)


def start_patient_links_sweep() -> None:
    if not _enabled() or _mode() != "thread":
        return
    global _THREAD_STARTED
    with _THREAD_LOCK:
        if _THREAD_STARTED:
            return
        thread = threading.Thread(target=_run_loop, name="patient-links-sweep", daemon=True)
        thread.start()
        _THREAD_STARTED = True
