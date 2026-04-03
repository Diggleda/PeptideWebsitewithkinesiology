from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple
from uuid import uuid4

import requests
from requests.auth import HTTPBasicAuth
from urllib.parse import quote

from ..services import get_config
from ..utils import http_client

UPS_CIE_BASE_URL = "https://wwwcie.ups.com"
UPS_PROD_BASE_URL = "https://onlinetools.ups.com"
UPS_TOKEN_PATH = "/security/v1/oauth/token"
UPS_TRACK_PATH = "/api/track/v1/details"
UPS_TRANSACTION_SOURCE = "peppro"

_TRACKING_CACHE_TTL_SECONDS = 300.0
_tracking_cache_lock = threading.Lock()
_tracking_cache: Dict[str, Dict[str, Any]] = {}

_token_lock = threading.Lock()
_token_cache: Dict[str, Any] = {
    "accessToken": None,
    "expiresAt": 0.0,
}


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


def _normalize_tracking_number(value: Any) -> str:
    raw = _safe_string(value) or ""
    return re.sub(r"[^A-Za-z0-9]", "", raw).upper()


def looks_like_ups_tracking_number(value: Any) -> bool:
    normalized = _normalize_tracking_number(value)
    return normalized.startswith("1Z") and len(normalized) >= 8


def _normalize_status_token(value: Any) -> Optional[str]:
    raw = _safe_string(value)
    if not raw:
        return None
    token = raw.lower().strip()
    token = token.replace("&", " and ")
    token = re.sub(r"[^a-z0-9]+", "_", token)
    token = re.sub(r"_+", "_", token).strip("_")
    return token or None


def normalize_tracking_status(value: Any) -> Optional[str]:
    token = _normalize_status_token(value)
    if not token:
        return None

    if "delivered" in token:
        return "delivered"
    if (
        "out_for_delivery" in token
        or "outfordelivery" in token
        or "delivery_vehicle" in token
        or "follow_your_delivery" in token
    ):
        return "out_for_delivery"
    if any(
        part in token
        for part in (
            "exception",
            "delay",
            "delayed",
            "hold",
            "held",
            "return_to_sender",
            "returned_to_sender",
            "returning_to_sender",
            "damaged",
            "damage",
            "mis_sort",
            "missort",
            "unable_to_deliver",
            "not_delivered",
            "delivery_attempted",
            "delivery_change_requested",
            "address_information_required",
            "clearance_information_required",
            "rescheduled_delivery",
            "contact_receiver",
        )
    ):
        return "exception"
    if any(
        part in token
        for part in (
            "label_created",
            "shipment_ready_for_ups",
            "order_processed",
            "billing_information_received",
            "manifest_picked_up",
            "shipment_information_received",
            "information_received",
            "pre_transit",
            "ready_for_ups",
            "shipper_created_a_label",
            "shipment_ready",
            "ups_has_not_received",
            "has_not_received_the_package",
            "awaiting_item",
            "awaiting_package",
        )
    ):
        return "label_created"
    if (
        ("label" in token and ("created" in token or "printed" in token))
        or ("not_received" in token and "package" in token)
        or ("not_received" in token and "ups" in token)
    ):
        return "label_created"
    if any(
        part in token
        for part in (
            "in_transit",
            "intransit",
            "on_the_way",
            "ontheway",
            "departed",
            "arrived",
            "pickup_scan",
            "origin_scan",
            "destination_scan",
            "processing_at_ups_facility",
            "loaded_on_delivery_vehicle",
            "received_by_post_office_for_delivery",
            "picked_up",
            "pickup",
            "drop_off",
            "dropped_off",
            "tendered",
            "package_received_for_processing",
            "package_transferred",
            "arrived_at_facility",
            "departed_from_facility",
            "warehouse_scan",
            "weve_correctly_addressed_the_package",
            "corrected_the_package_address",
            "address_corrected",
            "transferred_to_post_office",
            "received_by_post_office",
            "sortation",
        )
    ):
        return "in_transit"
    if "facility" in token and any(part in token for part in ("arrived", "departed", "processing", "scan")):
        return "in_transit"
    if "address" in token and "correct" in token:
        return "in_transit"
    return "unknown"


def is_configured() -> bool:
    cfg = get_config().ups
    return bool(cfg.get("client_id") and cfg.get("client_secret"))


def _base_url() -> str:
    cfg = get_config().ups
    return UPS_CIE_BASE_URL if bool(cfg.get("use_cie")) else UPS_PROD_BASE_URL


def _tracking_cache_get(tracking_number: str) -> Optional[Dict[str, Any]]:
    now = time.time()
    with _tracking_cache_lock:
        cached = _tracking_cache.get(tracking_number)
        if cached and float(cached.get("expiresAt") or 0) > now:
            return cached.get("value")  # type: ignore[return-value]
    return None


def _tracking_cache_set(tracking_number: str, value: Dict[str, Any]) -> None:
    with _tracking_cache_lock:
        _tracking_cache[tracking_number] = {
            "value": value,
            "expiresAt": time.time() + _TRACKING_CACHE_TTL_SECONDS,
        }


def _now_utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_positive_int(value: Any, fallback: int) -> int:
    try:
        parsed = int(str(value or "").strip())
    except Exception:
        return fallback
    return parsed if parsed > 0 else fallback


def _token_cache_get() -> Optional[str]:
    now = time.time()
    token = _safe_string(_token_cache.get("accessToken"))
    expires_at = float(_token_cache.get("expiresAt") or 0.0)
    if token and expires_at > now:
        return token
    return None


def _token_cache_set(access_token: str, expires_in: Any) -> None:
    ttl_seconds = _parse_positive_int(expires_in, 3600)
    refresh_buffer = max(30, min(int(ttl_seconds * 0.1), 300))
    expires_at = time.time() + max(30, ttl_seconds - refresh_buffer)
    _token_cache["accessToken"] = access_token
    _token_cache["expiresAt"] = expires_at


def _request_access_token() -> str:
    cfg = get_config().ups
    client_id = _safe_string(cfg.get("client_id"))
    client_secret = _safe_string(cfg.get("client_secret"))
    if not client_id or not client_secret:
        raise RuntimeError("UPS credentials are not configured")

    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    merchant_id = _safe_string(cfg.get("merchant_id"))
    if merchant_id:
        headers["x-merchant-id"] = merchant_id

    response = http_client.post(
        f"{_base_url()}{UPS_TOKEN_PATH}",
        data={"grant_type": "client_credentials"},
        headers=headers,
        auth=HTTPBasicAuth(client_id, client_secret),
    )
    response.raise_for_status()

    payload = response.json() or {}
    access_token = _safe_string(payload.get("access_token"))
    if not access_token:
        raise RuntimeError("UPS token response did not contain an access token")
    _token_cache_set(access_token, payload.get("expires_in"))
    return access_token


def _get_access_token() -> str:
    with _token_lock:
        cached = _token_cache_get()
        if cached:
            return cached
        return _request_access_token()


def _first_package(payload: Any) -> Dict[str, Any]:
    package = _deep_get(payload, "trackResponse", "shipment", 0, "package", 0)
    return package if isinstance(package, dict) else {}


def _extract_status_obj(payload: Any) -> Dict[str, Any]:
    candidates = [
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "currentStatus"),
        _deep_get(payload, "trackResponse", "shipment", 0, "currentStatus"),
        _deep_get(payload, "trackResponse", "shipment", 0, "package", 0, "activity", 0, "status"),
    ]
    for candidate in candidates:
        if isinstance(candidate, dict):
            return candidate
    return {}


def _extract_ups_status(payload: Any) -> Tuple[Optional[str], Optional[str]]:
    package = _first_package(payload)
    status_obj = _extract_status_obj(payload)
    activities = package.get("activity") if isinstance(package.get("activity"), list) else []
    raw_status_candidates = [
        status_obj.get("simplifiedTextDescription"),
        status_obj.get("description"),
        package.get("statusDescription"),
        package.get("currentStatusDescription"),
    ]
    for entry in activities:
        if not isinstance(entry, dict):
            continue
        status = entry.get("status") if isinstance(entry.get("status"), dict) else {}
        raw_status_candidates.extend(
            [
                status.get("simplifiedTextDescription"),
                status.get("description"),
            ]
        )

    fallback_text: Optional[str] = None
    for candidate in raw_status_candidates:
        text = _safe_string(candidate)
        if not text:
            continue
        if fallback_text is None:
            fallback_text = text
        normalized = normalize_tracking_status(text)
        if normalized and normalized != "unknown":
            return text, _safe_string(status_obj.get("statusCode") or status_obj.get("code"))
    return fallback_text, _safe_string(status_obj.get("statusCode") or status_obj.get("code"))


def _format_activity_datetime(date_value: Any, time_value: Any, gmt_offset: Any = None) -> Optional[str]:
    date_text = _safe_string(date_value)
    if not date_text or len(date_text) != 8 or not date_text.isdigit():
        return None
    time_text = (_safe_string(time_value) or "000000").rjust(6, "0")
    if len(time_text) != 6 or not time_text.isdigit():
        return None

    stamp = f"{date_text[0:4]}-{date_text[4:6]}-{date_text[6:8]}T{time_text[0:2]}:{time_text[2:4]}:{time_text[4:6]}"
    offset_text = _safe_string(gmt_offset)
    if offset_text and re.match(r"^[+-]\d{2}:\d{2}$", offset_text):
        stamp = f"{stamp}{offset_text}"
        try:
            return datetime.fromisoformat(stamp).isoformat()
        except Exception:
            return stamp
    return stamp


def _extract_delivered_at(payload: Any) -> Optional[str]:
    package = _first_package(payload)
    delivery_dates = package.get("deliveryDate")
    if isinstance(delivery_dates, list):
        delivered_date = None
        for entry in delivery_dates:
            if not isinstance(entry, dict):
                continue
            if _safe_string(entry.get("type")) == "DEL":
                delivered_date = entry.get("date")
                break
        delivery_time = package.get("deliveryTime")
        if isinstance(delivery_time, dict) and _safe_string(delivery_time.get("type")) == "DEL":
            formatted = _format_activity_datetime(delivered_date, delivery_time.get("endTime"))
            if formatted:
                return formatted
        if delivered_date:
            formatted = _format_activity_datetime(delivered_date, "000000")
            if formatted:
                return formatted

    activities = package.get("activity")
    if isinstance(activities, list):
        for entry in activities:
            if not isinstance(entry, dict):
                continue
            status = entry.get("status") if isinstance(entry.get("status"), dict) else {}
            raw_status = (
                _safe_string(status.get("simplifiedTextDescription"))
                or _safe_string(status.get("description"))
                or ""
            )
            if normalize_tracking_status(raw_status) != "delivered":
                continue
            gmt_date = entry.get("gmtDate") or entry.get("date")
            gmt_time = entry.get("gmtTime") or entry.get("time")
            formatted = _format_activity_datetime(gmt_date, gmt_time, entry.get("gmtOffset"))
            if formatted:
                return formatted
    return None


def fetch_tracking_status(tracking_number: str) -> Optional[Dict[str, Any]]:
    normalized = _normalize_tracking_number(tracking_number)
    if not normalized:
        return None
    if not is_configured():
        return None

    cached = _tracking_cache_get(normalized)
    if cached is not None:
        return cached

    checked_at = _now_utc_iso()
    try:
        access_token = _get_access_token()
        response = http_client.get(
            f"{_base_url()}{UPS_TRACK_PATH}/{quote(normalized)}",
            params={"locale": "en_US"},
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "transId": uuid4().hex,
                "transactionSrc": UPS_TRANSACTION_SOURCE,
            },
        )
        response.raise_for_status()
        payload = response.json() or {}
    except Exception as exc:
        return {
            "carrier": "ups",
            "trackingNumber": normalized,
            "trackingStatus": None,
            "trackingStatusRaw": None,
            "deliveredAt": None,
            "checkedAt": checked_at,
            "error": "UPS_LOOKUP_FAILED",
            "errorDetail": str(exc)[:240],
        }

    raw_status, status_code = _extract_ups_status(payload)
    tracking_status = normalize_tracking_status(raw_status) or "unknown"
    delivered_at = _extract_delivered_at(payload)

    result = {
        "carrier": "ups",
        "trackingNumber": _safe_string(_deep_get(payload, "trackResponse", "shipment", 0, "inquiryNumber")) or normalized,
        "trackingStatus": tracking_status,
        "trackingStatusRaw": raw_status,
        "statusCode": status_code,
        "deliveredAt": delivered_at,
        "checkedAt": checked_at,
    }
    _tracking_cache_set(normalized, result)
    return result
