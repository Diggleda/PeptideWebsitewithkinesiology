from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Dict

from ..database import mysql_client
from ..repositories import patient_links_repository
from . import background_job_supervisor
from . import get_config

logger = logging.getLogger(__name__)

_THREAD_STARTED = False
_THREAD_LOCK = threading.Lock()
_JOB_NAME = "patientLinksSweep"


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
        expired = int(patient_links_repository.delete_expired() or 0)
        return {"ok": True, "expired": expired}
    finally:
        _release_lock(lock_name)


def get_status() -> Dict[str, Any]:
    using_mysql = False
    try:
        using_mysql = bool(get_config().mysql.get("enabled"))
    except Exception:
        using_mysql = False
    return {
        **background_job_supervisor.get_job_status(_JOB_NAME),
        "enabled": _enabled(),
        "mode": _mode(),
        "intervalSeconds": _interval_seconds(),
        "mysqlEnabled": using_mysql,
        "started": _THREAD_STARTED,
    }


def _run_loop() -> None:
    interval_s = _interval_seconds()
    while True:
        try:
            result = sweep_once()
            if result.get("ok") and int(result.get("expired") or 0) > 0:
                logger.info("Delegate link sweep marked expired links", extra=result)
            background_job_supervisor.record_heartbeat(
                _JOB_NAME,
                last_result=result,
                clear_error=True,
                enabled=_enabled(),
                mode="thread",
                intervalSeconds=interval_s,
            )
        except Exception as exc:
            logger.exception("Delegate link sweep failed")
            background_job_supervisor.record_heartbeat(
                _JOB_NAME,
                last_error=exc,
                enabled=_enabled(),
                mode="thread",
                intervalSeconds=interval_s,
            )
        time.sleep(interval_s)


def start_patient_links_sweep(*, force: bool = False) -> None:
    interval_s = _interval_seconds()
    if not _enabled():
        background_job_supervisor.set_job_state(
            _JOB_NAME,
            enabled=False,
            mode=_mode(),
            intervalSeconds=interval_s,
            running=False,
            state="disabled",
            reason="disabled",
        )
        return
    if not force and _mode() != "thread":
        background_job_supervisor.set_job_state(
            _JOB_NAME,
            enabled=True,
            mode=_mode(),
            intervalSeconds=interval_s,
            running=False,
            state="external",
            reason="external_mode",
        )
        return
    global _THREAD_STARTED
    with _THREAD_LOCK:
        if _THREAD_STARTED:
            return
        _THREAD_STARTED = True
        background_job_supervisor.start_supervised_job(
            _JOB_NAME,
            _run_loop,
            thread_name="patient-links-sweep",
            restart_delay_seconds=min(60.0, max(5.0, float(interval_s) / 2.0)),
            enabled=True,
            mode="thread",
            intervalSeconds=interval_s,
        )
