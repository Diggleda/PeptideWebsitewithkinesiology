from __future__ import annotations

import re
import threading
import time
from typing import Any, Dict, Optional

import requests

from ..utils import http_client

UPS_TRACK_PAGE_URL = "https://www.ups.com/track"
UPS_TRACK_STATUS_API_URL = "https://www.ups.com/track/api/Track/GetStatus"

_CACHE_TTL_SECONDS = 300.0
_cache_lock = threading.Lock()
_cache: Dict[str, Dict[str, Any]] = {}


def _safe_string(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _deep_get(obj: Any, *path: Any) -> Any:
    cur = obj
    for key in path:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(key)
            continue
        if isinstance(cur, list) and isinstance(key, int):
            if key < 0 or key >= len(cur):
                return None
            cur = cur[key]
            continue
        return None
    return cur


def _normalize_tracking_number(value: str) -> str:
    raw = _safe_string(value) or ""
    # Keep alphanumerics only to avoid header injection / weird formats.
    cleaned = re.sub(r"[^A-Za-z0-9]", "", raw).upper()
    return cleaned


def _normalize_status_token(value: Optional[str]) -> Optional[str]:
    raw = _safe_string(value)
    if not raw:
        return None
    token = raw.lower().strip()
    token = re.sub(r"\s+", "_", token)
    token = re.sub(r"-+", "_", token)
    token = re.sub(r"_+", "_", token)
    return token


def _map_status_to_peppro(raw_status: Optional[str]) -> Optional[str]:
    token = _normalize_status_token(raw_status)
    if not token:
        return None

    if "delivered" in token:
        return "delivered"
    if "out_for_delivery" in token or "outfordelivery" in token:
        return "out_for_delivery"
    if "in_transit" in token or "intransit" in token:
        return "in_transit"
    if "label_created" in token or "labelcreated" in token:
        return "label_created"
    if "exception" in token:
        return "exception"
    if "shipped" in token:
        return "shipped"
    return token


def _extract_ups_status(payload: Any) -> Optional[str]:
    # UPS Track API responses vary; try a few common paths.
    candidates = [
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "currentStatus", "description"),
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "currentStatus", "statusCode"),
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "activity", 0, "status", "description"),
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "activity", 0, "status", "statusCode"),
        _deep_get(payload, "trackResponse", "shipment", 0, "currentStatus", "description"),
        _deep_get(payload, "trackResponse", "shipment", 0, "currentStatus", "statusCode"),
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "statusType", "description"),
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "statusType", "statusCode"),
    ]
    for candidate in candidates:
        text = _safe_string(candidate)
        if text:
            return text
    return None


def _extract_ups_delivered_at(payload: Any) -> Optional[str]:
    # Best-effort: find a delivered activity timestamp.
    activities = _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "activity")
    if isinstance(activities, list):
        for entry in activities:
            status_desc = _safe_string(_deep_get(entry, "status", "description")) or ""
            if "delivered" in status_desc.lower():
                timestamp = _safe_string(entry.get("date")) or _safe_string(entry.get("time"))
                # UPS commonly provides separate date/time; keep raw best-effort.
                delivered_dt = _safe_string(entry.get("dateTime")) or _safe_string(entry.get("datetime"))
                return delivered_dt or timestamp
    return None


def _get_cached(tracking_number: str) -> Optional[Dict[str, Any]]:
    now = time.time()
    with _cache_lock:
        cached = _cache.get(tracking_number)
        if cached and float(cached.get("expiresAt") or 0) > now:
            return cached.get("value")  # type: ignore[return-value]
    return None


def _set_cached(tracking_number: str, value: Dict[str, Any]) -> None:
    now = time.time()
    with _cache_lock:
        _cache[tracking_number] = {"value": value, "expiresAt": now + _CACHE_TTL_SECONDS}


def fetch_tracking_status(tracking_number: str) -> Optional[Dict[str, Any]]:
    """
    Best-effort UPS tracking status lookup for a given tracking number.
    Returns a minimal dict with `trackingStatus` + optional timestamps, or None on failure.
    """
    normalized = _normalize_tracking_number(tracking_number)
    if not normalized:
        return None

    cached = _get_cached(normalized)
    if cached is not None:
        return cached

    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    )

    try:
        # Prime cookies + XSRF token (UPS Track API can require it).
        http_client.request_with_session(
            session,
            "GET",
            UPS_TRACK_PAGE_URL,
            params={"loc": "en_US", "tracknum": normalized, "requester": "ST/trackdetails"},
            headers={"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"},
            allow_redirects=True,
        )

        xsrf = session.cookies.get("XSRF-TOKEN") or session.cookies.get("xsrf-token")
        api_headers = {
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
            "Origin": "https://www.ups.com",
            "Referer": f"{UPS_TRACK_PAGE_URL}?loc=en_US&tracknum={normalized}&requester=ST/trackdetails",
        }
        if xsrf:
            api_headers["X-XSRF-TOKEN"] = xsrf

        resp = http_client.request_with_session(
            session,
            "POST",
            UPS_TRACK_STATUS_API_URL,
            params={"loc": "en_US"},
            json={"Locale": "en_US", "TrackingNumber": [normalized]},
            headers=api_headers,
        )
        resp.raise_for_status()
        payload = resp.json() or {}
    except Exception:
        return None

    raw_status = _extract_ups_status(payload)
    tracking_status = _map_status_to_peppro(raw_status)
    delivered_at = _extract_ups_delivered_at(payload)

    result = {
        "carrier": "ups",
        "trackingNumber": normalized,
        "trackingStatus": tracking_status,
        "trackingStatusRaw": raw_status,
        "deliveredAt": delivered_at,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _set_cached(normalized, result)
    return result
