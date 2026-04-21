from __future__ import annotations

import html
import secrets

from flask import Blueprint, Response, current_app, g, request

import os
import platform
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Tuple

from ..middleware import auth as auth_middleware
from ..middleware import request_logging as request_logging_middleware
from ..services import get_config
from ..services import news_service
from ..integrations import ship_engine, woo_commerce
from ..utils.http import handle_action, utc_now_iso as _now

blueprint = Blueprint("system", __name__, url_prefix="/api")


_HEALTH_PASSWORD_ENV = "PEPPRO_HEALTH_PASSWORD"
_HEALTH_PASSWORD_HEADER = "X-Health-Password"


def _read_linux_meminfo() -> dict | None:
    try:
        if platform.system().lower() != "linux":
            return None
        meminfo_path = Path("/proc/meminfo")
        if not meminfo_path.exists():
            return None
        parsed: dict[str, int] = {}
        for line in meminfo_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if ":" not in line:
                continue
            key, rest = line.split(":", 1)
            value = rest.strip().split(" ", 1)[0]
            if value.isdigit():
                parsed[key.strip()] = int(value)
        # Values are kB.
        total_kb = parsed.get("MemTotal")
        avail_kb = parsed.get("MemAvailable") or parsed.get("MemFree")
        if not total_kb or not avail_kb:
            return None
        used_kb = max(0, total_kb - avail_kb)
        used_pct = round((used_kb / total_kb) * 100, 2) if total_kb else None
        return {
            "totalMb": round(total_kb / 1024, 2),
            "availableMb": round(avail_kb / 1024, 2),
            "usedPercent": used_pct,
        }
    except Exception:
        return None


def _read_linux_cpu_percent(sample_ms: int = 150) -> float | None:
    """
    Return overall system CPU usage percent based on /proc/stat deltas.
    This is closer to what hosting dashboards show than loadavg.
    """
    # Backwards-compatible wrapper: keep returning a single number for callers that
    # only want "busy" CPU percent.
    usage = _read_linux_cpu_usage(sample_ms=sample_ms)
    value = (usage or {}).get("usagePercent")
    return float(value) if isinstance(value, (int, float)) else None


_CPU_LAST: tuple[float, int, int, int, int] | None = None


def _read_linux_cpu_usage(sample_ms: int = 150, *, min_window_ms: int = 250) -> dict[str, Any] | None:
    """
    Return overall system CPU usage percent based on /proc/stat deltas.

    Notes:
    - "usagePercent" is computed as (total-idle)/total, where idle includes iowait.
    - VPS "steal" time can look like high CPU even when your processes are idle; we
      surface it separately as "stealPercent".
    - To avoid noisy spike alerts, prefer using the cached delta between calls when
      possible (method="delta"). Falls back to a short sleep sample (method="sleep").
    """
    try:
        if platform.system().lower() != "linux":
            return None
        sample_ms = max(50, min(int(sample_ms), 1000))
        min_window_ms = max(50, min(int(min_window_ms), 5000))

        def read_cpu() -> Tuple[int, int, int, int]:
            parts = Path("/proc/stat").read_text(encoding="utf-8", errors="ignore").splitlines()[0].split()
            if not parts or parts[0] != "cpu":
                raise RuntimeError("unexpected /proc/stat format")
            values = [int(x) for x in parts[1:]]
            idle = values[3] if len(values) > 3 else 0
            iowait = values[4] if len(values) > 4 else 0
            steal = values[7] if len(values) > 7 else 0
            idle_total = idle + iowait
            total = sum(values)
            return total, idle_total, iowait, steal

        def calc(total1: int, idle1: int, iowait1: int, steal1: int, total2: int, idle2: int, iowait2: int, steal2: int) -> dict[str, float] | None:
            total_delta = max(0, total2 - total1)
            if total_delta <= 0:
                return None
            idle_delta = max(0, idle2 - idle1)
            iowait_delta = max(0, iowait2 - iowait1)
            steal_delta = max(0, steal2 - steal1)
            used = max(0.0, float(total_delta - idle_delta) / float(total_delta))
            return {
                "usagePercent": round(used * 100.0, 2),
                "iowaitPercent": round((float(iowait_delta) / float(total_delta)) * 100.0, 2),
                "stealPercent": round((float(steal_delta) / float(total_delta)) * 100.0, 2),
            }

        now = time.monotonic()
        total2, idle2, iowait2, steal2 = read_cpu()

        global _CPU_LAST
        if _CPU_LAST is not None:
            last_ts, total1, idle1, iowait1, steal1 = _CPU_LAST
            dt_ms = max(0.0, (now - last_ts) * 1000.0)
            if dt_ms >= float(min_window_ms):
                payload = calc(total1, idle1, iowait1, steal1, total2, idle2, iowait2, steal2)
                _CPU_LAST = (now, total2, idle2, iowait2, steal2)
                if payload:
                    return {
                        **payload,
                        "windowSeconds": round(dt_ms / 1000.0, 3),
                        "method": "delta",
                    }

        total1, idle1, iowait1, steal1 = total2, idle2, iowait2, steal2
        time.sleep(sample_ms / 1000.0)
        now2 = time.monotonic()
        total2, idle2, iowait2, steal2 = read_cpu()
        _CPU_LAST = (now2, total2, idle2, iowait2, steal2)

        payload = calc(total1, idle1, iowait1, steal1, total2, idle2, iowait2, steal2)
        if not payload:
            return None
        return {
            **payload,
            "windowSeconds": round(max(0.0, now2 - now), 3),
            "method": "sleep",
            "sampleMs": int(sample_ms),
        }
    except Exception:
        return None


def _process_memory_mb() -> float | None:
    try:
        import resource  # type: ignore

        usage = resource.getrusage(resource.RUSAGE_SELF)
        maxrss = getattr(usage, "ru_maxrss", None)
        if maxrss is None:
            return None
        # On Linux it's kilobytes; on macOS it's bytes.
        if platform.system().lower() == "darwin":
            return round(float(maxrss) / (1024 * 1024), 2)
        return round(float(maxrss) / 1024, 2)
    except Exception:
        return None


def _process_rss_current_mb() -> float | None:
    try:
        if platform.system().lower() != "linux":
            return None
        status_path = Path("/proc/self/status")
        if not status_path.exists():
            return None
        for line in status_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if not line.startswith("VmRSS:"):
                continue
            # Example: "VmRSS:	   12345 kB"
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                kb = int(parts[1])
                return round(kb / 1024.0, 2)
        return None
    except Exception:
        return None


def _disk_usage(path: str) -> dict | None:
    try:
        usage = shutil.disk_usage(path)
        total = float(usage.total)
        used = float(usage.used)
        free = float(usage.free)
        used_pct = round((used / total) * 100, 2) if total else None
        return {
            "totalGb": round(total / (1024**3), 2),
            "usedGb": round(used / (1024**3), 2),
            "freeGb": round(free / (1024**3), 2),
            "usedPercent": used_pct,
        }
    except Exception:
        return None


def _server_usage() -> dict:
    cpu_count = os.cpu_count() or 0
    load_avg = None
    load_pct = None
    cpu_usage = _read_linux_cpu_usage(sample_ms=int(os.environ.get("HEALTH_CPU_SAMPLE_MS") or 150))
    try:
        if hasattr(os, "getloadavg"):
            one, five, fifteen = os.getloadavg()
            load_avg = {"1m": round(one, 2), "5m": round(five, 2), "15m": round(fifteen, 2)}
            if cpu_count > 0:
                load_pct = round((one / cpu_count) * 100, 2)
    except Exception:
        load_avg = None

    config = get_config()
    data_dir = str(getattr(config, "data_dir", None) or Path.cwd())

    return {
        "cpu": {
            "count": cpu_count or None,
            "loadAvg": load_avg,
            "loadPercent": load_pct,
            "usagePercent": (cpu_usage or {}).get("usagePercent"),
            "iowaitPercent": (cpu_usage or {}).get("iowaitPercent"),
            "stealPercent": (cpu_usage or {}).get("stealPercent"),
            "usageWindowSeconds": (cpu_usage or {}).get("windowSeconds"),
            "usageMethod": (cpu_usage or {}).get("method"),
            "usageSampleMs": (cpu_usage or {}).get("sampleMs"),
        },
        "memory": _read_linux_meminfo(),
        "disk": _disk_usage(data_dir),
        "process": {"maxRssMb": _process_memory_mb(), "rssMb": _process_rss_current_mb()},
        "platform": platform.platform(),
    }


def _configured_worker_target() -> int | None:
    """
    Best-effort: surface the intended worker count from common env vars.
    Useful for displaying in health checks; not guaranteed to equal live workers.
    """
    for key in ("WEB_CONCURRENCY", "GUNICORN_WORKERS", "PASSENGER_APP_POOL_SIZE"):
        value = os.environ.get(key)
        if value and str(value).strip().isdigit():
            return int(value)
    return None


def _detect_worker_count() -> int | None:
    """
    Best-effort: try to count running worker processes. Falls back to None if unavailable.
    """
    try:
        if not shutil.which("ps"):
            return None
        marker = "wsgi-loader.py"
        proc_name = Path(sys.argv[0]).name
        output = subprocess.check_output(
            ["ps", "-eo", "cmd"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=float(os.environ.get("HEALTH_PS_TIMEOUT_SECONDS") or 0.6),
        )
        matches = 0
        for line in output.splitlines():
            if marker in line:
                matches += 1
            elif proc_name and proc_name in line:
                matches += 1
        return matches if matches > 0 else None
    except subprocess.TimeoutExpired:
        return None
    except Exception:
        return None


def _parse_gunicorn_args(cmdline: str) -> dict[str, Any] | None:
    if "gunicorn" not in cmdline:
        return None
    try:
        tokens = shlex.split(cmdline)
    except Exception:
        tokens = cmdline.split()
    parsed: dict[str, Any] = {}

    def read_flag(*names: str) -> Optional[str]:
        for i, tok in enumerate(tokens):
            for name in names:
                if tok == name and i + 1 < len(tokens):
                    return tokens[i + 1]
                if tok.startswith(name + "="):
                    return tok.split("=", 1)[1]
        return None

    for flag, key in (
        ("--workers", "workers"),
        ("--threads", "threads"),
        ("--timeout", "timeoutSeconds"),
        ("--graceful-timeout", "gracefulTimeoutSeconds"),
        ("--max-requests", "maxRequests"),
        ("--max-requests-jitter", "maxRequestsJitter"),
        ("--keep-alive", "keepAliveSeconds"),
    ):
        raw = read_flag(flag)
        if raw and raw.isdigit():
            parsed[key] = int(raw)
    worker_class = read_flag("--worker-class", "-k")
    if worker_class:
        parsed["workerClass"] = worker_class
    return parsed or None


def _read_proc_cmdline(pid: int) -> str | None:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
        parts = [p.decode("utf-8", errors="ignore") for p in raw.split(b"\0") if p]
        return " ".join(parts).strip() or None
    except Exception:
        return None


def _read_proc_status_kv(pid: int) -> dict[str, str] | None:
    try:
        if platform.system().lower() != "linux":
            return None
        status_path = Path(f"/proc/{pid}/status")
        if not status_path.exists():
            return None
        parsed: dict[str, str] = {}
        for line in status_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if ":" not in line:
                continue
            key, rest = line.split(":", 1)
            parsed[key.strip()] = rest.strip()
        return parsed or None
    except Exception:
        return None


def _proc_status_memory_mb(status: dict[str, str] | None, key: str) -> float | None:
    try:
        if not status:
            return None
        raw = str(status.get(key) or "")
        # Example: "12345 kB"
        parts = raw.split()
        if len(parts) < 2:
            return None
        value, unit = parts[0], parts[1].lower()
        if not value.isdigit():
            return None
        n = float(value)
        if unit == "kb":
            return round(n / 1024.0, 2)
        if unit == "mb":
            return round(n, 2)
        return None
    except Exception:
        return None


def _read_process_snapshot(pid: int) -> dict[str, Any] | None:
    status = _read_proc_status_kv(pid)
    if not status:
        return None
    return {
        "pid": pid,
        "name": str(status.get("Name") or "").strip() or None,
        "state": str(status.get("State") or "").strip() or None,
        "ppid": int(str(status.get("PPid") or "0").split()[0]) if str(status.get("PPid") or "").split() else None,
        "threads": int(str(status.get("Threads") or "0").split()[0]) if str(status.get("Threads") or "").split() else None,
        "vmRssMb": _proc_status_memory_mb(status, "VmRSS"),
        "vmSizeMb": _proc_status_memory_mb(status, "VmSize"),
    }


def _read_child_processes(parent_pid: int, *, limit: int = 25) -> list[dict[str, Any]] | None:
    """
    Best-effort: enumerate immediate child processes of parent_pid (Linux only).
    Kept lightweight for health checks: cap entries and return minimal fields.
    """
    try:
        if platform.system().lower() != "linux":
            return None
        proc_dir = Path("/proc")
        if not proc_dir.exists():
            return None
        children: list[dict[str, Any]] = []
        for entry in proc_dir.iterdir():
            if not entry.is_dir():
                continue
            if not entry.name.isdigit():
                continue
            pid = int(entry.name)
            status = _read_proc_status_kv(pid)
            if not status:
                continue
            raw_ppid = str(status.get("PPid") or "")
            if not raw_ppid or not raw_ppid.split() or not raw_ppid.split()[0].isdigit():
                continue
            if int(raw_ppid.split()[0]) != parent_pid:
                continue
            snap = _read_process_snapshot(pid)
            if snap:
                children.append(snap)
            if len(children) >= max(1, min(limit, 100)):
                break
        return children or None
    except Exception:
        return None


def _read_cgroup_memory() -> dict[str, Any] | None:
    """
    Expose cgroup memory limits/usage when running under systemd/cgroupv2 (Linux).
    Helps confirm whether SIGKILL is coming from hitting a memory limit.
    """
    try:
        if platform.system().lower() != "linux":
            return None
        candidates = [
            Path("/sys/fs/cgroup/memory.current"),
            Path("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
        ]
        usage_path = next((p for p in candidates if p.exists()), None)
        if not usage_path:
            return None
        usage_bytes = int(usage_path.read_text(encoding="utf-8", errors="ignore").strip() or "0")

        limit_candidates = [
            Path("/sys/fs/cgroup/memory.max"),
            Path("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
        ]
        limit_path = next((p for p in limit_candidates if p.exists()), None)
        limit_raw = limit_path.read_text(encoding="utf-8", errors="ignore").strip() if limit_path else ""
        limit_bytes: int | None
        if not limit_raw or limit_raw.lower() == "max":
            limit_bytes = None
        else:
            limit_bytes = int(limit_raw)

        def mb(value: int | None) -> float | None:
            if value is None:
                return None
            return round(float(value) / (1024.0 * 1024.0), 2)

        used_pct = None
        if limit_bytes and limit_bytes > 0:
            used_pct = round((float(usage_bytes) / float(limit_bytes)) * 100.0, 2)

        return {
            "usageMb": mb(usage_bytes),
            "limitMb": mb(limit_bytes),
            "usedPercent": used_pct,
        }
    except Exception:
        return None


def _read_linux_uptime_seconds() -> float | None:
    try:
        if platform.system().lower() != "linux":
            return None
        uptime_path = Path("/proc/uptime")
        if not uptime_path.exists():
            return None
        raw = uptime_path.read_text(encoding="utf-8", errors="ignore").strip().split()
        if not raw:
            return None
        return float(raw[0])
    except Exception:
        return None


def _parse_proc_starttime_seconds(raw: str, *, clock_ticks_per_second: int) -> float | None:
    """
    Parse process start time in seconds since boot from /proc/<pid>/stat content.
    """
    try:
        text = str(raw or "").strip()
        if not text:
            return None
        # /proc/<pid>/stat has the comm in parentheses which may contain spaces.
        rparen = text.rfind(")")
        if rparen == -1:
            return None
        rest = text[rparen + 1 :].strip().split()
        # starttime is field 22 overall => index 19 in `rest` because fields 1-2
        # (pid and comm) were removed and `rest[0]` is field 3 (state).
        if len(rest) <= 19:
            return None
        ticks = int(rest[19])
        hz = int(clock_ticks_per_second or 0)
        if hz <= 0:
            hz = 100
        return float(ticks) / float(hz)
    except Exception:
        return None


def _read_proc_starttime_seconds(pid: int) -> float | None:
    """
    Return process start time in seconds since boot using /proc/<pid>/stat.
    """
    try:
        if platform.system().lower() != "linux":
            return None
        stat_path = Path(f"/proc/{pid}/stat")
        if not stat_path.exists():
            return None
        hz = os.sysconf(os.sysconf_names.get("SC_CLK_TCK", "SC_CLK_TCK"))  # type: ignore[arg-type]
        return _parse_proc_starttime_seconds(
            stat_path.read_text(encoding="utf-8", errors="ignore"),
            clock_ticks_per_second=int(hz) if hz else 100,
        )
    except Exception:
        return None


def _process_uptime_seconds(pid: int) -> float | None:
    try:
        boot_uptime = _read_linux_uptime_seconds()
        start_since_boot = _read_proc_starttime_seconds(pid)
        if boot_uptime is None or start_since_boot is None:
            return None
        return round(max(0.0, boot_uptime - start_since_boot), 2)
    except Exception:
        return None


def _parse_iso_utc(value: Any) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _background_job_stale_after_seconds(job: dict[str, Any]) -> int:
    interval = job.get("intervalSeconds")
    try:
        interval_seconds = int(float(interval))
    except Exception:
        interval_seconds = 60
    return max(45, min((interval_seconds * 3) + 15, 4 * 60 * 60))


def _normalize_background_job_modes_for_health(
    jobs: dict[str, dict[str, Any]],
    *,
    web_mode: str,
) -> dict[str, dict[str, Any]]:
    normalized_web_mode = str(web_mode or "").strip().lower()
    if normalized_web_mode != "external":
        return {name: dict(raw_job or {}) for name, raw_job in (jobs or {}).items()}

    normalized: dict[str, dict[str, Any]] = {}
    for name, raw_job in (jobs or {}).items():
        job = dict(raw_job or {})
        enabled = bool(job.get("enabled", True))
        job_mode = str(job.get("mode") or "thread").strip().lower() or "thread"
        if enabled and job_mode == "thread":
            job["mode"] = "external"
            if not bool(job.get("running")):
                job["state"] = "external"
                if not job.get("reason"):
                    job["reason"] = "external_mode"
        normalized[name] = job
    return normalized


def _assess_background_jobs_health(jobs: dict[str, dict[str, Any]]) -> dict[str, Any]:
    status = "ok"
    unhealthy: list[str] = []
    now = datetime.now(timezone.utc)
    assessed: dict[str, dict[str, Any]] = {}

    for name, raw_job in jobs.items():
        job = dict(raw_job or {})
        enabled = bool(job.get("enabled", True))
        mode = str(job.get("mode") or "thread").strip().lower() or "thread"
        running = bool(job.get("running"))
        supervisor_alive = bool(job.get("supervisorAlive"))
        stale_after = _background_job_stale_after_seconds(job)
        pulse_at = _parse_iso_utc(job.get("lastHeartbeatAt")) or _parse_iso_utc(job.get("lastStartedAt"))
        heartbeat_age = None
        if pulse_at is not None:
            heartbeat_age = round(max(0.0, (now - pulse_at).total_seconds()), 2)

        health_ok = True
        reason = None
        lifecycle = "running"

        if not enabled:
            lifecycle = "disabled"
        elif mode != "thread" and not running:
            lifecycle = "external"
        elif not supervisor_alive or not running:
            health_ok = False
            reason = "thread_not_running"
            lifecycle = "restarting" if supervisor_alive else "stopped"
        elif heartbeat_age is None:
            health_ok = False
            reason = "missing_heartbeat"
        elif heartbeat_age > stale_after:
            health_ok = False
            reason = "stale_heartbeat"

        if not health_ok:
            status = "degraded"
            unhealthy.append(name)

        job["lifecycle"] = lifecycle
        job["heartbeatAgeSeconds"] = heartbeat_age
        job["staleAfterSeconds"] = stale_after
        job["health"] = {
            "ok": health_ok,
            "reason": reason,
        }
        assessed[name] = job

    return {
        "status": status,
        "unhealthyJobs": unhealthy,
        "jobs": assessed,
    }


def _background_job_stats() -> dict[str, Any]:
    from ..services import patient_links_sweep_service
    from ..services import presence_sweep_service
    from ..services import product_document_sync_service
    from ..services import shipstation_status_sync_service
    from ..services import ups_status_sync_service

    web_mode = str(os.environ.get("PEPPRO_WEB_BACKGROUND_JOBS_MODE") or "").strip().lower() or "thread"
    jobs = {
        "productDocumentSync": product_document_sync_service.get_status(),
        "shipstationStatusSync": shipstation_status_sync_service.get_status(),
        "upsStatusSync": ups_status_sync_service.get_status(),
        "presenceSweep": presence_sweep_service.get_status(),
        "patientLinksSweep": patient_links_sweep_service.get_status(),
    }
    jobs = _normalize_background_job_modes_for_health(jobs, web_mode=web_mode)
    assessment = _assess_background_jobs_health(jobs)
    return {
        "mode": "scheduled",
        "status": assessment["status"],
        "webProcessMode": web_mode,
        "backgroundRunner": "python -m python_backend.background_jobs",
        "catalogSnapshotRunner": "python -m python_backend.scripts.sync_catalog_snapshot",
        "productDocumentSyncMode": str(os.environ.get("WOO_PRODUCT_DOC_SYNC_MODE", "thread")).strip().lower() or "thread",
        "shipstationStatusSyncMode": str(os.environ.get("SHIPSTATION_STATUS_SYNC_MODE", "thread")).strip().lower() or "thread",
        "upsStatusSyncMode": str(os.environ.get("UPS_STATUS_SYNC_MODE", "thread")).strip().lower() or "thread",
        "presenceSweepMode": str(os.environ.get("PRESENCE_SWEEP_MODE", "thread")).strip().lower() or "thread",
        "patientLinksSweepMode": str(os.environ.get("PATIENT_LINKS_SWEEP_MODE", "thread")).strip().lower() or "thread",
        "unhealthyJobs": assessment["unhealthyJobs"],
        "jobs": assessment["jobs"],
    }


def _active_request_warn_seconds() -> float:
    raw = str(os.environ.get("PEPPRO_HEALTH_ACTIVE_REQUEST_WARN_SECONDS") or "20").strip()
    try:
        value = float(raw)
    except Exception:
        value = 20.0
    return max(1.0, min(value, 300.0))


def _active_request_stats() -> dict[str, Any]:
    return request_logging_middleware.get_request_runtime_snapshot(
        slow_after_seconds=_active_request_warn_seconds(),
        max_items=12,
    )


def _health_password_value() -> str | None:
    password = str(os.environ.get(_HEALTH_PASSWORD_ENV) or "")
    return password if password else None


def _health_password_form_response(
    *,
    error: str | None = None,
    status: int = 200,
    configured: bool = True,
) -> Response:
    escaped_error = html.escape(str(error or "").strip())
    form_html = (
        """
        <form method="post" autocomplete="off">
          <label for="health-password">Password</label>
          <input id="health-password" name="password" type="password" required autofocus />
          <button type="submit">View health</button>
        </form>
        """
        if configured
        else """
        <p class="note">Set <code>PEPPRO_HEALTH_PASSWORD</code> in the backend environment to enable this page.</p>
        """
    )
    error_html = (
        f'<p class="error" role="alert">{escaped_error}</p>'
        if escaped_error
        else ""
    )
    response = current_app.response_class(
        response=f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PepPro Server Health</title>
    <style>
      :root {{
        color-scheme: light;
        font-family: "Inter", "Segoe UI", sans-serif;
      }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(95, 179, 249, 0.22), transparent 38%),
          linear-gradient(180deg, #f7fafc 0%, #e2e8f0 100%);
        color: #0f172a;
      }}
      .card {{
        width: min(100%, 420px);
        margin: 24px;
        padding: 28px;
        border-radius: 24px;
        border: 1px solid rgba(148, 163, 184, 0.28);
        background: rgba(255, 255, 255, 0.94);
        box-shadow: 0 24px 60px -36px rgba(15, 23, 42, 0.4);
      }}
      h1 {{
        margin: 0;
        font-size: 1.75rem;
        line-height: 1.1;
      }}
      p {{
        margin: 12px 0 0;
        line-height: 1.6;
        color: #475569;
      }}
      form {{
        margin-top: 18px;
        display: grid;
        gap: 12px;
      }}
      label {{
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #475569;
      }}
      input {{
        appearance: none;
        border: 1px solid rgba(148, 163, 184, 0.55);
        border-radius: 14px;
        padding: 0.9rem 1rem;
        font: inherit;
        color: #0f172a;
        background: rgba(248, 250, 252, 0.95);
      }}
      input:focus {{
        outline: 2px solid rgba(95, 179, 249, 0.3);
        outline-offset: 1px;
        border-color: #5fb3f9;
      }}
      button {{
        appearance: none;
        border: 0;
        border-radius: 999px;
        padding: 0.9rem 1rem;
        font: inherit;
        font-weight: 700;
        color: white;
        background: linear-gradient(135deg, #0f172a 0%, #1d4ed8 100%);
        cursor: pointer;
      }}
      .error {{
        padding: 0.85rem 1rem;
        border-radius: 14px;
        background: #fff1f2;
        border: 1px solid #fecdd3;
        color: #be123c;
      }}
      .note code {{
        font-family: "SFMono-Regular", "SFMono-Regular", ui-monospace, monospace;
      }}
    </style>
  </head>
  <body>
    <main class="card">
      <h1>Server Health</h1>
      <p>Enter the server health password to view the live backend diagnostics.</p>
      {error_html}
      {form_html}
    </main>
  </body>
</html>
""",
        status=status,
        mimetype="text/html",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


def _health_password_json_response(message: str, *, code: str, status: int = 401) -> Response:
    response = current_app.response_class(
        response=current_app.json.dumps({"error": message, "code": code}),
        status=status,
        mimetype="application/json",
    )
    response.headers["Cache-Control"] = "no-store"
    return response


def _request_prefers_html() -> bool:
    best = request.accept_mimetypes.best_match(["text/html", "application/json"])
    if best != "text/html":
        return False
    return request.accept_mimetypes["text/html"] >= request.accept_mimetypes["application/json"]


def _health_password_error_response(message: str, *, code: str, status: int = 401) -> Response:
    if _request_prefers_html():
        return _health_password_form_response(
            error=message,
            status=status,
            configured=_health_password_value() is not None,
        )
    return _health_password_json_response(message, code=code, status=status)


def _read_health_password_candidate() -> str | None:
    header_password = request.headers.get(_HEALTH_PASSWORD_HEADER)
    if isinstance(header_password, str) and header_password:
        return header_password
    if request.method == "POST":
        if request.is_json:
            payload = request.get_json(silent=True) or {}
            candidate = payload.get("password")
        else:
            candidate = request.form.get("password")
        if candidate is None:
            return None
        return str(candidate)
    return None


def _require_health_password() -> Response | None:
    expected_password = _health_password_value()
    if expected_password is None:
        if _request_prefers_html():
            return _health_password_form_response(
                error="Server health password is not configured.",
                status=503,
                configured=False,
            )
        return _health_password_json_response(
            "Server health password is not configured.",
            code="HEALTH_PASSWORD_NOT_CONFIGURED",
            status=503,
        )

    candidate = _read_health_password_candidate()
    if candidate is None or candidate == "":
        if _request_prefers_html():
            return _health_password_form_response()
        return _health_password_json_response(
            "Server health requires a password.",
            code="HEALTH_PASSWORD_REQUIRED",
        )

    if not secrets.compare_digest(candidate, expected_password):
        return _health_password_error_response(
            "Server health password was rejected.",
            code="HEALTH_PASSWORD_INVALID",
        )

    return None


def _authenticate_admin_health_request() -> tuple[bool, Response | None]:
    header = str(request.headers.get("Authorization") or "").strip()
    if not header:
        return False, None

    error = auth_middleware._authenticate_request(allow_media_cookie=False)
    if error is not None:
        return False, error

    role = str((getattr(g, "current_user", None) or {}).get("role") or "").strip().lower()
    if role != "admin":
        return False, _health_password_json_response(
            "Admin access required",
            code="FORBIDDEN",
            status=403,
        )

    return True, None


@blueprint.get("/ping")
def ping():
    return handle_action(lambda: {"ok": True, "timestamp": _now()})


@blueprint.route("/health", methods=["GET", "POST"])
def health():
    admin_authenticated, auth_error = _authenticate_admin_health_request()
    if auth_error is not None:
        return auth_error
    if not admin_authenticated:
        password_error = _require_health_password()
        if password_error is not None:
            return password_error

    def action():
        try:
            config = get_config()
            build = config.backend_build
            usage = _server_usage()
            status = "ok"
            mysql_enabled = bool(getattr(config, "mysql", {}).get("enabled"))
            pid = os.getpid()
            ppid = os.getppid()
            master_cmdline = _read_proc_cmdline(ppid) if ppid else None
            master = _read_process_snapshot(ppid) if ppid else None
            children = _read_child_processes(ppid) if ppid else None
            uptime = {
                "serviceSeconds": _process_uptime_seconds(ppid) if ppid else None,
                "workerSeconds": _process_uptime_seconds(pid) if pid else None,
            }
            workers = {
                "pid": pid,
                "ppid": ppid,
            }
            gunicorn = _parse_gunicorn_args(master_cmdline or "") if master_cmdline else None
            configured_workers = _configured_worker_target()
            if configured_workers is None and isinstance(gunicorn, dict):
                parsed_workers = gunicorn.get("workers")
                if isinstance(parsed_workers, int) and parsed_workers > 0:
                    configured_workers = parsed_workers
            detected_workers = _detect_worker_count()
            if detected_workers is None and isinstance(children, list):
                detected_workers = len(children)
            workers.update(
                {
                    "configured": configured_workers,
                    "detected": detected_workers,
                    "gunicorn": gunicorn,
                }
            )
            if (
                isinstance(configured_workers, int)
                and isinstance(detected_workers, int)
                and detected_workers < configured_workers
            ):
                status = "degraded"
            background_jobs = _background_job_stats()
            if str(background_jobs.get("status") or "").strip().lower() == "degraded":
                status = "degraded"
            request_stats = _active_request_stats()
            if int(request_stats.get("slowCount") or 0) > 0:
                status = "degraded"
        except Exception:
            # Never allow health checks to 500; return a degraded payload instead.
            build = os.environ.get("BACKEND_BUILD", "unknown")
            usage = None
            status = "degraded"
            mysql_enabled = None
            workers = None
            background_jobs = None
            request_stats = None
            master = None
            children = None
            uptime = None
        return {
            "status": status,
            "message": "Server is running",
            "build": build,
            "routeSet": str(current_app.config.get("APP_ROUTE_SET") or ""),
            "mysql": {"enabled": mysql_enabled},
            "usage": usage,
            "cgroup": {"memory": _read_cgroup_memory()},
            "workers": workers,
            "processes": {"master": master, "children": children},
            "uptime": uptime,
            "backgroundJobs": background_jobs,
            "requests": request_stats,
            "timestamp": _now(),
        }

    return handle_action(action)


@blueprint.get("/help")
def help_endpoint():
    def action():
        config = get_config()
        return {
            "ok": True,
            "service": "PepPro Backend",
            "build": config.backend_build,
            "mysql": {"enabled": bool(getattr(config, "mysql", {}).get("enabled"))},
            "integrations": {
                "wooCommerce": {"configured": woo_commerce.is_configured()},
                "shipEngine": {"configured": ship_engine.is_configured()},
                "shipStation": {"configured": bool(getattr(config, "ship_station", {}).get("api_token") or getattr(config, "ship_station", {}).get("api_key"))},
            },
            "endpoints": [
                "/api/auth/login",
                "/api/auth/register",
                "/api/auth/me",
                "/api/auth/me/delete",
                "/api/auth/check-email",
                "/api/orders",
                "/api/shipping/rates",
                "/api/quotes/daily",
                "/api/quotes",
                "/api/woo/products",
                "/api/woo/products/categories",
                "/api/referrals/doctor/summary",
                "/api/referrals/admin/dashboard",
                "/api/settings/shop",
                "/api/settings/forum",
                "/api/settings/research",
                "/api/forum/the-peptide-forum",
                "/api/contact",
                "/api/integrations/google-sheets/sales-reps",
                "/api/integrations/google-sheets/the-peptide-forum",
                "/api/help",
                "/api/news/peptides",
                "/api/health",
            ],
            "timestamp": _now(),
        }

    return handle_action(action)


@blueprint.get("/network/test-download")
def network_test_download():
    def action():
        raw = request.args.get("bytes", "").strip()
        size = 250_000
        if raw.isdigit():
            size = int(raw)
        size = max(1_000, min(size, 750_000))

        # Use random bytes to prevent proxy compression skewing the measurement.
        payload = os.urandom(size)
        resp = Response(payload, mimetype="application/octet-stream")
        resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["X-Bytes"] = str(size)
        resp.headers["X-Timestamp"] = str(int(time.time() * 1000))
        return resp

    return handle_action(action)


@blueprint.post("/network/test-upload")
def network_test_upload():
    def action():
        data = request.get_data(cache=False, as_text=False) or b""
        size = len(data)
        max_size = 750_000
        if size > max_size:
            return {"ok": False, "error": "Payload too large", "maxBytes": max_size}, 413
        return {
            "ok": True,
            "bytesReceived": size,
            "timestamp": _now(),
        }

    return handle_action(action)


@blueprint.get("/news/peptides")
def peptide_news():
    def action():
        items = news_service.fetch_peptide_news(limit=8)
        return {
            "items": [
                {
                    "title": item.title,
                    "url": item.url,
                    "summary": item.summary,
                    "imageUrl": item.image_url,
                    "date": item.date,
                }
                for item in items
            ],
            "count": len(items),
        }

    return handle_action(action)
