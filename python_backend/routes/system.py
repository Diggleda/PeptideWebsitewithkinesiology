from __future__ import annotations

from flask import Blueprint, Response, request

import os
import platform
import shutil
import subprocess
import sys
import time
from pathlib import Path

from ..services import get_config
from ..services import news_service
from ..integrations import ship_engine, woo_commerce
from ..middleware.auth import require_auth
from ..queue import ping as queue_ping
from ..queue import enqueue as queue_enqueue
from ..jobs.product_docs import sync_product_documents
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


def _disk_usage(path: str) -> dict | None:
    try:
        usage = shutil.disk_usage(path)
        total = float(usage.total)
        used = float(usage.used)
        free = float(usage.free)
        used_pct = round((used / total) * 100, 2) if total else None
        return {
            "totalGb": round(total / (1024**3), 2),
            "freeGb": round(free / (1024**3), 2),
            "usedPercent": used_pct,
        }
    except Exception:
        return None


def _server_usage() -> dict:
    cpu_count = os.cpu_count() or 0
    load_avg = None
    load_pct = None
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
        },
        "memory": _read_linux_meminfo(),
        "disk": _disk_usage(data_dir),
        "process": {"maxRssMb": _process_memory_mb()},
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
        output = subprocess.check_output(["ps", "-eo", "cmd"], text=True, stderr=subprocess.DEVNULL)
        matches = 0
        for line in output.splitlines():
            if marker in line:
                matches += 1
            elif proc_name and proc_name in line:
                matches += 1
        return matches if matches > 0 else None
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
            workers = {
                "configured": _configured_worker_target(),
                "detected": _detect_worker_count(),
                "pid": os.getpid(),
            }
        except Exception:
            # Never allow health checks to 500; return a degraded payload instead.
            build = os.environ.get("BACKEND_BUILD", "unknown")
            usage = None
            status = "degraded"
            mysql_enabled = None
            workers = None
        return {
            "status": status,
            "message": "Server is running",
            "build": build,
            "mysql": {"enabled": mysql_enabled},
            "usage": usage,
            "workers": workers,
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
                "/api/contact",
                "/api/integrations/google-sheets/sales-reps",
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
