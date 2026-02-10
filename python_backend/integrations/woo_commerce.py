from __future__ import annotations

import logging
from datetime import datetime
import hashlib
import json
import os
import re
import threading
import time
from typing import Dict, Optional, Mapping, Any, List
from uuid import uuid4

import requests
from requests.auth import HTTPBasicAuth
from urllib.parse import quote

from ..services import get_config

logger = logging.getLogger(__name__)

_WOO_PROXY_DISK_CACHE_ENABLED = os.environ.get("WOO_PROXY_DISK_CACHE", "true").strip().lower() == "true"
_WOO_PROXY_MAX_STALE_MS = int(os.environ.get("WOO_PROXY_MAX_STALE_MS", str(24 * 60 * 60 * 1000)).strip() or 0)
_WOO_PROXY_MAX_STALE_MS = _WOO_PROXY_MAX_STALE_MS if _WOO_PROXY_MAX_STALE_MS > 0 else 24 * 60 * 60 * 1000

_catalog_cache: Dict[str, Dict[str, Any]] = {}
_catalog_cache_lock = threading.Lock()
_inflight: Dict[str, Dict[str, Any]] = {}
_MAX_IN_MEMORY_CACHE_KEYS = 500
_proxy_failures: Dict[str, Dict[str, Any]] = {}
_WOO_PROXY_FAILURE_COOLDOWN_SECONDS = int(os.environ.get("WOO_PROXY_FAILURE_COOLDOWN_SECONDS", "30").strip() or 30)
_WOO_PROXY_FAILURE_COOLDOWN_SECONDS = max(5, min(_WOO_PROXY_FAILURE_COOLDOWN_SECONDS, 900))
_WOO_PROXY_FAILURE_MAX_COOLDOWN_SECONDS = int(os.environ.get("WOO_PROXY_FAILURE_MAX_COOLDOWN_SECONDS", "300").strip() or 300)
_WOO_PROXY_FAILURE_MAX_COOLDOWN_SECONDS = max(10, min(_WOO_PROXY_FAILURE_MAX_COOLDOWN_SECONDS, 3600))
_WOO_PROXY_FAILURE_RESET_AFTER_SECONDS = int(os.environ.get("WOO_PROXY_FAILURE_RESET_AFTER_SECONDS", "600").strip() or 600)
_WOO_PROXY_FAILURE_RESET_AFTER_SECONDS = max(30, min(_WOO_PROXY_FAILURE_RESET_AFTER_SECONDS, 24 * 60 * 60))
_BACKGROUND_REFRESH_CONCURRENCY = int(os.environ.get("WOO_PROXY_BACKGROUND_REFRESH_CONCURRENCY", "4").strip() or 4)
_BACKGROUND_REFRESH_CONCURRENCY = max(1, min(_BACKGROUND_REFRESH_CONCURRENCY, 16))
_background_refresh_semaphore = threading.BoundedSemaphore(_BACKGROUND_REFRESH_CONCURRENCY)
_WOO_HTTP_CONCURRENCY = int(os.environ.get("WOO_HTTP_CONCURRENCY", "4").strip() or 4)
_WOO_HTTP_CONCURRENCY = max(1, min(_WOO_HTTP_CONCURRENCY, 16))
_woo_http_semaphore = threading.BoundedSemaphore(_WOO_HTTP_CONCURRENCY)
_WOO_HTTP_ACQUIRE_TIMEOUT_SECONDS = float(os.environ.get("WOO_HTTP_ACQUIRE_TIMEOUT_SECONDS", "6").strip() or 6)
_WOO_HTTP_ACQUIRE_TIMEOUT_SECONDS = max(0.5, min(_WOO_HTTP_ACQUIRE_TIMEOUT_SECONDS, 25.0))
_WOO_HTTP_MAX_ATTEMPTS = int(os.environ.get("WOO_HTTP_MAX_ATTEMPTS", "3").strip() or 3)
_WOO_HTTP_MAX_ATTEMPTS = max(1, min(_WOO_HTTP_MAX_ATTEMPTS, 6))
_WOO_PROXY_INFLIGHT_WAIT_SECONDS = float(os.environ.get("WOO_PROXY_INFLIGHT_WAIT_SECONDS", "6").strip() or 6)
_WOO_PROXY_INFLIGHT_WAIT_SECONDS = max(1.0, min(_WOO_PROXY_INFLIGHT_WAIT_SECONDS, 35.0))
_orders_by_email_cache: Dict[str, Dict[str, Any]] = {}
_orders_by_email_cache_lock = threading.Lock()
_orders_by_email_cached_warning_at_ms: Dict[str, int] = {}
_ORDERS_BY_EMAIL_TTL_SECONDS = int(os.environ.get("WOO_ORDERS_BY_EMAIL_TTL_SECONDS", "30").strip() or 30)
_ORDERS_BY_EMAIL_TTL_SECONDS = max(5, min(_ORDERS_BY_EMAIL_TTL_SECONDS, 300))
_ORDERS_BY_EMAIL_MAX_STALE_MS = int(os.environ.get("WOO_ORDERS_BY_EMAIL_MAX_STALE_MS", str(15 * 60 * 1000)).strip() or 0)
_ORDERS_BY_EMAIL_MAX_STALE_MS = _ORDERS_BY_EMAIL_MAX_STALE_MS if _ORDERS_BY_EMAIL_MAX_STALE_MS > 0 else 15 * 60 * 1000
_ORDERS_BY_EMAIL_CACHED_WARN_COOLDOWN_MS = int(os.environ.get("WOO_ORDERS_BY_EMAIL_CACHED_WARN_COOLDOWN_MS", "60000").strip() or 60000)
_ORDERS_BY_EMAIL_CACHED_WARN_COOLDOWN_MS = max(5_000, min(_ORDERS_BY_EMAIL_CACHED_WARN_COOLDOWN_MS, 10 * 60 * 1000))


def _now_ms() -> int:
    return int(time.time() * 1000)


def _should_trip_proxy_breaker(status: Optional[int]) -> bool:
    if status is None:
        return True
    return _should_retry_status(status)


def _proxy_cooldown_seconds(cache_key: str, now_ms: int) -> int:
    state = _proxy_failures.get(cache_key)
    if not state:
        return 0
    try:
        cooldown_until = int(state.get("cooldownUntil") or 0)
    except Exception:
        cooldown_until = 0
    if cooldown_until <= now_ms:
        return 0
    return max(1, int((cooldown_until - now_ms + 999) / 1000))


def _record_proxy_failure(cache_key: str, *, status: Optional[int]) -> int:
    now_ms = _now_ms()
    with _catalog_cache_lock:
        state = dict(_proxy_failures.get(cache_key) or {})
        try:
            last_error_at = int(state.get("lastErrorAt") or 0)
        except Exception:
            last_error_at = 0
        try:
            fail_count = int(state.get("failCount") or 0)
        except Exception:
            fail_count = 0
        if last_error_at and now_ms - last_error_at >= _WOO_PROXY_FAILURE_RESET_AFTER_SECONDS * 1000:
            fail_count = 0
        fail_count += 1
        multiplier = 2 ** min(4, max(0, fail_count - 1))
        cooldown_seconds = min(
            _WOO_PROXY_FAILURE_MAX_COOLDOWN_SECONDS,
            int(_WOO_PROXY_FAILURE_COOLDOWN_SECONDS * multiplier),
        )
        state.update(
            {
                "lastErrorAt": now_ms,
                "cooldownUntil": now_ms + cooldown_seconds * 1000,
                "failCount": fail_count,
                "status": status,
            }
        )
        _proxy_failures[cache_key] = state
    return cooldown_seconds


def _clear_proxy_failure(cache_key: str) -> None:
    with _catalog_cache_lock:
        _proxy_failures.pop(cache_key, None)


def _cache_ttl_seconds_for_endpoint(endpoint: str) -> int:
    endpoint = (endpoint or "").lstrip("/")
    if endpoint == "products/categories":
        return 10 * 60
    if endpoint == "products":
        return 5 * 60
    if re.match(r"^products/[^/]+/variations$", endpoint):
        return 10 * 60
    if re.match(r"^products/[^/]+/variations/[^/]+$", endpoint):
        return 10 * 60
    if re.match(r"^products/[^/]+$", endpoint):
        return 10 * 60
    return 60


def _timeout_seconds_for_endpoint(endpoint: str) -> float:
    """
    Keep WooCommerce proxy calls bounded. Large timeouts can tie up gunicorn threads,
    causing the whole API (including /api/health and auth) to appear down.
    """
    endpoint = (endpoint or "").lstrip("/")
    # Variations can be heavy; prefer failing fast and serving cached/stale data.
    if re.match(r"^products/[^/]+/variations", endpoint):
        return float(os.environ.get("WOO_VARIATIONS_TIMEOUT_SECONDS", "8").strip() or 8)
    if endpoint.startswith("products"):
        return float(os.environ.get("WOO_PRODUCTS_TIMEOUT_SECONDS", "10").strip() or 10)
    return float(os.environ.get("WOO_DEFAULT_TIMEOUT_SECONDS", "12").strip() or 12)


def _max_attempts_for_endpoint(endpoint: str) -> int:
    endpoint = (endpoint or "").lstrip("/")
    if re.match(r"^products/[^/]+/variations", endpoint):
        return max(1, min(int(os.environ.get("WOO_VARIATIONS_MAX_ATTEMPTS", "2").strip() or 2), 4))
    return _WOO_HTTP_MAX_ATTEMPTS


def _build_cache_key(endpoint: str, params: Optional[Mapping[str, Any]]) -> str:
    cleaned = _sanitize_params(params or {})
    normalized = endpoint.lstrip("/")
    payload = {k: cleaned.get(k) for k in sorted(cleaned.keys())}
    return f"{normalized}::{json.dumps(payload, sort_keys=True, separators=(',', ':'))}"


def _disk_cache_dir():
    config = get_config()
    return str(config.data_dir / "woo-proxy-cache")


def _disk_cache_path(cache_key: str) -> str:
    digest = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()
    return os.path.join(_disk_cache_dir(), f"{digest}.json")


def _read_disk_cache(cache_key: str) -> Optional[Dict[str, Any]]:
    if not _WOO_PROXY_DISK_CACHE_ENABLED:
        return None
    try:
        path = _disk_cache_path(cache_key)
        with open(path, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
        if not isinstance(parsed, dict) or "data" not in parsed:
            return None
        return parsed
    except Exception:
        return None


def _write_disk_cache(cache_key: str, payload: Dict[str, Any]) -> None:
    if not _WOO_PROXY_DISK_CACHE_ENABLED:
        return
    try:
        os.makedirs(_disk_cache_dir(), exist_ok=True)
        path = _disk_cache_path(cache_key)
        tmp = f"{path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        logger.debug("Woo proxy disk cache write failed", exc_info=True, extra={"cacheKey": cache_key})


def _should_retry_status(status: Optional[int]) -> bool:
    if status is None:
        return False
    return status in (408, 429, 500, 502, 503, 504)


def _build_private_cache_key(prefix: str, payload: Dict[str, Any]) -> str:
    normalized_prefix = (prefix or "").strip() or "cache"
    return f"{normalized_prefix}::{json.dumps(payload, sort_keys=True, separators=(',', ':'))}"


def _fetch_catalog_http(
    endpoint: str,
    params: Optional[Mapping[str, Any]] = None,
    *,
    suppress_log: bool = False,
    acquire_timeout: float | None = None,
) -> Any:
    base_url, api_version, auth, timeout = _client_config()
    normalized = endpoint.lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/{normalized}"
    cleaned = _sanitize_params(params or {})

    semaphore_timeout = float(_WOO_HTTP_ACQUIRE_TIMEOUT_SECONDS if acquire_timeout is None else acquire_timeout)
    max_attempts = _max_attempts_for_endpoint(endpoint)
    request_timeout = min(float(timeout or 25), _timeout_seconds_for_endpoint(endpoint))
    for attempt in range(max_attempts):
        try:
            acquired = _woo_http_semaphore.acquire(timeout=semaphore_timeout)
            if not acquired:
                err = IntegrationError("WooCommerce is busy, please retry")
                setattr(err, "status", 503)
                raise err
            try:
                response = requests.get(url, params=cleaned, auth=auth, timeout=request_timeout)
            finally:
                try:
                    _woo_http_semaphore.release()
                except ValueError:
                    pass
            if response.status_code >= 400:
                if attempt < max_attempts - 1 and _should_retry_status(response.status_code):
                    raise requests.HTTPError(response=response)
                response.raise_for_status()
            try:
                return response.json()
            except ValueError:
                return response.text
        except requests.RequestException as exc:
            status = getattr(getattr(exc, "response", None), "status_code", None)
            retryable = attempt < max_attempts - 1 and _should_retry_status(status)
            if retryable:
                # Exponential backoff with a small jitter.
                delay = min(3.0, 0.6 * (2**attempt)) + (0.05 * attempt)
                time.sleep(delay)
                continue
            data = None
            if getattr(exc, "response", None) is not None:
                try:
                    data = exc.response.json()
                except Exception:
                    data = exc.response.text
            if suppress_log:
                logger.warning(
                    "WooCommerce catalog fetch failed",
                    extra={"endpoint": endpoint, "status": status},
                )
            else:
                logger.error(
                    "WooCommerce catalog fetch failed",
                    exc_info=True,
                    extra={"endpoint": endpoint, "status": status},
                )
            err = IntegrationError("WooCommerce catalog request failed", response=data)
            setattr(err, "status", status if status is not None else 502)
            raise err


def fetch_catalog_fresh(
    endpoint: str,
    params: Optional[Mapping[str, Any]] = None,
    *,
    acquire_timeout: float | None = None,
) -> tuple[Any, Dict[str, Any]]:
    """
    Fetch from WooCommerce *synchronously* (bypassing stale-while-revalidate behavior),
    while still populating the same in-memory/disk caches used by `fetch_catalog_proxy`.
    """
    if not is_configured():
        err = IntegrationError("WooCommerce is not configured")
        setattr(err, "status", 503)
        raise err

    ttl_seconds = _cache_ttl_seconds_for_endpoint(endpoint)
    cache_key = _build_cache_key(endpoint, params)

    data = _fetch_catalog_http(endpoint, params, acquire_timeout=acquire_timeout)
    _clear_proxy_failure(cache_key)

    now_ms = _now_ms()
    expires_at = now_ms + ttl_seconds * 1000

    event: threading.Event | None = None
    with _catalog_cache_lock:
        _set_in_memory_cache(cache_key, data, expires_at)
        inflight = _inflight.get(cache_key)
        if inflight:
            inflight["data"] = data
            inflight["error"] = None
            event = inflight.get("event")
            _inflight.pop(cache_key, None)

    if event is not None:
        try:
            event.set()
        except Exception:
            pass

    _write_disk_cache(cache_key, {"data": data, "fetchedAt": now_ms, "expiresAt": expires_at})
    return data, {"cache": "FRESH", "ttlSeconds": ttl_seconds, "noStore": True}


def fetch_catalog_proxy(endpoint: str, params: Optional[Mapping[str, Any]] = None) -> tuple[Any, Dict[str, Any]]:
    """
    Woo proxy endpoint fetch with:
      - in-memory cache + in-flight request dedupe
      - disk cache (optional) to survive restarts
      - stale-while-revalidate (returns stale fast, refreshes in background)

    Returns (data, meta) where meta includes:
      - cache: HIT|MISS|INFLIGHT|STALE|DISK|DISK_STALE
      - ttlSeconds
    """
    if not is_configured():
        err = IntegrationError("WooCommerce is not configured")
        setattr(err, "status", 503)
        raise err

    ttl_seconds = _cache_ttl_seconds_for_endpoint(endpoint)
    raw_params = params or {}
    force_param = str(getattr(raw_params, "get", lambda _k, _d=None: None)("force", "") or "").strip().lower()
    force_fresh = force_param in ("1", "true", "yes")
    normalized_endpoint = endpoint.lstrip("/")
    allow_stale = (
        normalized_endpoint in ("products", "products/categories")
        or re.match(r"^products/[^/]+/variations$", normalized_endpoint) is not None
        or re.match(r"^products/[^/]+/variations/[^/]+$", normalized_endpoint) is not None
        or re.match(r"^products/[^/]+$", normalized_endpoint) is not None
    )
    cache_key = _build_cache_key(endpoint, params)
    now_ms = _now_ms()
    cooldown_seconds = 0

    if force_fresh:
        with _catalog_cache_lock:
            cooldown_seconds = _proxy_cooldown_seconds(cache_key, now_ms)
            cached = _catalog_cache.get(cache_key)
            if cached and cached.get("data") is not None and allow_stale:
                if cooldown_seconds <= 0:
                    _start_background_refresh(cache_key, endpoint, params, ttl_seconds)
                return cached.get("data"), {"cache": "FORCE_STALE", "ttlSeconds": ttl_seconds, "noStore": True}
            if cooldown_seconds > 0:
                err = IntegrationError("WooCommerce temporarily unavailable, please retry shortly")
                setattr(err, "status", 503)
                raise err

        disk_cached = _read_disk_cache(cache_key)
        if allow_stale and disk_cached and isinstance(disk_cached, dict) and "data" in disk_cached:
            data = disk_cached.get("data")
            # Populate a short in-memory TTL to reduce stampedes while the refresh runs.
            expires_at = now_ms + min(ttl_seconds, 30) * 1000
            with _catalog_cache_lock:
                _set_in_memory_cache(cache_key, data, expires_at)
            _start_background_refresh(cache_key, endpoint, params, ttl_seconds)
            return data, {"cache": "FORCE_DISK_STALE", "ttlSeconds": ttl_seconds, "noStore": True}

        data = _fetch_catalog_http(endpoint, params, acquire_timeout=2)
        _clear_proxy_failure(cache_key)
        now_ms = _now_ms()
        expires_at = now_ms + ttl_seconds * 1000
        with _catalog_cache_lock:
            _set_in_memory_cache(cache_key, data, expires_at)
            _inflight.pop(cache_key, None)
        _write_disk_cache(cache_key, {"data": data, "fetchedAt": now_ms, "expiresAt": expires_at})
        return data, {"cache": "FORCE_MISS", "ttlSeconds": ttl_seconds, "noStore": True}

    with _catalog_cache_lock:
        cooldown_seconds = _proxy_cooldown_seconds(cache_key, now_ms)
        cached = _catalog_cache.get(cache_key)
        if cooldown_seconds > 0 and cached and cached.get("data") is not None:
            return (
                cached.get("data"),
                {"cache": "COOLDOWN", "ttlSeconds": ttl_seconds, "cooldownSeconds": cooldown_seconds},
            )
        if cached and cached.get("expiresAt", 0) > now_ms:
            return cached.get("data"), {"cache": "HIT", "ttlSeconds": ttl_seconds}

        inflight = _inflight.get(cache_key)
        if inflight:
            event: threading.Event = inflight["event"]
        else:
            event = None

        if inflight and event is not None:
            # Another request is already fetching this key.
            if (
                inflight.get("background") is True
                and allow_stale
                and cached
                and cached.get("expiresAt", 0) <= now_ms
                and now_ms - cached.get("expiresAt", 0) <= _WOO_PROXY_MAX_STALE_MS
            ):
                # Do not block user requests behind a background refresh: serve stale immediately.
                return cached.get("data"), {"cache": "STALE", "ttlSeconds": ttl_seconds}
        elif (
            allow_stale
            and cached
            and cached.get("expiresAt", 0) <= now_ms
            and now_ms - cached.get("expiresAt", 0) <= _WOO_PROXY_MAX_STALE_MS
        ):
            # Serve stale immediately; refresh in background (deduped).
            if cooldown_seconds <= 0:
                _start_background_refresh(cache_key, endpoint, params, ttl_seconds)
            return cached.get("data"), {"cache": "STALE", "ttlSeconds": ttl_seconds}
        elif allow_stale and cached and cached.get("expiresAt", 0) <= now_ms:
            # Last resort: serve very stale data rather than failing hard (e.g. after deploys or
            # prolonged upstream outages). A background refresh will still be attempted.
            if cooldown_seconds <= 0:
                _start_background_refresh(cache_key, endpoint, params, ttl_seconds)
            return cached.get("data"), {"cache": "VERY_STALE", "ttlSeconds": ttl_seconds}

    # If there's an in-flight fetch, wait for it (outside lock).
    if event is not None and cooldown_seconds <= 0:
        event.wait(timeout=_WOO_PROXY_INFLIGHT_WAIT_SECONDS)
        with _catalog_cache_lock:
            cached = _catalog_cache.get(cache_key)
            if cached and cached.get("expiresAt", 0) > _now_ms():
                return cached.get("data"), {"cache": "INFLIGHT", "ttlSeconds": ttl_seconds}
            inflight = _inflight.get(cache_key)
            if inflight and inflight.get("error") is not None:
                raise inflight.get("error")
            if inflight and inflight.get("data") is not None:
                return inflight.get("data"), {"cache": "INFLIGHT", "ttlSeconds": ttl_seconds}

    # Disk cache (outside lock).
    disk_cached = _read_disk_cache(cache_key)
    if (
        disk_cached
        and isinstance(disk_cached, dict)
        and isinstance(disk_cached.get("fetchedAt"), int)
        and isinstance(disk_cached.get("expiresAt"), int)
        and now_ms - int(disk_cached.get("fetchedAt")) <= _WOO_PROXY_MAX_STALE_MS
    ):
        data = disk_cached.get("data")
        expires_at = int(disk_cached.get("expiresAt"))
        if allow_stale or expires_at > now_ms:
            with _catalog_cache_lock:
                _set_in_memory_cache(cache_key, data, expires_at)
            if expires_at > now_ms:
                return data, {"cache": "DISK", "ttlSeconds": ttl_seconds}
            # Serve stale from disk and refresh (deduped).
            if cooldown_seconds <= 0:
                _start_background_refresh(cache_key, endpoint, params, ttl_seconds)
            return data, {"cache": "DISK_STALE", "ttlSeconds": ttl_seconds}
    elif allow_stale and disk_cached and isinstance(disk_cached, dict) and "data" in disk_cached:
        # Serve whatever we have on disk (even if older than max stale) and refresh in background.
        data = disk_cached.get("data")
        try:
            fetched_at = int(disk_cached.get("fetchedAt") or 0)
        except Exception:
            fetched_at = 0
        # Keep a short in-memory TTL to avoid stampedes while refresh is attempted.
        expires_at = now_ms + min(ttl_seconds, 30) * 1000
        with _catalog_cache_lock:
            _set_in_memory_cache(cache_key, data, expires_at)
        if cooldown_seconds <= 0:
            _start_background_refresh(cache_key, endpoint, params, ttl_seconds)
        meta: Dict[str, Any] = {"cache": "DISK_VERY_STALE", "ttlSeconds": ttl_seconds}
        if fetched_at > 0:
            meta["staleMs"] = max(0, now_ms - fetched_at)
        return data, meta

    if cooldown_seconds > 0:
        err = IntegrationError("WooCommerce temporarily unavailable, please retry shortly")
        setattr(err, "status", 503)
        raise err

    # No cache available: synchronous fetch with in-flight dedupe.
    with _catalog_cache_lock:
        inflight = _inflight.get(cache_key)
        if inflight:
            event = inflight["event"]
            is_leader = False
        else:
            event = threading.Event()
            _inflight[cache_key] = {"event": event, "data": None, "error": None}
            inflight = _inflight[cache_key]
            inflight["leader"] = True
            is_leader = True

    if is_leader:
        try:
            data = _fetch_catalog_http(endpoint, params)
            _clear_proxy_failure(cache_key)
            now_ms = _now_ms()
            expires_at = now_ms + ttl_seconds * 1000
            with _catalog_cache_lock:
                _set_in_memory_cache(cache_key, data, expires_at)
                inflight = _inflight.get(cache_key)
                if inflight:
                    inflight["data"] = data
                    inflight["error"] = None
                    inflight["event"].set()
                    _inflight.pop(cache_key, None)
            _write_disk_cache(cache_key, {"data": data, "fetchedAt": now_ms, "expiresAt": expires_at})
            return data, {"cache": "MISS", "ttlSeconds": ttl_seconds}
        except Exception as exc:
            status = getattr(exc, "status", None)
            if _should_trip_proxy_breaker(status):
                _record_proxy_failure(cache_key, status=status)
            with _catalog_cache_lock:
                inflight = _inflight.get(cache_key)
                if inflight:
                    inflight["error"] = exc
                    inflight["event"].set()
                    _inflight.pop(cache_key, None)
            raise

    # Follower: wait for leader.
    event.wait(timeout=_WOO_PROXY_INFLIGHT_WAIT_SECONDS)
    with _catalog_cache_lock:
        cached = _catalog_cache.get(cache_key)
        if cached and cached.get("expiresAt", 0) > _now_ms():
            return cached.get("data"), {"cache": "INFLIGHT", "ttlSeconds": ttl_seconds}
        inflight = _inflight.get(cache_key)
        if inflight and inflight.get("error") is not None:
            raise inflight.get("error")
        if inflight and inflight.get("data") is not None:
            return inflight.get("data"), {"cache": "INFLIGHT", "ttlSeconds": ttl_seconds}

    # If leader timed out or cleared, fall back to direct fetch.
    now_ms = _now_ms()
    cooldown_seconds = _proxy_cooldown_seconds(cache_key, now_ms)
    if cooldown_seconds > 0:
        err = IntegrationError("WooCommerce temporarily unavailable, please retry shortly")
        setattr(err, "status", 503)
        raise err
    data = _fetch_catalog_http(endpoint, params)
    _clear_proxy_failure(cache_key)
    now_ms = _now_ms()
    expires_at = now_ms + ttl_seconds * 1000
    with _catalog_cache_lock:
        _set_in_memory_cache(cache_key, data, expires_at)
    _write_disk_cache(cache_key, {"data": data, "fetchedAt": now_ms, "expiresAt": expires_at})
    return data, {"cache": "MISS", "ttlSeconds": ttl_seconds}


def _set_in_memory_cache(cache_key: str, data: Any, expires_at_ms: int) -> None:
    if len(_catalog_cache) >= _MAX_IN_MEMORY_CACHE_KEYS:
        _catalog_cache.clear()
    _catalog_cache[cache_key] = {"data": data, "expiresAt": expires_at_ms}


def _start_background_refresh(cache_key: str, endpoint: str, params: Optional[Mapping[str, Any]], ttl_seconds: int) -> None:
    with _catalog_cache_lock:
        if cache_key in _inflight:
            return
        if not _background_refresh_semaphore.acquire(blocking=False):
            return
        event = threading.Event()
        _inflight[cache_key] = {"event": event, "data": None, "error": None, "leader": True, "background": True}
    threading.Thread(
        target=_refresh_proxy_cache,
        args=(cache_key, endpoint, params, ttl_seconds),
        daemon=True,
    ).start()


def _refresh_proxy_cache(cache_key: str, endpoint: str, params: Optional[Mapping[str, Any]], ttl_seconds: int) -> None:
    try:
        now_ms = _now_ms()
        with _catalog_cache_lock:
            cooldown_seconds = _proxy_cooldown_seconds(cache_key, now_ms)
            if cooldown_seconds > 0:
                inflight = _inflight.get(cache_key)
                if inflight:
                    inflight["event"].set()
                    _inflight.pop(cache_key, None)
                return
        data = _fetch_catalog_http(endpoint, params, suppress_log=True)
        _clear_proxy_failure(cache_key)
        now_ms = _now_ms()
        expires_at = now_ms + ttl_seconds * 1000
        with _catalog_cache_lock:
            _set_in_memory_cache(cache_key, data, expires_at)
            inflight = _inflight.get(cache_key)
            if inflight:
                inflight["data"] = data
                inflight["error"] = None
                inflight["event"].set()
                _inflight.pop(cache_key, None)
        _write_disk_cache(cache_key, {"data": data, "fetchedAt": now_ms, "expiresAt": expires_at})
    except Exception as exc:
        status = getattr(exc, "status", None)
        cooldown_seconds = 0
        if _should_trip_proxy_breaker(status):
            cooldown_seconds = _record_proxy_failure(cache_key, status=status)
        if isinstance(exc, IntegrationError) and _should_trip_proxy_breaker(status):
            logger.warning(
                "Woo proxy background refresh failed",
                extra={"endpoint": endpoint, "status": status, "cooldownSeconds": cooldown_seconds},
            )
        else:
            logger.warning("Woo proxy background refresh failed", exc_info=True, extra={"endpoint": endpoint})
        with _catalog_cache_lock:
            inflight = _inflight.get(cache_key)
            if inflight:
                inflight["error"] = None
                inflight["event"].set()
                _inflight.pop(cache_key, None)
    finally:
        try:
            _background_refresh_semaphore.release()
        except ValueError:
            # Defensive: should not happen, but avoid crashing background thread.
            pass


class IntegrationError(RuntimeError):
    def __init__(self, message: str, response: Optional[Dict] = None):
        super().__init__(message)
        self.response = response


def _strip(s: Optional[str]) -> str:
    return (s or "").strip()


def is_configured() -> bool:
    config = get_config()
    data = config.woo_commerce
    store = _strip(data.get("store_url"))
    ck = _strip(data.get("consumer_key"))
    cs = _strip(data.get("consumer_secret"))
    return bool(store and ck and cs)


def _client_config():
    config = get_config()
    data = config.woo_commerce
    base_url = _strip(data.get("store_url")).rstrip("/")
    api_version = _strip(data.get("api_version") or "wc/v3").lstrip("/")
    auth = HTTPBasicAuth(_strip(data.get("consumer_key")), _strip(data.get("consumer_secret")))
    timeout = data.get("request_timeout_seconds") or 25
    return base_url, api_version, auth, timeout


def _parse_woo_id(raw):
    if raw is None:
        return None
    try:
        # Accept formats like "woo-392" or "392"
        s = str(raw)
        if s.startswith("woo-"):
            s = s.split("-", 1)[1]
        return int(s)
    except Exception:
        return None


def _normalize_woo_order_id(value: Optional[object]) -> Optional[str]:
    """
    Best-effort normalization of Woo order identifiers (id/number).
    Accepts formats like "woo-392", "#392", "Order #392", or plain ints.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.isdigit():
        return text
    match = re.search(r"(\d+)", text)
    if match:
        return match.group(1)
    return text


def build_line_items(items, tax_total: float = 0.0, tax_rate_id: Optional[int] = None):
    """
    Build WooCommerce line_items.

    If `tax_total` is provided, allocate it across line items (proportional to their totals) so
    WooCommerce emails show a non-zero tax total (and can optionally itemize by label).
    """
    prepared = []
    for item in items or []:
        quantity = int(item.get("quantity", 0) or 0)
        price = float(item.get("price", 0))
        line_total_value = max(price * quantity, 0.0)
        total = f"{line_total_value:.2f}"
        product_id = _parse_woo_id(item.get("productId"))
        variation_id = _parse_woo_id(item.get("variantId"))
        resolved_sku = item.get("sku") or item.get("productId") or item.get("variantSku")
        if resolved_sku is not None and not isinstance(resolved_sku, str):
            try:
                resolved_sku = str(resolved_sku)
            except Exception:
                resolved_sku = None
        if resolved_sku:
            resolved_sku = resolved_sku.strip()
        prepared.append(
            {
                "name": item.get("name"),
                "sku": resolved_sku or None,
                "quantity": quantity,
                "product_id": product_id,
                "variation_id": variation_id,
                "price": f"{price:.2f}",
                "total": total,
                "subtotal": total,
                "meta_data": [{"key": "note", "value": item.get("note")}] if item.get("note") else [],
                "_line_total_value": line_total_value,
            }
        )

    tax_total = float(tax_total or 0)
    tax_total = max(tax_total, 0.0)
    base_total = sum(line.get("_line_total_value", 0.0) for line in prepared) or 0.0

    include_tax_fields = tax_total > 0 and tax_rate_id is not None and base_total > 0
    remaining_tax = round(tax_total, 2)
    for idx, line in enumerate(prepared):
        line_value = float(line.get("_line_total_value") or 0.0)
        if not include_tax_fields or line_value <= 0:
            allocated = 0.0
        elif idx == len(prepared) - 1:
            allocated = remaining_tax
        else:
            allocated = round(tax_total * (line_value / base_total), 2)
            remaining_tax = round(remaining_tax - allocated, 2)

        allocated = max(allocated, 0.0)
        if include_tax_fields:
            line["total_tax"] = f"{allocated:.2f}"
            line["subtotal_tax"] = f"{allocated:.2f}"
            line["taxes"] = [
                {"id": int(tax_rate_id), "total": f"{allocated:.2f}", "subtotal": f"{allocated:.2f}"}
            ]

        # Drop helper fields and omit variation_id when not set.
        line.pop("_line_total_value", None)
        if line.get("variation_id") is None:
            line.pop("variation_id", None)

    return prepared


_PEPPRO_MANUAL_TAX_RATE_NAME = "PepPro Manual Tax"
_peppro_manual_tax_rate_id: Optional[int] = None
_peppro_manual_tax_rate_lock = threading.Lock()


def _ensure_peppro_manual_tax_rate_id() -> Optional[int]:
    """
    WooCommerce taxes must reference an existing tax rate id to register totals that surface in
    admin + emails. We create (once) a 0% "PepPro Manual Tax" rate and then attach explicit tax
    amounts to the order/line items.
    """
    global _peppro_manual_tax_rate_id

    if _peppro_manual_tax_rate_id is not None:
        return _peppro_manual_tax_rate_id
    if not is_configured():
        return None

    with _peppro_manual_tax_rate_lock:
        if _peppro_manual_tax_rate_id is not None:
            return _peppro_manual_tax_rate_id

        try:
            existing = fetch_catalog(
                "taxes",
                {"per_page": 100, "search": _PEPPRO_MANUAL_TAX_RATE_NAME},
            )
            if isinstance(existing, list):
                for rate in existing:
                    if str((rate or {}).get("name") or "").strip().lower() != _PEPPRO_MANUAL_TAX_RATE_NAME.lower():
                        continue
                    rate_id = _parse_woo_id((rate or {}).get("id"))
                    if rate_id:
                        _peppro_manual_tax_rate_id = rate_id
                        return rate_id
        except Exception:
            logger.debug("Woo manual tax rate lookup failed", exc_info=True)

        try:
            base_url, api_version, auth, timeout = _client_config()
            url = f"{base_url}/wp-json/{api_version}/taxes"
            payload = {
                "country": "US",
                "state": "",
                "postcode": "",
                "city": "",
                "rate": "0.0000",
                "name": _PEPPRO_MANUAL_TAX_RATE_NAME,
                "priority": 1,
                "compound": False,
                "shipping": False,
                "order": 0,
                "class": "standard",
            }

            acquired = _woo_http_semaphore.acquire(timeout=25)
            if not acquired:
                err = IntegrationError("WooCommerce is busy, please retry")
                setattr(err, "status", 503)
                raise err
            try:
                response = requests.post(url, json=payload, auth=auth, timeout=timeout)
            finally:
                try:
                    _woo_http_semaphore.release()
                except ValueError:
                    pass
            response.raise_for_status()
            data = None
            try:
                data = response.json()
            except ValueError:
                data = None
            rate_id = _parse_woo_id((data or {}).get("id"))
            if rate_id:
                _peppro_manual_tax_rate_id = rate_id
                return rate_id
        except Exception:
            logger.warning("Woo manual tax rate creation failed", exc_info=True)
            return None

    return None


def build_order_payload(order: Dict, customer: Dict) -> Dict:
    test_override = bool((order.get("testPaymentOverride") or {}).get("enabled"))
    override_amount = 0.0
    if test_override:
        try:
            override_amount = float((order.get("testPaymentOverride") or {}).get("amount") or 0.01)
        except Exception:
            override_amount = 0.01
        override_amount = max(0.01, round(override_amount, 2))

    # Discounts (referral credits + discount codes) are tracked in PepPro + stored as Woo meta fields.
    # Do not send Woo "discount lines"/negative fees; instead, reduce line item totals so Woo total matches.
    applied_credit = float(order.get("appliedReferralCredit") or 0) or 0.0
    discount_code_amount = float(order.get("discountCodeAmount") or 0) or 0.0
    combined_discount = float(applied_credit) + float(discount_code_amount)
    fee_lines = []
    discount_total = "0"

    def _apply_discount_to_items(items: List[Dict[str, Any]], amount: float) -> List[Dict[str, Any]]:
        safe_amount = float(amount or 0.0)
        if safe_amount <= 0:
            return list(items or [])
        safe_amount = round(max(0.0, safe_amount), 2)

        prepared: List[Dict[str, Any]] = []
        line_totals: List[float] = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            try:
                qty = float(item.get("quantity") or 0) or 0.0
                unit = float(item.get("price") or 0) or 0.0
            except Exception:
                qty = 0.0
                unit = 0.0
            qty = max(0.0, qty)
            unit = max(0.0, unit)
            total = round(unit * qty, 2)
            prepared.append(dict(item))
            line_totals.append(total)

        base_total = round(sum(line_totals), 2)
        if base_total <= 0:
            return prepared

        remaining = min(safe_amount, base_total)
        discounted: List[Dict[str, Any]] = []
        for idx, item in enumerate(prepared):
            try:
                qty = float(item.get("quantity") or 0) or 0.0
            except Exception:
                qty = 0.0
            qty = max(0.0, qty)
            original_line_total = float(line_totals[idx] or 0.0)
            if remaining <= 0 or original_line_total <= 0 or qty <= 0:
                discounted.append(item)
                continue

            if idx == len(prepared) - 1:
                allocated = remaining
            else:
                allocated = round(remaining * (original_line_total / base_total), 2)
                allocated = min(allocated, remaining)
            remaining = round(remaining - allocated, 2)

            new_line_total = round(max(0.0, original_line_total - allocated), 2)
            new_unit_price = round(new_line_total / qty, 2) if qty > 0 else 0.0
            item["price"] = float(new_unit_price)
            discounted.append(item)

        return discounted

    tax_total = 0.0
    try:
        tax_total = float(order.get("taxTotal") or 0) or 0.0
    except Exception:
        tax_total = 0.0
    tax_total = max(0.0, tax_total)
    tax_rate_id = _ensure_peppro_manual_tax_rate_id() if tax_total > 0 else None
    # Prefer representing tax as a true Woo tax total (tax fields on line_items). Only fall back
    # to the legacy fee-line approach when we cannot resolve a manual tax rate id.
    if tax_total > 0 and tax_rate_id is None:
        fee_lines.append(
            {"name": "Estimated tax", "total": f"{tax_total:.2f}", "tax_status": "none"}
        )

    shipping_total = float(order.get("shippingTotal") or 0) or 0.0
    shipping_lines = []
    shipping_estimate = order.get("shippingEstimate") or {}
    sales_rep_id = (
        order.get("doctorSalesRepId")
        or order.get("salesRepId")
        or customer.get("salesRepId")
        or customer.get("sales_rep_id")
    )
    sales_rep_name = order.get("doctorSalesRepName") or order.get("salesRepName")
    sales_rep_email = order.get("doctorSalesRepEmail") or order.get("salesRepEmail")
    sales_rep_code = order.get("doctorSalesRepCode") or order.get("salesRepCode")
    method_code = shipping_estimate.get("serviceCode") or shipping_estimate.get("serviceType") or "flat_rate"
    method_title = shipping_estimate.get("serviceType") or shipping_estimate.get("serviceCode") or "Shipping"
    shipping_lines.append(
        {
            "method_id": method_code,
            "method_title": method_title,
            "total": f"{shipping_total:.2f}",
        }
    )

    order_total = 0.0
    try:
        order_total = float(order.get("grandTotal") or 0) or 0.0
    except Exception:
        order_total = 0.0
    if order_total <= 0:
        try:
            items_total = float(order.get("total") or 0) or 0.0
        except Exception:
            items_total = 0.0
        order_total = max(0.0, items_total - applied_credit + shipping_total + tax_total)

    address = order.get("shippingAddress") or {}
    billing_address = {
        "first_name": customer.get("name") or "PepPro",
        "last_name": "",
        "email": customer.get("email") or "orders@peppro.example",
        "address_1": address.get("addressLine1") or "",
        "address_2": address.get("addressLine2") or "",
        "city": address.get("city") or "",
        "state": address.get("state") or "",
        "postcode": address.get("postalCode") or "",
        "country": address.get("country") or "US",
        "phone": address.get("phone") or "",
    }
    shipping_address = {
        "first_name": address.get("name") or customer.get("name") or "PepPro",
        "last_name": "",
        "address_1": address.get("addressLine1") or "",
        "address_2": address.get("addressLine2") or "",
        "city": address.get("city") or "",
        "state": address.get("state") or "",
        "postcode": address.get("postalCode") or "",
        "country": address.get("country") or "US",
        "phone": address.get("phone") or "",
    }

    meta_data = [
        {"key": "peppro_order_id", "value": order.get("id")},
        {"key": "peppro_total", "value": order.get("total")},
        {"key": "peppro_tax_total", "value": tax_total},
        {"key": "peppro_manual_tax_rate_id", "value": int(tax_rate_id or 0)},
        {"key": "peppro_grand_total", "value": order.get("grandTotal")},
        {"key": "peppro_created_at", "value": order.get("createdAt")},
        {"key": "peppro_shipping_total", "value": shipping_total},
        {"key": "peppro_shipping_service", "value": shipping_estimate.get("serviceType") or shipping_estimate.get("serviceCode")},
        {"key": "peppro_shipping_carrier", "value": shipping_estimate.get("carrierId")},
        {"key": "peppro_physician_certified", "value": order.get("physicianCertificationAccepted")},
    ]
    if order.get("discountCode"):
        meta_data.append({"key": "peppro_discount_code", "value": order.get("discountCode")})
    if order.get("discountCodeAmount"):
        meta_data.append({"key": "peppro_discount_code_amount", "value": order.get("discountCodeAmount")})
    if sales_rep_id:
        meta_data.append({"key": "peppro_sales_rep_id", "value": sales_rep_id})
    if sales_rep_name:
        meta_data.append({"key": "peppro_sales_rep_name", "value": sales_rep_name})
    if sales_rep_email:
        meta_data.append({"key": "peppro_sales_rep_email", "value": sales_rep_email})
    if sales_rep_code:
        meta_data.append({"key": "peppro_sales_rep_code", "value": sales_rep_code})

    payment_method = str(order.get("paymentMethod") or "").strip().lower()
    if payment_method in ("bacs", "bank", "bank_transfer", "direct_bank_transfer"):
        payment_method = "bacs"
    else:
        payment_method = ""

    raw_payment_details = str(order.get("paymentDetails") or "").strip()
    raw_payment_method = str(order.get("paymentMethod") or "").strip()
    if raw_payment_details:
        meta_data.append({"key": "peppro_payment_method", "value": raw_payment_details})
    elif raw_payment_method:
        meta_data.append({"key": "peppro_payment_method", "value": raw_payment_method})

    status = "on-hold" if payment_method == "bacs" else "pending"
    line_items_source = order.get("items")
    if test_override:
        line_items_source = [{**item, "price": 0.0} for item in (order.get("items") or []) if isinstance(item, dict)]
        fee_lines.append({"name": "Test payment override", "total": f"{override_amount:.2f}", "tax_status": "none"})
    elif combined_discount > 0:
        line_items_source = _apply_discount_to_items(
            [item for item in (order.get("items") or []) if isinstance(item, dict)],
            combined_discount,
        )

    payload = {
        "status": status,
        "customer_note": f"Referral code used: {order.get('referralCode')}" if order.get("referralCode") else "",
        "set_paid": False,
        "line_items": build_line_items(line_items_source, tax_total=(0.0 if test_override else tax_total), tax_rate_id=tax_rate_id),
        "fee_lines": fee_lines,
        "shipping_lines": shipping_lines,
        "discount_total": discount_total,
        "meta_data": meta_data,
        "billing": billing_address,
        "shipping": shipping_address,
    }
    if order_total > 0:
        payload["total"] = f"{order_total:.2f}"
    if tax_total > 0 and tax_rate_id is not None:
        payload["cart_tax"] = f"{tax_total:.2f}"
        payload["shipping_tax"] = "0.00"
        payload["total_tax"] = f"{tax_total:.2f}"
        payload["tax_lines"] = [
            {
                "rate_id": int(tax_rate_id),
                "label": _PEPPRO_MANUAL_TAX_RATE_NAME,
                "compound": False,
                "tax_total": f"{tax_total:.2f}",
                "shipping_tax_total": "0.00",
            }
        ]
    if payment_method == "bacs":
        payload["payment_method"] = "bacs"
        normalized_details = (raw_payment_details or raw_payment_method).lower().replace("-", "_").replace(" ", "_")
        payload["payment_method_title"] = "Zelle" if "zelle" in normalized_details else "Direct Bank Transfer"
    return payload


def forward_order(order: Dict, customer: Dict) -> Dict:
    payload = build_order_payload(order, customer)
    config = get_config()

    if not is_configured():
        return {"status": "skipped", "reason": "not_configured", "payload": payload}

    if not config.woo_commerce.get("auto_submit_orders"):
        draft_id = str(uuid4())
        logger.info("WooCommerce auto-submit disabled; draft generated", extra={"draftId": draft_id, "orderId": order.get("id")})
        return {"status": "pending", "reason": "auto_submit_disabled", "payload": payload, "draftId": draft_id}

    base_url = _strip(config.woo_commerce.get("store_url", "")).rstrip("/")
    api_version = _strip(config.woo_commerce.get("api_version", "wc/v3")).lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders"
    timeout_seconds = int(config.woo_commerce.get("request_timeout_seconds") or 25)
    timeout_seconds = max(5, min(timeout_seconds, 90))

    try:
        response = requests.post(
            url,
            json=payload,
            auth=HTTPBasicAuth(
                _strip(config.woo_commerce.get("consumer_key")),
                _strip(config.woo_commerce.get("consumer_secret")),
            ),
            timeout=timeout_seconds,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        data = None
        response_text = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:  # pragma: no cover - best effort
                data = exc.response.text
            try:
                response_text = exc.response.text
            except Exception:
                response_text = None
        status_code = getattr(exc.response, "status_code", None)
        # Emit a verbose log line so cPanel / Passenger logs show the payload and Woo response.
        logger.error(
            "Failed to create WooCommerce order | orderId=%s status=%s woo_response_json=%s woo_response_text=%s woo_payload=%s",
            order.get("id"),
            status_code,
            data,
            response_text,
            payload,
            exc_info=True,
        )
        # Also log a plain string without structured placeholders in case the host logging formatter drops extras.
        try:
            logger.error(
                "WooCommerce 400 detail: status=%s json=%s text=%s payload=%s",
                status_code,
                data,
                response_text,
                payload,
            )
        except Exception:
            pass
        # And force a stdout/stderr line to survive any logging config quirks on cPanel/Passenger.
        try:
            print(
                f"WOO_COMMERCE_ERROR status={status_code} type={type(exc).__name__} message={exc} json={data} text={response_text} payload={payload}",
                flush=True,
            )
        except Exception:
            pass
        raise IntegrationError("WooCommerce order creation failed", response=data or response_text) from exc

    body = response.json()
    # Attempt to derive a payment URL that will present WooCommerce checkout
    payment_url = body.get("payment_url")
    try:
        # Fallback: construct order-pay URL
        if not payment_url:
            order_id = body.get("id")
            order_key = body.get("order_key") or body.get("key")
            payment_url = f"{base_url}/checkout/order-pay/{order_id}/?pay_for_order=true"
            if order_key:
                payment_url += f"&key={order_key}"
    except Exception:
        payment_url = None
    number = body.get("number") or body.get("id")
    return {
        "status": "success",
        "payload": payload,
        "response": {
            "id": body.get("id"),
            "number": number,
            "status": body.get("status"),
            "paymentUrl": payment_url,
            "orderKey": body.get("order_key") or body.get("key"),
            "payForOrderUrl": payment_url,
        },
    }


def mark_order_paid(details: Dict[str, Any]) -> Dict[str, Any]:
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured"}
    woo_order_id = details.get("woo_order_id") or details.get("wooOrderId") or details.get("id")
    if not woo_order_id:
        return {"status": "skipped", "reason": "missing_woo_order_id"}
    base_url = _strip(get_config().woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(get_config().woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders/{woo_order_id}"
    meta = []
    if details.get("payment_intent_id"):
        meta.append({"key": "stripe_payment_intent", "value": details.get("payment_intent_id")})
    if details.get("order_key"):
        meta.append({"key": "order_key", "value": details.get("order_key")})
    if details.get("card_last4"):
        meta.append({"key": "peppro_card_last4", "value": details.get("card_last4")})
    if details.get("card_brand"):
        meta.append({"key": "peppro_card_brand", "value": details.get("card_brand")})
    timeout_seconds = get_config().woo_commerce.get("request_timeout_seconds") or 25
    now_iso = datetime.utcnow().isoformat()
    card_last4 = str(details.get("card_last4") or "").strip()
    card_brand = str(details.get("card_brand") or "").strip()
    if card_last4:
        payment_method_title = f"{card_brand or 'Card'} •••• {card_last4}"
    else:
        payment_method_title = "Card payment"
    try:
        response = requests.put(
            url,
            json={
                "status": "processing",
                "set_paid": True,
                "payment_method": "stripe",
                "payment_method_title": payment_method_title,
                # Explicitly set paid date to help Woo → ShipStation exports.
                "date_paid": now_iso,
                "date_paid_gmt": now_iso,
                "meta_data": meta,
            },
            auth=HTTPBasicAuth(
                _strip(get_config().woo_commerce.get("consumer_key")),
                _strip(get_config().woo_commerce.get("consumer_secret")),
            ),
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json()
        return {"status": "success", "response": {"id": body.get("id"), "status": body.get("status")}}
    except requests.RequestException as exc:
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.error("Failed to mark Woo order paid", exc_info=True, extra={"wooOrderId": woo_order_id})
        raise IntegrationError("Failed to mark Woo order paid", response=data) from exc


def update_order_metadata(details: Dict[str, Any]) -> Dict[str, Any]:
    """
    Update WooCommerce order fields/meta without marking it as paid.

    Useful for attaching `stripe_payment_intent`, `order_key`, or other PepPro metadata
    immediately after order creation (even before payment succeeds).
    """
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured"}
    woo_order_id = details.get("woo_order_id") or details.get("wooOrderId") or details.get("id")
    if not woo_order_id:
        return {"status": "skipped", "reason": "missing_woo_order_id"}
    base_url = _strip(get_config().woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(get_config().woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders/{woo_order_id}"

    meta: list[dict] = []
    if details.get("payment_intent_id"):
        meta.append({"key": "stripe_payment_intent", "value": details.get("payment_intent_id")})
        meta.append({"key": "peppro_payment_intent", "value": details.get("payment_intent_id")})
    if details.get("order_key"):
        meta.append({"key": "order_key", "value": details.get("order_key")})
    if details.get("peppro_order_id"):
        meta.append({"key": "peppro_order_id", "value": details.get("peppro_order_id")})
    if details.get("stripe_mode"):
        meta.append({"key": "peppro_stripe_mode", "value": details.get("stripe_mode")})
    if details.get("sales_rep_id"):
        meta.append({"key": "peppro_sales_rep_id", "value": details.get("sales_rep_id")})
    if details.get("sales_rep_name"):
        meta.append({"key": "peppro_sales_rep_name", "value": details.get("sales_rep_name")})
    if details.get("sales_rep_email"):
        meta.append({"key": "peppro_sales_rep_email", "value": details.get("sales_rep_email")})
    if details.get("sales_rep_code"):
        meta.append({"key": "peppro_sales_rep_code", "value": details.get("sales_rep_code")})
    if details.get("refunded") is not None:
        meta.append({"key": "peppro_refunded", "value": "true" if details.get("refunded") else "false"})
    if details.get("stripe_refund_id"):
        meta.append({"key": "peppro_stripe_refund_id", "value": details.get("stripe_refund_id")})
    if details.get("refund_amount") is not None:
        meta.append({"key": "peppro_refund_amount", "value": details.get("refund_amount")})
    if details.get("refund_currency"):
        meta.append({"key": "peppro_refund_currency", "value": details.get("refund_currency")})
    if details.get("refund_created_at"):
        meta.append({"key": "peppro_refund_created_at", "value": details.get("refund_created_at")})

    payload: Dict[str, Any] = {"meta_data": meta}
    if details.get("payment_method"):
        payload["payment_method"] = details.get("payment_method")
    if details.get("payment_method_title"):
        payload["payment_method_title"] = details.get("payment_method_title")

    timeout_seconds = get_config().woo_commerce.get("request_timeout_seconds") or 25
    try:
        response = requests.put(
            url,
            json=payload,
            auth=HTTPBasicAuth(
                _strip(get_config().woo_commerce.get("consumer_key")),
                _strip(get_config().woo_commerce.get("consumer_secret")),
            ),
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json()
        return {
            "status": "success",
            "response": {"id": body.get("id"), "status": body.get("status")},
            "meta": meta,
        }
    except requests.RequestException as exc:
        data = None
        status_code = getattr(exc.response, "status_code", None)
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.error(
            "Failed to update Woo order metadata",
            exc_info=True,
            extra={"wooOrderId": woo_order_id, "status": status_code},
        )
        try:
            print(
                f"WOO_COMMERCE_META_UPDATE_ERROR woo_order_id={woo_order_id} status={status_code} response={data} payload={payload}",
                flush=True,
            )
        except Exception:
            pass
        raise IntegrationError("Failed to update Woo order metadata", response=data) from exc


def cancel_order(woo_order_id: str, reason: str = "", status_override: Optional[str] = None) -> Dict[str, Any]:
    """
    Cancel a WooCommerce order. Returns a status payload; does not raise on 404.
    """
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured"}
    if not woo_order_id:
        return {"status": "skipped", "reason": "missing_woo_order_id"}

    base_url = _strip(get_config().woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(get_config().woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders/{woo_order_id}"
    next_status = (status_override or "cancelled").strip() or "cancelled"
    timeout_seconds = get_config().woo_commerce.get("request_timeout_seconds") or 25

    try:
        response = requests.put(
            url,
            json={
                "status": next_status,
                "set_paid": False,
                "customer_note": reason or "Order cancelled (payment failed)",
            },
            auth=HTTPBasicAuth(
                _strip(get_config().woo_commerce.get("consumer_key")),
                _strip(get_config().woo_commerce.get("consumer_secret")),
            ),
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json()
        return {"status": "success", "response": {"id": body.get("id"), "status": body.get("status")}}
    except requests.RequestException as exc:
        data = None
        status_code = getattr(exc.response, "status_code", None)
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        # Return graceful result for 404 so frontend can proceed.
        if status_code == 404:
            logger.warn("Woo order not found while cancelling", extra={"wooOrderId": woo_order_id})
            return {"status": "not_found", "wooOrderId": woo_order_id}
        logger.error("Failed to cancel Woo order", exc_info=True, extra={"wooOrderId": woo_order_id})
        raise IntegrationError("Failed to cancel Woo order", response=data) from exc


def create_refund(
    woo_order_id: str,
    amount: float,
    reason: str = "",
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Create a WooCommerce refund record for an order.

    This does NOT trigger the payment gateway refund (we already refunded in Stripe);
    it records the refund in Woo so the order reflects the refund state.
    """
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured"}
    if not woo_order_id:
        return {"status": "skipped", "reason": "missing_woo_order_id"}
    try:
        amount_value = float(amount or 0)
    except Exception:
        amount_value = 0.0
    if amount_value <= 0:
        return {"status": "skipped", "reason": "invalid_amount"}

    base_url = _strip(get_config().woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(get_config().woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders/{woo_order_id}/refunds"
    timeout_seconds = get_config().woo_commerce.get("request_timeout_seconds") or 25

    payload: Dict[str, Any] = {
        "amount": f"{amount_value:.2f}",
        "reason": reason or "Refunded via PepPro",
        "api_refund": False,
    }
    if isinstance(metadata, dict) and metadata:
        payload["meta_data"] = [{"key": k, "value": v} for k, v in metadata.items() if k]

    try:
        response = requests.post(
            url,
            json=payload,
            auth=HTTPBasicAuth(
                _strip(get_config().woo_commerce.get("consumer_key")),
                _strip(get_config().woo_commerce.get("consumer_secret")),
            ),
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json()
        return {
            "status": "success",
            "response": {
                "id": body.get("id"),
                "amount": body.get("amount"),
                "reason": body.get("reason"),
            },
        }
    except requests.RequestException as exc:
        data = None
        status_code = getattr(exc.response, "status_code", None)
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        if status_code == 404:
            logger.warning("Woo order not found while creating refund", extra={"wooOrderId": woo_order_id})
            return {"status": "not_found", "wooOrderId": woo_order_id}
        logger.error(
            "Failed to create WooCommerce refund",
            exc_info=True,
            extra={"wooOrderId": woo_order_id, "status": status_code},
        )
        try:
            print(
                f"WOO_COMMERCE_REFUND_ERROR woo_order_id={woo_order_id} status={status_code} response={data} payload={payload}",
                flush=True,
            )
        except Exception:
            pass
        raise IntegrationError("Failed to create WooCommerce refund", response=data) from exc


# ---- Catalog proxy helpers -------------------------------------------------

_ALLOWED_QUERY_KEYS = {
    "per_page",
    "page",
    "search",
    "status",
    "orderby",
    "order",
    "slug",
    "sku",
    "category",
    "tag",
    "type",
    "featured",
    "stock_status",
    "min_price",
    "max_price",
    "before",
    "after",
}


def _sanitize_query_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        try:
            return str(int(value)) if float(value).is_integer() else str(float(value))
        except Exception:
            return None
    s = str(value).strip()
    return s or None


def _sanitize_params(params: Optional[Mapping[str, Any]]) -> Dict[str, str]:
    if not params:
        return {}
    cleaned: Dict[str, str] = {}
    for key, raw in params.items():
        if key not in _ALLOWED_QUERY_KEYS:
            continue
        val = _sanitize_query_value(raw)
        if val is not None:
            cleaned[key] = val
    return cleaned


def fetch_catalog(endpoint: str, params: Optional[Mapping[str, Any]] = None) -> Any:
    """Fetch Woo catalog resources via server-side credentials.

    endpoint examples:
      - "products"
      - "products/categories"
    """
    if not is_configured():
        err = IntegrationError("WooCommerce is not configured")
        setattr(err, "status", 503)
        raise err

    config = get_config()
    base_url = _strip(config.woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(config.woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    normalized = endpoint.lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/{normalized}"
    cache_key = _build_cache_key(f"direct::{normalized}", params)
    now_ms = _now_ms()
    cooldown_seconds = _proxy_cooldown_seconds(cache_key, now_ms)
    if cooldown_seconds > 0:
        err = IntegrationError("WooCommerce temporarily unavailable, please retry shortly")
        setattr(err, "status", 503)
        raise err

    try:
        acquired = _woo_http_semaphore.acquire(timeout=25)
        if not acquired:
            err = IntegrationError("WooCommerce is busy, please retry")
            setattr(err, "status", 503)
            raise err
        try:
            response = requests.get(
                url,
                params=_sanitize_params(params or {}),
                auth=HTTPBasicAuth(
                    _strip(config.woo_commerce.get("consumer_key")),
                    _strip(config.woo_commerce.get("consumer_secret")),
                ),
                timeout=10,
            )
        finally:
            try:
                _woo_http_semaphore.release()
            except ValueError:
                pass
        response.raise_for_status()
        # Try JSON; fall back to text if necessary.
        try:
            result = response.json()
        except ValueError:
            result = response.text
        _clear_proxy_failure(cache_key)
        return result
    except requests.RequestException as exc:  # pragma: no cover - network error path
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        status = getattr(exc.response, "status_code", None) if exc.response is not None else None
        if _should_trip_proxy_breaker(status):
            try:
                _record_proxy_failure(cache_key, status=status)
            except Exception:
                pass
        logger.error(
            "WooCommerce catalog fetch failed",
            exc_info=True,
            extra={"endpoint": endpoint, "status": status},
        )
        err = IntegrationError("WooCommerce catalog request failed", response=data)
        setattr(err, "status", status if status is not None else 502)
        raise err


def find_product_by_sku(sku: Optional[str]) -> Optional[Dict[str, Any]]:
    if not sku or not is_configured():
        return None

    base_url, api_version, auth, timeout = _client_config()
    url = f"{base_url}/wp-json/{api_version}/products"

    try:
        response = requests.get(
            url,
            params={"sku": sku, "per_page": 1},
            auth=auth,
            timeout=timeout,
        )
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - defensive logging
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.error("WooCommerce product lookup failed", exc_info=True, extra={"sku": sku})
        raise IntegrationError("Failed to look up WooCommerce product", response=data) from exc

    payload = response.json()
    if isinstance(payload, list) and payload:
        return payload[0]
    return None


def build_shipstation_note(
    shipstation_status: Any,
    tracking_number: Any,
    carrier_code: Any,
    ship_date: Any,
) -> str:
    parts: List[str] = []
    status = str(shipstation_status or "").strip()
    if status:
        parts.append(f"ShipStation status: {status}")
    tracking = str(tracking_number or "").strip()
    if tracking:
        parts.append(f"Tracking: {tracking}")
    carrier = str(carrier_code or "").strip()
    if carrier:
        parts.append(f"Carrier: {carrier}")
    shipped = str(ship_date or "").strip()
    if shipped:
        parts.append(f"Ship date: {shipped}")
    return " • ".join(parts)


def add_order_note(woo_order_id: str, note: str, *, customer_note: bool = False) -> Dict[str, Any]:
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured"}
    if not woo_order_id or not note:
        return {"status": "skipped", "reason": "missing_params"}

    base_url = _strip(get_config().woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(get_config().woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders/{woo_order_id}/notes"
    timeout_seconds = get_config().woo_commerce.get("request_timeout_seconds") or 25

    acquired = False
    try:
        acquired = _woo_http_semaphore.acquire(timeout=25)
        if not acquired:
            err = IntegrationError("WooCommerce is busy, please retry")
            setattr(err, "status", 503)
            raise err

        response = requests.post(
            url,
            json={"note": str(note), "customer_note": bool(customer_note)},
            auth=HTTPBasicAuth(
                _strip(get_config().woo_commerce.get("consumer_key")),
                _strip(get_config().woo_commerce.get("consumer_secret")),
            ),
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json() if response.content else {}
        return {"status": "success", "response": {"id": (body or {}).get("id")}}
    except requests.RequestException as exc:
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.warning("Failed to append WooCommerce order note", exc_info=False, extra={"wooOrderId": woo_order_id})
        raise IntegrationError("Failed to append WooCommerce order note", response=data) from exc
    finally:
        if acquired:
            try:
                _woo_http_semaphore.release()
            except ValueError:
                pass


def apply_shipstation_shipment_update(
    woo_order_id: str,
    *,
    current_status: Any = None,
    next_status: Optional[str] = None,
    shipstation_status: Any = None,
    tracking_number: Any = None,
    carrier_code: Any = None,
    ship_date: Any = None,
    existing_meta_data: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured", "changed": False}
    if not woo_order_id:
        return {"status": "skipped", "reason": "missing_woo_order_id", "changed": False}

    def safe_lower(value: Any) -> str:
        return str(value or "").strip().lower()

    current = safe_lower(current_status)
    next_val = safe_lower(next_status)
    locked_status = current in ("cancelled", "refunded", "trash")
    should_update_status = bool(next_val) and current != next_val and not locked_status

    def norm_meta_value(value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, (str, int, float, bool)):
            text = str(value).strip()
            return text if text else None
        try:
            text = json.dumps(value)
            return text if text else None
        except Exception:
            return None

    keys = {
        "status": "_peppro_shipstation_status",
        "tracking": "_peppro_shipstation_tracking_number",
        "carrier": "_peppro_shipstation_carrier_code",
        "shipDate": "_peppro_shipstation_ship_date",
    }

    existing = existing_meta_data if isinstance(existing_meta_data, list) else []

    def find_meta(key: str) -> Optional[Dict[str, Any]]:
        for entry in existing:
            try:
                if str(entry.get("key") or "") == key:
                    return entry
            except Exception:
                continue
        return None

    desired = [
        {"key": keys["status"], "value": norm_meta_value(shipstation_status)},
        {"key": keys["tracking"], "value": norm_meta_value(tracking_number)},
        {"key": keys["carrier"], "value": norm_meta_value(carrier_code)},
        {"key": keys["shipDate"], "value": norm_meta_value(ship_date)},
    ]
    desired = [item for item in desired if item.get("value") is not None]

    meta_updates: List[Dict[str, Any]] = []
    for item in desired:
        key = item["key"]
        value = item["value"]
        existing_entry = find_meta(key)
        existing_value = norm_meta_value((existing_entry or {}).get("value"))
        if existing_value == value:
            continue
        update: Dict[str, Any] = {"key": key, "value": value}
        if existing_entry and existing_entry.get("id") is not None:
            update["id"] = existing_entry.get("id")
        meta_updates.append(update)

    payload: Dict[str, Any] = {}
    if should_update_status:
        payload["status"] = str(next_status).strip()
    if meta_updates:
        payload["meta_data"] = meta_updates
    if not payload:
        return {"status": "skipped", "reason": "no_changes", "changed": False}

    base_url = _strip(get_config().woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(get_config().woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders/{woo_order_id}"
    timeout_seconds = get_config().woo_commerce.get("request_timeout_seconds") or 25

    acquired = False
    try:
        acquired = _woo_http_semaphore.acquire(timeout=25)
        if not acquired:
            err = IntegrationError("WooCommerce is busy, please retry")
            setattr(err, "status", 503)
            raise err

        response = requests.put(
            url,
            json=payload,
            auth=HTTPBasicAuth(
                _strip(get_config().woo_commerce.get("consumer_key")),
                _strip(get_config().woo_commerce.get("consumer_secret")),
            ),
            timeout=timeout_seconds,
        )
        response.raise_for_status()
        body = response.json() if response.content else {}
        return {
            "status": "success",
            "changed": True,
            "response": {"id": (body or {}).get("id"), "status": (body or {}).get("status")},
        }
    except requests.RequestException as exc:
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.warning(
            "Failed to apply ShipStation update to WooCommerce order",
            exc_info=False,
            extra={"wooOrderId": woo_order_id, "payloadKeys": list(payload.keys())},
        )
        raise IntegrationError("Failed to apply ShipStation update", response=data) from exc
    finally:
        if acquired:
            try:
                _woo_http_semaphore.release()
            except ValueError:
                pass


def update_product_inventory(
    product_id: Optional[int],
    stock_quantity: Optional[float],
    parent_id: Optional[int] = None,
    product_type: Optional[str] = None,
) -> Dict[str, Any]:
    if not product_id or not is_configured():
        return {"status": "skipped", "reason": "not_configured"}

    base_url, api_version, auth, timeout = _client_config()
    is_variation = bool(parent_id) or (product_type or "").lower() == "variation"
    if is_variation and not parent_id:
        raise IntegrationError("Variation inventory update requires parent product id")

    if is_variation:
        endpoint = f"{base_url}/wp-json/{api_version}/products/{parent_id}/variations/{product_id}"
    else:
        endpoint = f"{base_url}/wp-json/{api_version}/products/{product_id}"

    payload = {"manage_stock": True, "stock_quantity": stock_quantity if stock_quantity is not None else None}

    try:
        response = requests.put(endpoint, json=payload, auth=auth, timeout=timeout)
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - defensive logging
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.error(
            "WooCommerce inventory update failed",
            exc_info=True,
            extra={"productId": product_id, "parentId": parent_id},
        )
        raise IntegrationError("Failed to update WooCommerce inventory", response=data) from exc

    body = response.json() if response.content else {}
    return {"status": "success", "response": {"id": body.get("id"), "stock_quantity": body.get("stock_quantity")}}


def _sanitize_store_url() -> str:
    config = get_config()
    store_url = _strip(config.woo_commerce.get("store_url"))
    return store_url.rstrip("/")


def _build_invoice_url(order_id: Any, order_key: Any) -> Optional[str]:
    base = _sanitize_store_url()
    if not base or not order_id or not order_key:
        return None
    safe_id = quote(str(order_id).strip(), safe="")
    safe_key = quote(str(order_key).strip(), safe="")
    return f"{base}/checkout/order-received/{safe_id}/?key={safe_key}"


def _map_address(address: Optional[Dict[str, Any]]) -> Optional[Dict[str, Optional[str]]]:
    if not isinstance(address, dict):
        return None
    first = (address.get("first_name") or "").strip()
    last = (address.get("last_name") or "").strip()
    company = (address.get("company") or "").strip()
    name_parts = [part for part in [first, last] if part]
    name = " ".join(name_parts) or company or None
    mapped = {
        "name": name,
        "addressLine1": address.get("address_1") or None,
        "addressLine2": address.get("address_2") or None,
        "city": address.get("city") or None,
        "state": address.get("state") or None,
        "postalCode": address.get("postcode") or None,
        "country": address.get("country") or None,
        "phone": address.get("phone") or None,
    }
    if any(mapped.values()):
        return mapped
    return None


def _meta_value(meta: List[Dict[str, Any]], key: str) -> Optional[Any]:
    for entry in meta or []:
        if entry.get("key") == key:
            return entry.get("value")
    return None


def _is_truthy(value: Any) -> bool:
    if value is True:
        return True
    if value is False or value is None:
        return False
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0
        except Exception:
            return False
    text = str(value).strip().lower()
    return text in ("1", "true", "yes", "y", "on")


def _map_shipping_estimate(order: Dict[str, Any], meta: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(order, dict):
        return None
    shipping_lines = order.get("shipping_lines") or []
    first_line = shipping_lines[0] if shipping_lines else {}
    estimate: Dict[str, Any] = {}
    meta_service = _meta_value(meta, "peppro_shipping_service")
    meta_carrier = _meta_value(meta, "peppro_shipping_carrier")
    meta_total = _meta_value(meta, "peppro_shipping_total")
    if meta_service:
        estimate["serviceType"] = meta_service
    if meta_carrier:
        estimate["carrierId"] = meta_carrier
    if meta_total is not None:
        try:
            estimate["rate"] = float(meta_total)
        except Exception:
            pass
    if first_line:
        estimate.setdefault("serviceType", first_line.get("method_title") or first_line.get("method_id"))
        estimate.setdefault("serviceCode", first_line.get("method_id"))
        estimate.setdefault("carrierId", first_line.get("method_id"))
        try:
            total = float(first_line.get("total") or 0)
            if total:
                estimate.setdefault("rate", total)
        except Exception:
            pass
    return estimate or None


def _map_woo_order_summary(order: Dict[str, Any]) -> Dict[str, Any]:
    """Map Woo order JSON to a lightweight summary for the API."""
    def _num(val: Any, fallback: float = 0.0) -> float:
        try:
            return float(val)
        except Exception:
            return fallback

    meta_data = order.get("meta_data") or []
    peppro_order_id_raw = _meta_value(meta_data, "peppro_order_id")
    peppro_order_id = str(peppro_order_id_raw).strip() if peppro_order_id_raw is not None else None
    shipping_estimate = _map_shipping_estimate(order, meta_data)
    shipping_total = _num(order.get("shipping_total"), _num(_meta_value(meta_data, "peppro_shipping_total"), 0.0))
    invoice_url = _build_invoice_url(order.get("id"), order.get("order_key"))
    first_shipping_line = (order.get("shipping_lines") or [None])[0] or {}
    raw_number = order.get("number")
    woo_number = str(raw_number).strip() if raw_number is not None else None
    raw_id = order.get("id")
    woo_order_id = str(raw_id).strip() if raw_id is not None else None
    public_number = woo_number or woo_order_id
    # IMPORTANT:
    # - `id` must be the Woo order id (used by endpoints like /orders/<id>/invoice).
    # - `number` is the public-facing order number shown in the UI.
    identifier = woo_order_id or public_number or f"woo-{uuid4().hex[:8]}"

    if not public_number:
        # Trace situations where we fall back to a generated identifier.
        try:
            logger.debug(
                "Woo map summary missing number/id; using fallback",
                extra={"raw_id": raw_id, "raw_number": raw_number, "fallback_identifier": identifier},
            )
        except Exception:
            pass

    card_last4 = _meta_value(meta_data, "peppro_card_last4")
    card_brand = _meta_value(meta_data, "peppro_card_brand")
    if card_last4:
        payment_label = f"{card_brand or 'Card'} •••• {card_last4}"
    else:
        payment_label = order.get("payment_method_title") or order.get("payment_method")

    tax_total = _num(
        _meta_value(meta_data, "peppro_tax_total"),
        _num(order.get("total_tax"), 0.0),
    )
    if tax_total <= 0:
        for fee in order.get("fee_lines") or []:
            try:
                name = str((fee or {}).get("name") or "").strip().lower()
            except Exception:
                name = ""
            if not name:
                continue
            if "tax" in name:
                tax_total = _num((fee or {}).get("total"), 0.0)
                break

    mapped = {
        "id": identifier,
        "wooOrderId": woo_order_id or identifier,
        "wooOrderNumber": public_number or identifier,
        "number": public_number or identifier,
        "status": order.get("status"),
        "total": _num(order.get("total"), _num(order.get("total_ex_tax"), 0.0)),
        "taxTotal": tax_total,
        "grandTotal": _num(_meta_value(meta_data, "peppro_grand_total"), _num(order.get("total"), 0.0)),
        "currency": order.get("currency") or "USD",
        "paymentMethod": payment_label,
        "paymentDetails": payment_label,
        "shippingTotal": shipping_total,
        "createdAt": order.get("date_created") or order.get("date_created_gmt"),
        "updatedAt": order.get("date_modified") or order.get("date_modified_gmt"),
        "billingEmail": (order.get("billing") or {}).get("email"),
        "shippingAddress": _map_address(order.get("shipping")),
        "billingAddress": _map_address(order.get("billing")),
        "shippingEstimate": shipping_estimate,
        "source": "woocommerce",
        "lineItems": [
            {
                "id": item.get("id"),
                "productId": item.get("product_id"),
                "variationId": item.get("variation_id"),
                "name": item.get("name"),
                "quantity": _num(item.get("quantity"), 0),
                "total": _num(item.get("total"), 0.0),
                "sku": item.get("sku"),
                "image": (
                    item.get("image", {}).get("src")
                    if isinstance(item.get("image"), dict)
                    else item.get("image")
                )
                or (
                    item.get("product_image", {}).get("src")
                    if isinstance(item.get("product_image"), dict)
                    else item.get("product_image")
                ),
            }
            for item in order.get("line_items") or []
        ],
        "integrationDetails": {
            "wooCommerce": {
                "wooOrderId": woo_order_id,
                "wooOrderNumber": public_number or identifier,
                "pepproOrderId": peppro_order_id,
                "status": order.get("status"),
                "invoiceUrl": invoice_url,
                "shippingLine": first_shipping_line,
            },
            "stripe": {
                "cardBrand": card_brand,
                "cardLast4": card_last4,
            },
        },
    }
    try:
        logger.debug(
            "Woo map summary",
            extra={
                "raw_id": raw_id,
                "raw_number": raw_number,
                "peppro_order_id": peppro_order_id,
                "mapped_id": mapped.get("id"),
                "mapped_number": mapped.get("number"),
                "mapped_woo_order_number": mapped.get("wooOrderNumber"),
                "mapped_woo_order_id": mapped.get("wooOrderId"),
            },
        )
    except Exception:
        # Best-effort logging only; never block mapping.
        pass

    if _is_truthy(_meta_value(meta_data, "peppro_refunded")):
        mapped["status"] = "refunded"
        mapped["integrationDetails"]["wooCommerce"]["status"] = "refunded"
    return mapped


def fetch_orders_by_email(email: str, per_page: int = 15, *, force: bool = False) -> Any:
    if not email or not is_configured():
        return []
    trimmed = email.strip().lower()
    if not trimmed:
        return []

    size = max(1, min(per_page, 50))
    cache_key = _build_private_cache_key(
        "orders_by_email",
        {"email": trimmed, "per_page": size, "orderby": "date", "order": "desc"},
    )
    now_ms = int(time.time() * 1000)

    if not force:
        with _orders_by_email_cache_lock:
            cached = _orders_by_email_cache.get(cache_key)
            if cached and cached.get("expiresAt", 0) > now_ms:
                return cached.get("data") or []

        disk_cached = _read_disk_cache(cache_key)
        if disk_cached and isinstance(disk_cached, dict):
            expires_at = int(disk_cached.get("expiresAt") or 0)
            if expires_at > now_ms:
                data = disk_cached.get("data") or []
                with _orders_by_email_cache_lock:
                    _orders_by_email_cache[cache_key] = {"data": data, "expiresAt": expires_at}
                return data

    try:
        response = _fetch_catalog_http(
            "orders",
            {"per_page": size, "orderby": "date", "order": "desc"},
            suppress_log=True,
        )
        payload = response if isinstance(response, list) else []
        mapped_orders: List[Dict[str, Any]] = []
        for order in payload:
            if not isinstance(order, dict):
                continue
            billing_email = (order.get("billing") or {}).get("email")
            if not isinstance(billing_email, str):
                continue
            if billing_email.strip().lower() != trimmed:
                continue
            mapped = _map_woo_order_summary(order)
            mapped_orders.append(mapped)

        now_ms = int(time.time() * 1000)
        expires_at = now_ms + (_ORDERS_BY_EMAIL_TTL_SECONDS * 1000)
        with _orders_by_email_cache_lock:
            _orders_by_email_cache[cache_key] = {"data": mapped_orders, "expiresAt": expires_at}
        _write_disk_cache(cache_key, {"data": mapped_orders, "fetchedAt": now_ms, "expiresAt": expires_at})

        logger.debug(
            "Woo fetch by email",
            extra={
                "email": email,
                "requested_per_page": per_page,
                "returned": len(mapped_orders),
                "raw_count": len(payload),
                "sample": mapped_orders[:3],
            },
        )
        return mapped_orders
    except IntegrationError as exc:
        status = getattr(exc, "status", None)
        if _should_retry_status(status):
            def should_warn_cached(kind: str) -> bool:
                now_local = int(time.time() * 1000)
                key = f"{cache_key}::{kind}"
                with _orders_by_email_cache_lock:
                    last = int(_orders_by_email_cached_warning_at_ms.get(key) or 0)
                    if last and now_local - last < _ORDERS_BY_EMAIL_CACHED_WARN_COOLDOWN_MS:
                        return False
                    _orders_by_email_cached_warning_at_ms[key] = now_local
                return True

            with _orders_by_email_cache_lock:
                cached = _orders_by_email_cache.get(cache_key)
                if cached:
                    expires_at = int(cached.get("expiresAt") or 0)
                    if now_ms - expires_at <= _ORDERS_BY_EMAIL_MAX_STALE_MS:
                        log = logger.warning if should_warn_cached("memory") else logger.debug
                        log(
                            "WooCommerce orders fetch failed; serving cached orders",
                            extra={"email": trimmed, "status": status},
                        )
                        return cached.get("data") or []
            disk_cached = _read_disk_cache(cache_key)
            if disk_cached and isinstance(disk_cached, dict):
                fetched_at = int(disk_cached.get("fetchedAt") or 0)
                if now_ms - fetched_at <= _ORDERS_BY_EMAIL_MAX_STALE_MS:
                    log = logger.warning if should_warn_cached("disk") else logger.debug
                    log(
                        "WooCommerce orders fetch failed; serving cached orders from disk",
                        extra={"email": trimmed, "status": status},
                    )
                    return disk_cached.get("data") or []
        raise
    except Exception as exc:
        logger.error("Failed to fetch WooCommerce orders by email", exc_info=True, extra={"email": email})
        raise IntegrationError("WooCommerce order lookup failed")


def fetch_order(woo_order_id: str) -> Optional[Dict[str, Any]]:
    """Fetch a single Woo order by id; returns None on not found/errors."""
    if not woo_order_id or not is_configured():
        return None
    try:
        result = fetch_catalog(f"orders/{woo_order_id}")
        if isinstance(result, dict) and result.get("id"):
            return result
    except IntegrationError as exc:  # pragma: no cover - network path
        if getattr(exc, "status", None) == 404:
            return None
    except Exception as exc:  # pragma: no cover - network path
        logger.error("Failed to fetch Woo order by id", exc_info=True, extra={"wooOrderId": woo_order_id})
    return None


def fetch_order_summary(woo_order_id: str) -> Dict[str, Any]:
    """
    Fetch a single Woo order by id and map to PepPro order summary.

    Unlike `fetch_order()`, this returns a structured status that differentiates 404/not_found
    from transient errors so callers can safely reconcile local records.
    """
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured"}
    if not woo_order_id:
        return {"status": "skipped", "reason": "missing_woo_order_id"}
    try:
        result = fetch_catalog(f"orders/{woo_order_id}")
        if not isinstance(result, dict) or not result.get("id"):
            return {"status": "not_found", "wooOrderId": woo_order_id}
        return {"status": "success", "wooOrderId": woo_order_id, "order": _map_woo_order_summary(result)}
    except IntegrationError as exc:
        status_code = getattr(exc, "status", None)
        if status_code == 404:
            return {"status": "not_found", "wooOrderId": woo_order_id}
        return {
            "status": "error",
            "wooOrderId": woo_order_id,
            "statusCode": status_code if status_code is not None else 502,
            "message": str(exc) or "WooCommerce order lookup failed",
        }
    except Exception:
        logger.error("Failed to fetch Woo order summary by id", exc_info=True, extra={"wooOrderId": woo_order_id})
        return {"status": "error", "wooOrderId": woo_order_id, "statusCode": 502, "message": "WooCommerce order lookup failed"}


def fetch_order_by_number(order_number: str, search_window: int = 25) -> Optional[Dict[str, Any]]:
    """
    Attempt to resolve a Woo order using its public order number (including custom numbering schemes).
    """
    if not order_number or not is_configured():
        return None

    normalized_candidates: List[str] = []
    stripped = (order_number or "").strip()
    if stripped:
        normalized_candidates.append(stripped)
    digits_only = re.sub(r"[^\d]", "", stripped)
    if digits_only and digits_only not in normalized_candidates:
        normalized_candidates.append(digits_only)

    for candidate in normalized_candidates:
        try:
            payload = fetch_catalog(
                "orders",
                {
                    "per_page": max(1, min(search_window, 50)),
                    "search": candidate,
                    "orderby": "date",
                    "order": "desc",
                },
            )
        except IntegrationError as exc:  # pragma: no cover - network path
            if getattr(exc, "status", None) == 404:
                continue
            raise
        except Exception as exc:  # pragma: no cover - unexpected failure
            logger.error("Failed to search Woo order by number", exc_info=True, extra={"wooOrderNumber": candidate})
            continue

        if not isinstance(payload, list):
            continue

        for entry in payload:
            if not isinstance(entry, dict):
                continue
            entry_number = str(entry.get("number") or "").strip()
            entry_id = str(entry.get("id") or "").strip()
            if entry_number == candidate or entry_id == candidate:
                return entry

    return None


def fetch_order_by_peppro_id(peppro_order_id: str, search_window: int = 25) -> Optional[Dict[str, Any]]:
    """
    Attempt to locate a Woo order via the `peppro_order_id` meta tag that we attach when creating orders.
    """
    if not peppro_order_id or not is_configured():
        return None

    params = {
        "per_page": max(1, min(search_window, 50)),
        "orderby": "date",
        "order": "desc",
        "meta_key": "peppro_order_id",
        "meta_value": str(peppro_order_id).strip(),
    }

    try:
        payload = fetch_catalog("orders", params)
    except IntegrationError as exc:  # pragma: no cover - network path
        if getattr(exc, "status", None) == 404:
            return None
        raise
    except Exception as exc:  # pragma: no cover
        logger.error("Failed to search Woo order by peppro id", exc_info=True, extra={"pepproOrderId": peppro_order_id})
        return None

    if not isinstance(payload, list):
        return None

    for entry in payload:
        if not isinstance(entry, dict):
            continue
        metadata = entry.get("meta_data") or []
        for meta in metadata:
            if not isinstance(meta, dict):
                continue
            if meta.get("key") == "peppro_order_id" and str(meta.get("value")) == str(peppro_order_id):
                return entry
    return None
