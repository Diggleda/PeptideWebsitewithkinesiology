from __future__ import annotations

import itertools
import logging
import threading
import time
from typing import Any

from flask import Flask, g, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_REQUESTS: dict[str, dict[str, Any]] = {}
_ACTIVE_SEQUENCE = itertools.count(1)


def _should_track(path: str) -> bool:
    return path.startswith("/api")


def _best_client_ip() -> str:
    raw = (
        request.headers.get("CF-Connecting-IP")
        or request.headers.get("X-Forwarded-For")
        or request.remote_addr
        or "unknown"
    )
    return raw.split(",")[0].strip() if raw else "unknown"


def _route_label() -> str:
    rule = getattr(request, "url_rule", None)
    value = getattr(rule, "rule", None) or request.path or "unknown"
    return str(value).strip() or "unknown"


def _request_bytes() -> int | None:
    value = request.content_length
    if isinstance(value, int):
        return max(0, value)
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return 0
    return None


def _response_bytes(response) -> int | None:
    value = getattr(response, "content_length", None)
    if isinstance(value, int):
        return max(0, value)
    try:
        calculated = response.calculate_content_length()
    except Exception:
        calculated = None
    if isinstance(calculated, int):
        return max(0, calculated)
    try:
        if not getattr(response, "is_streamed", False):
            payload = response.get_data()
            if isinstance(payload, (bytes, bytearray)):
                return len(payload)
    except Exception:
        return None
    return None


def _response_type(response) -> str:
    value = getattr(response, "mimetype", None) or getattr(response, "content_type", None) or "unknown"
    return str(value).strip().replace(" ", "_") or "unknown"


def _active_request_key() -> str:
    return f"{time.time_ns()}-{next(_ACTIVE_SEQUENCE)}"


def _remove_active_request() -> None:
    key = getattr(g, "_request_logging_active_key", None)
    if not key:
        return
    with _ACTIVE_LOCK:
        _ACTIVE_REQUESTS.pop(str(key), None)
    g._request_logging_active_key = None


def get_request_runtime_snapshot(
    *,
    slow_after_seconds: float = 20.0,
    max_items: int = 12,
) -> dict[str, Any]:
    """
    Return a lightweight view of API requests currently executing in this process.

    This is intentionally per-process. In gunicorn, `/api/health` reports the worker
    that handled the health request, while process snapshots still show the sibling
    worker PIDs. If a worker is wedged, sending SIGUSR1 to that worker remains the
    authoritative stack-dump tool.
    """
    try:
        slow_after = float(slow_after_seconds)
    except Exception:
        slow_after = 20.0
    slow_after = max(1.0, min(slow_after, 300.0))
    max_items = max(0, min(int(max_items or 0), 50))
    now = time.perf_counter()

    with _ACTIVE_LOCK:
        records = list(_ACTIVE_REQUESTS.values())

    active: list[dict[str, Any]] = []
    slow_count = 0
    longest_age = 0.0
    for record in records:
        started = record.get("startedMonotonic")
        if not isinstance(started, (int, float)):
            continue
        age = max(0.0, now - float(started))
        longest_age = max(longest_age, age)
        is_longpoll = bool(record.get("longPoll"))
        if age >= slow_after and not is_longpoll:
            slow_count += 1
        active.append(
            {
                "ageSeconds": round(age, 3),
                "method": record.get("method"),
                "path": record.get("path"),
                "route": record.get("route"),
                "clientIp": record.get("clientIp"),
                "longPoll": is_longpoll,
                "startedAtEpoch": record.get("startedAtEpoch"),
            }
        )

    active.sort(key=lambda item: float(item.get("ageSeconds") or 0), reverse=True)
    return {
        "activeCount": len(active),
        "slowCount": slow_count,
        "slowAfterSeconds": slow_after,
        "longestActiveSeconds": round(longest_age, 3) if active else None,
        "active": active[:max_items],
    }


def init_request_logging(app: Flask) -> None:
    """
    Attach basic request/response logging for API routes.
    """
    logger = logging.getLogger("peppro.http")

    @app.before_request
    def _log_start() -> None:  # type: ignore[return-value]
        if _should_track(request.path):
            started = time.perf_counter()
            g._request_logging_started_at = started
            key = _active_request_key()
            g._request_logging_active_key = key
            with _ACTIVE_LOCK:
                _ACTIVE_REQUESTS[key] = {
                    "startedMonotonic": started,
                    "startedAtEpoch": round(time.time(), 3),
                    "method": request.method,
                    "path": request.path,
                    "route": _route_label(),
                    "clientIp": _best_client_ip(),
                    "longPoll": "/longpoll" in request.path.lower(),
                }

    @app.after_request
    def _log_response(response):  # type: ignore[return-value]
        if _should_track(request.path):
            started = getattr(g, "_request_logging_started_at", None)
            duration_ms = None
            if isinstance(started, float):
                duration_ms = (time.perf_counter() - started) * 1000
            req_bytes = _request_bytes()
            resp_bytes = _response_bytes(response)
            logger.info(
                "HTTP method=%s path=%s route=%s status=%s duration_ms=%.1f req_bytes=%s resp_bytes=%s client_ip=%s resp_type=%s",
                request.method,
                request.path,
                _route_label(),
                response.status_code,
                duration_ms or -1,
                req_bytes if req_bytes is not None else -1,
                resp_bytes if resp_bytes is not None else -1,
                _best_client_ip(),
                _response_type(response),
            )
            _remove_active_request()
        return response

    @app.teardown_request
    def _cleanup_active_request(error=None) -> None:  # type: ignore[return-value]
        if _should_track(request.path):
            _remove_active_request()

    @app.errorhandler(404)
    def _not_found(error):  # type: ignore[return-value]
        if _should_track(request.path):
            logger.warning("Route not found: %s %s", request.method, request.path)
            return jsonify({"error": "NOT_FOUND", "message": "Endpoint does not exist"}), 404
        return error

    @app.errorhandler(405)
    def _method_not_allowed(error):  # type: ignore[return-value]
        if _should_track(request.path):
            logger.warning("Method not allowed: %s %s", request.method, request.path)
            return jsonify({"error": "METHOD_NOT_ALLOWED"}), 405
        return error

    @app.errorhandler(RequestEntityTooLarge)
    def _request_too_large(error):  # type: ignore[return-value]
        if _should_track(request.path):
            max_bytes = app.config.get("MAX_CONTENT_LENGTH")
            logger.warning(
                "Payload too large: %s %s (max=%s)",
                request.method,
                request.path,
                max_bytes,
            )
            return (
                jsonify(
                    {
                        "error": "PAYLOAD_TOO_LARGE",
                        "message": "Upload is too large.",
                        "maxBytes": int(max_bytes) if isinstance(max_bytes, int) else None,
                    }
                ),
                413,
            )
        return error
