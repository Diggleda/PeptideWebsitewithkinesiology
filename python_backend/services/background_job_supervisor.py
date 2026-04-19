from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

_LOCK = threading.Lock()
_JOBS: Dict[str, Dict[str, Any]] = {}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalize_error(value: Any) -> Optional[Dict[str, str]]:
    if value is None:
        return None
    if isinstance(value, BaseException):
        return {
            "type": value.__class__.__name__,
            "message": str(value),
        }
    if isinstance(value, dict):
        error_type = str(value.get("type") or "").strip()
        message = str(value.get("message") or "").strip()
        if error_type or message:
            return {
                "type": error_type or "Error",
                "message": message,
            }
        return None
    text = str(value).strip()
    if not text:
        return None
    return {"type": "Error", "message": text}


def set_job_state(name: str, **fields: Any) -> Dict[str, Any]:
    with _LOCK:
        state = _JOBS.setdefault(name, {"name": name})
        state.update(fields)
        return _snapshot_locked(state)


def record_heartbeat(
    name: str,
    *,
    last_result: Any = None,
    last_error: Any = None,
    clear_error: bool = False,
    **fields: Any,
) -> Dict[str, Any]:
    now = _utc_now_iso()
    with _LOCK:
        state = _JOBS.setdefault(name, {"name": name})
        state["lastHeartbeatAt"] = now
        state["running"] = True
        state["state"] = "running"
        if last_result is not None:
            state["lastResult"] = last_result
        if clear_error:
            state["lastError"] = None
        normalized_error = _normalize_error(last_error)
        if normalized_error is not None:
            state["lastError"] = normalized_error
        state.update(fields)
        return _snapshot_locked(state)


def get_job_status(name: str) -> Dict[str, Any]:
    with _LOCK:
        state = _JOBS.get(name)
        if not state:
            return {"name": name}
        return _snapshot_locked(state)


def get_all_job_statuses() -> Dict[str, Dict[str, Any]]:
    with _LOCK:
        return {name: _snapshot_locked(state) for name, state in _JOBS.items()}


def _snapshot_locked(state: Dict[str, Any]) -> Dict[str, Any]:
    snapshot = {key: value for key, value in state.items() if not key.startswith("_")}
    thread = state.get("_supervisorThread")
    snapshot["supervisorAlive"] = bool(thread and thread.is_alive())
    snapshot["launchCount"] = int(state.get("launchCount") or 0)
    snapshot["restartCount"] = max(0, snapshot["launchCount"] - 1)
    return snapshot


def _run_supervisor(
    name: str,
    target: Callable[[], None],
    *,
    restart_delay_seconds: float,
) -> None:
    while True:
        started_at = _utc_now_iso()
        with _LOCK:
            state = _JOBS.setdefault(name, {"name": name})
            state["launchCount"] = int(state.get("launchCount") or 0) + 1
            state["lastStartedAt"] = started_at
            state["lastHeartbeatAt"] = started_at
            state["lastFinishedAt"] = None
            state["lastExitAt"] = None
            state["lastExitReason"] = None
            state["running"] = True
            state["state"] = "starting"

        try:
            target()
            exit_reason = "returned"
            error = None
            logger.warning("Background job exited; restarting", extra={"job": name})
        except BaseException as exc:  # pragma: no cover - exercised through service tests
            exit_reason = exc.__class__.__name__
            error = exc
            logger.exception("Background job crashed; restarting", extra={"job": name})

        finished_at = _utc_now_iso()
        with _LOCK:
            state = _JOBS.setdefault(name, {"name": name})
            state["running"] = False
            state["state"] = "restarting"
            state["lastFinishedAt"] = finished_at
            state["lastExitAt"] = finished_at
            state["lastExitReason"] = exit_reason
            normalized_error = _normalize_error(error)
            if normalized_error is not None:
                state["lastError"] = normalized_error

        time.sleep(max(1.0, float(restart_delay_seconds)))


def start_supervised_job(
    name: str,
    target: Callable[[], None],
    *,
    thread_name: Optional[str] = None,
    restart_delay_seconds: float = 5.0,
    **fields: Any,
) -> Dict[str, Any]:
    with _LOCK:
        state = _JOBS.setdefault(name, {"name": name})
        state.update(fields)
        thread = state.get("_supervisorThread")
        if thread and thread.is_alive():
            return _snapshot_locked(state)

        supervisor = threading.Thread(
            target=_run_supervisor,
            args=(name, target),
            kwargs={"restart_delay_seconds": restart_delay_seconds},
            name=thread_name or name,
            daemon=True,
        )
        state["_supervisorThread"] = supervisor
        state["threadName"] = supervisor.name
        state["autoRestart"] = True
        state["restartDelaySeconds"] = float(restart_delay_seconds)
        state["state"] = "scheduled"
        state["running"] = False

    supervisor.start()
    return get_job_status(name)
