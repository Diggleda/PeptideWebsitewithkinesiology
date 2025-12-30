from __future__ import annotations

import os
import threading
import time
from collections import deque
from typing import Deque, Dict, Tuple

from flask import Flask, jsonify, request


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


_RATE_LIMIT_ENABLED = _truthy(os.environ.get("RATE_LIMIT_ENABLED", "true"))
_WINDOW_SECONDS = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60").strip() or 60)
_WINDOW_SECONDS = max(10, min(_WINDOW_SECONDS, 10 * 60))

_DEFAULT_MAX = int(os.environ.get("RATE_LIMIT_MAX_REQUESTS", "300").strip() or 300)
_DEFAULT_MAX = max(30, min(_DEFAULT_MAX, 5000))

_EXPENSIVE_MAX = int(os.environ.get("RATE_LIMIT_MAX_REQUESTS_EXPENSIVE", "80").strip() or 80)
_EXPENSIVE_MAX = max(10, min(_EXPENSIVE_MAX, 1000))

_lock = threading.Lock()
_hits: Dict[Tuple[str, str], Deque[float]] = {}


def _is_api_path(path: str) -> bool:
    return (path or "").startswith("/api")


def _is_exempt(path: str) -> bool:
    if not path:
        return True
    if path.startswith("/api/health"):
        return True
    return False


def _limit_for_path(path: str) -> int:
    path = path or ""
    if path.startswith("/api/orders/sales-rep") or path.startswith("/api/woo"):
        return _EXPENSIVE_MAX
    return _DEFAULT_MAX


def init_rate_limit(app: Flask) -> None:
    """
    Very small in-memory rate limiter to prevent runaway polling / thundering herds
    from exhausting low cPanel resource plans.
    """
    if not _RATE_LIMIT_ENABLED:
        return

    @app.before_request
    def _rate_limit() -> None:  # type: ignore[return-value]
        if request.method == "OPTIONS":
            return
        if not _is_api_path(request.path) or _is_exempt(request.path):
            return

        limit = _limit_for_path(request.path)
        ip = request.headers.get("CF-Connecting-IP") or request.headers.get("X-Forwarded-For") or request.remote_addr or "unknown"
        ip = ip.split(",")[0].strip() if ip else "unknown"

        key = (ip, request.path)
        now = time.time()
        cutoff = now - _WINDOW_SECONDS

        with _lock:
            bucket = _hits.get(key)
            if bucket is None:
                bucket = deque()
                _hits[key] = bucket

            while bucket and bucket[0] < cutoff:
                bucket.popleft()

            if len(bucket) >= limit:
                retry_after = max(1, int(_WINDOW_SECONDS - (now - bucket[0])) if bucket else _WINDOW_SECONDS)
                response = jsonify(
                    {
                        "error": "RATE_LIMITED",
                        "message": "Too many requests. Please wait a moment and try again.",
                        "retryAfterSeconds": retry_after,
                    }
                )
                response.status_code = 429
                response.headers["Retry-After"] = str(retry_after)
                return response

            bucket.append(now)

