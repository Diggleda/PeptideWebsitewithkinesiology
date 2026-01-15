from __future__ import annotations

from flask import Blueprint, Response, request

import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional, Tuple

from ..services import get_config
from ..services import news_service
from ..integrations import ship_engine, woo_commerce
from ..middleware.auth import require_auth
from ..queue import ping as queue_ping
from ..queue import get_queue as get_rq_queue
from ..queue import enqueue as queue_enqueue
from ..jobs.product_docs import sync_product_documents
from ..jobs.catalog_snapshot import sync_catalog_snapshot_job
from ..utils.http import handle_action

blueprint = Blueprint("system", __name__, url_prefix="/api")


def _require_admin_user() -> None:
    from flask import g

    role = str((getattr(g, "current_user", None) or {}).get("role") or "").strip().lower()
    if role != "admin":
        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err


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
    tokens = cmdline.split()
    parsed: dict[str, Any] = {}

    def read_flag(name: str) -> Optional[str]:
        for i, tok in enumerate(tokens):
            if tok == name and i + 1 < len(tokens):
                return tokens[i + 1]
            if tok.startswith(name + "="):
                return tok.split("=", 1)[1]
        return None

    for flag, key in (("--workers", "workers"), ("--threads", "threads"), ("--timeout", "timeoutSeconds")):
        raw = read_flag(flag)
        if raw and raw.isdigit():
            parsed[key] = int(raw)
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
        # /proc/<pid>/stat has the comm in parentheses which may contain spaces.
        raw = stat_path.read_text(encoding="utf-8", errors="ignore").strip()
        rparen = raw.rfind(")")
        if rparen == -1:
            return None
        rest = raw[rparen + 1 :].strip().split()
        # starttime is field 22 overall => field index 20 in "rest" (since fields 1-2 removed).
        if len(rest) <= 20:
            return None
        ticks = int(rest[20])
        hz = os.sysconf(os.sysconf_names.get("SC_CLK_TCK", "SC_CLK_TCK"))  # type: ignore[arg-type]
        hz = int(hz) if hz else 100
        if hz <= 0:
            hz = 100
        return float(ticks) / float(hz)
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


def _queue_stats() -> dict[str, Any] | None:
    try:
        q = get_rq_queue()
        return {"name": q.name, "length": q.count}
    except Exception:
        return None


@blueprint.get("/health")
def health():
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
                "configured": _configured_worker_target(),
                "detected": _detect_worker_count(),
                "pid": pid,
                "ppid": ppid,
                "gunicorn": _parse_gunicorn_args(master_cmdline or "") if master_cmdline else None,
            }
            queue = _queue_stats()
        except Exception:
            # Never allow health checks to 500; return a degraded payload instead.
            build = os.environ.get("BACKEND_BUILD", "unknown")
            usage = None
            status = "degraded"
            mysql_enabled = None
            workers = None
            queue = None
            master = None
            children = None
            uptime = None
        return {
            "status": status,
            "message": "Server is running",
            "build": build,
            "mysql": {"enabled": mysql_enabled},
            "usage": usage,
            "cgroup": {"memory": _read_cgroup_memory()},
            "workers": workers,
            "processes": {"master": master, "children": children},
            "uptime": uptime,
            "queue": queue,
            "timestamp": _now(),
        }

    return handle_action(action)


@blueprint.get("/queue/health")
def queue_health():
    return handle_action(queue_ping)


@blueprint.post("/queue/enqueue/product-docs-sync")
@require_auth
def enqueue_product_docs_sync():
    def action():
        _require_admin_user()
        job = queue_enqueue(sync_product_documents, description="sync_product_documents")
        return {"ok": True, "jobId": job.id}

    return handle_action(action, status=202)


@blueprint.post("/queue/enqueue/catalog-snapshot-sync")
@require_auth
def enqueue_catalog_snapshot_sync():
    def action():
        _require_admin_user()
        job = queue_enqueue(sync_catalog_snapshot_job, description="sync_catalog_snapshot_job")
        return {"ok": True, "jobId": job.id}

    return handle_action(action, status=202)


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
                "shipStation": {"configured": getattr(config, "ship_station", {}).get("api_token") or getattr(config, "ship_station", {}).get("api_key")},
            },
            "endpoints": [
                "/api/auth/login",
                "/api/auth/register",
                "/api/auth/me",
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


def _now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


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
