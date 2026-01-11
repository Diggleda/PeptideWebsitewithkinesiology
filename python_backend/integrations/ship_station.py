from __future__ import annotations

import logging
import os
import threading
import time
from typing import Dict, List, Optional

import requests

from ..services import get_config
from ..utils import http_client

logger = logging.getLogger(__name__)

API_BASE_URL = "https://ssapi.shipstation.com"
_ORDER_STATUS_CACHE_TTL_SECONDS = int(
    os.environ.get("SHIPSTATION_STATUS_TTL_SECONDS", "60").strip() or 60
)
_ORDER_STATUS_CACHE_TTL_SECONDS = max(10, min(_ORDER_STATUS_CACHE_TTL_SECONDS, 10 * 60))
_order_status_cache: Dict[str, Dict[str, object]] = {}
_order_status_cache_lock = threading.Lock()

def _coerce_timeout_seconds(value: object, *, default: float) -> float:
    if value in (None, "", False):
        return float(default)
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return float(default)
    if numeric <= 0:
        return float(default)
    return float(numeric)


_SHIPSTATION_HTTP_TIMEOUT_SECONDS = os.environ.get("SHIPSTATION_HTTP_TIMEOUT_SECONDS")
_SHIPSTATION_CONNECT_TIMEOUT_SECONDS = _coerce_timeout_seconds(
    os.environ.get("SHIPSTATION_HTTP_CONNECT_TIMEOUT_SECONDS"),
    default=http_client.DEFAULT_CONNECT_TIMEOUT_SECONDS,
)
_SHIPSTATION_READ_TIMEOUT_SECONDS = _coerce_timeout_seconds(
    os.environ.get("SHIPSTATION_HTTP_READ_TIMEOUT_SECONDS"),
    default=15.0,
)

if _SHIPSTATION_HTTP_TIMEOUT_SECONDS not in (None, "", False):
    _single = _coerce_timeout_seconds(_SHIPSTATION_HTTP_TIMEOUT_SECONDS, default=_SHIPSTATION_READ_TIMEOUT_SECONDS)
    _SHIPSTATION_CONNECT_TIMEOUT_SECONDS = _single
    _SHIPSTATION_READ_TIMEOUT_SECONDS = _single

_SHIPSTATION_CONNECT_TIMEOUT_SECONDS = max(1.0, min(_SHIPSTATION_CONNECT_TIMEOUT_SECONDS, 60.0))
_SHIPSTATION_READ_TIMEOUT_SECONDS = max(2.0, min(_SHIPSTATION_READ_TIMEOUT_SECONDS, 90.0))


def _shipstation_timeout():
    return (_SHIPSTATION_CONNECT_TIMEOUT_SECONDS, _SHIPSTATION_READ_TIMEOUT_SECONDS)


_SHIPSTATION_UNAVAILABLE_TTL_SECONDS = int(
    os.environ.get("SHIPSTATION_UNAVAILABLE_TTL_SECONDS", "900").strip() or 900
)
_SHIPSTATION_UNAVAILABLE_TTL_SECONDS = max(60, min(_SHIPSTATION_UNAVAILABLE_TTL_SECONDS, 24 * 60 * 60))
_shipstation_unavailable_until = 0.0
_shipstation_unavailable_lock = threading.Lock()


class IntegrationError(RuntimeError):
    def __init__(self, message: str, response: Optional[Dict] = None, status: int = 500):
        super().__init__(message)
        self.response = response
        self.status = status


def _mark_unavailable(status_code: Optional[int], reason: str) -> None:
    now = time.time()
    until = now + _SHIPSTATION_UNAVAILABLE_TTL_SECONDS
    with _shipstation_unavailable_lock:
        global _shipstation_unavailable_until
        if _shipstation_unavailable_until > now:
            return
        _shipstation_unavailable_until = until
    logger.warning(
        "ShipStation API unavailable; pausing lookups",
        exc_info=False,
        extra={"status": status_code, "reason": reason, "pauseSeconds": _SHIPSTATION_UNAVAILABLE_TTL_SECONDS},
    )


def _is_unavailable() -> bool:
    now = time.time()
    with _shipstation_unavailable_lock:
        return _shipstation_unavailable_until > now


def _cache_order_status(normalized: str, value: Optional[Dict], ttl_seconds: int = _ORDER_STATUS_CACHE_TTL_SECONDS) -> None:
    now = time.time()
    with _order_status_cache_lock:
        _order_status_cache[normalized] = {"value": value, "expiresAt": now + max(1, ttl_seconds)}


def _extract_error_payload(exc: requests.RequestException):
    if exc.response is None:
        return None
    try:
        return exc.response.json()
    except Exception:
        try:
            return exc.response.text
        except Exception:
            return None


def is_configured(log: bool = False) -> bool:
    cfg = get_config().ship_station
    configured = bool(cfg.get("api_token") or (cfg.get("api_key") and cfg.get("api_secret")))
    if log:
        logger.info(
            "ShipStation configuration check",
            extra={
                "api_token_set": bool(cfg.get("api_token")),
                "api_key_set": bool(cfg.get("api_key")),
                "api_secret_set": bool(cfg.get("api_secret")),
                "carrier_code": bool(cfg.get("carrier_code")),
                "service_code": bool(cfg.get("service_code")),
                "ship_from_postal": cfg.get("ship_from", {}).get("postal_code"),
            },
        )
    return configured


def _http_args():
    cfg = get_config().ship_station
    headers = {"Content-Type": "application/json"}
    auth = None
    if cfg.get("api_token"):
        headers["Authorization"] = f"Bearer {cfg['api_token']}"
    else:
        auth = (cfg.get("api_key"), cfg.get("api_secret"))
    return headers, auth


def _sum_weight_ounces(items: List[Dict]) -> float:
    total = 0.0
    missing_qty = 0.0
    for item in items or []:
        quantity = float(item.get("quantity") or 0)
        if quantity <= 0:
            continue
        weight = float(item.get("weightOz") or 0)
        if weight > 0:
            total += quantity * weight
        else:
            missing_qty += quantity
    if missing_qty > 0:
        total += 16.0 * missing_qty
    # Preserve true cumulative weight; only fall back when weights are missing.
    return total if total > 0 else 16.0


def _aggregate_dimensions(items: List[Dict]) -> Optional[Dict]:
    length = None
    width = None
    height = None

    for item in items or []:
        q = float(item.get("quantity") or 0) or 0
        l = _coerce_inventory_number(item.get("length"))
        w = _coerce_inventory_number(item.get("width"))
        h = _coerce_inventory_number(item.get("height"))
        if l and (length is None or l > length):
            length = l
        if w and (width is None or w > width):
            width = w
        if h:
            height = (height or 0) + h * max(q, 1)

    if length and width and height:
        return {
            "length": length,
            "width": width,
            "height": height,
            "units": "inches",
        }
    return None


def _ship_from() -> Dict:
    cfg = get_config().ship_station.get("ship_from") or {}
    return {
        "city": cfg.get("city") or "",
        "state": cfg.get("state") or "",
        "postal_code": cfg.get("postal_code") or "",
        "country": cfg.get("country_code") or "US",
    }


def _coerce_inventory_number(*values: Optional[float]) -> Optional[float]:
    for value in values:
        if value in (None, "", False):
            continue
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            continue
        if numeric >= 0:
            return numeric
    return None


def estimate_rates(shipping_address: Dict, items: List[Dict]) -> List[Dict]:
    if not is_configured():
        raise IntegrationError("ShipStation is not configured", status=503)

    if _is_unavailable():
        raise IntegrationError("ShipStation is temporarily unavailable", status=503)

    required = [
        shipping_address.get("addressLine1"),
        shipping_address.get("city"),
        shipping_address.get("state"),
        shipping_address.get("postalCode"),
    ]
    if not all(required):
        raise IntegrationError("Shipping address is incomplete", status=400)

    headers, auth = _http_args()
    cfg = get_config().ship_station
    ship_from = _ship_from()
    def build_payload(carrier_code: Optional[str], service_code: Optional[str], strip_service: bool = False) -> Dict:
        effective_service = None if strip_service else (service_code or None)
        payload = {
            "carrierCode": carrier_code,
            "serviceCode": effective_service,
            "packageCode": cfg.get("package_code") or None,
            "confirmation": "none",
            "fromCity": ship_from["city"],
            "fromState": ship_from["state"],
            "fromPostalCode": ship_from["postal_code"],
            "fromCountry": ship_from["country"],
            "toCity": shipping_address.get("city"),
            "toState": shipping_address.get("state"),
            "toPostalCode": shipping_address.get("postalCode"),
            "toCountry": shipping_address.get("country") or "US",
            "weight": {
                "value": _sum_weight_ounces(items or []),
                "units": "ounces",
            },
        }
        dimensions = _aggregate_dimensions(items or [])
        if dimensions:
            payload["dimensions"] = dimensions
        else:
            # Some carriers (e.g., FedEx One Balance) reject rate requests without dimensions.
            payload["dimensions"] = {"length": 9, "width": 6, "height": 2, "units": "inches"}
        return {k: v for k, v in payload.items() if v not in (None, "", {})}

    def _extract_response(exc: requests.RequestException):
        data = None
        status = getattr(exc.response, "status_code", None)
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        return data, status

    def attempt(payload_variant: Dict):
        resp = http_client.post(
            f"{API_BASE_URL}/shipments/getrates",
            json=payload_variant,
            headers=headers,
            auth=auth,
            timeout=_shipstation_timeout(),
        )
        resp.raise_for_status()
        return resp

    configured_carrier = cfg.get("carrier_code") or "ups_walleted"
    service_code = cfg.get("service_code") or None
    carriers_to_try: List[str] = [configured_carrier]

    if not carriers_to_try:
        raise IntegrationError("ShipStation carrier is not configured", status=400)

    collected_rates: List[Dict] = []
    last_error = None
    last_status = None
    last_response = None

    for carrier_code in carriers_to_try:
        payload = build_payload(carrier_code, service_code, strip_service=False)
        try:
            resp = attempt(payload)
            data = resp.json()
            if isinstance(data, list):
                collected_rates.extend(data)
            continue
        except requests.RequestException as exc:  # pragma: no cover
            data, status = _extract_response(exc)

            # Avoid doubling latency on timeouts by skipping the "strip serviceCode" retry.
            # (Timeouts typically indicate a slow/transient upstream, not a payload validation issue.)
            if isinstance(exc, requests.Timeout) and status is None:
                last_error = exc
                last_status = None
                last_response = None
                logger.error(
                    "ShipStation rate request timed out (carrier=%s, timeout=%s, payload=%s)",
                    carrier_code,
                    _shipstation_timeout(),
                    payload,
                    exc_info=True,
                )
                break

            if status == 402:
                _mark_unavailable(status, "payment_required")
                last_error = exc
                last_status = status
                last_response = data
                logger.error(
                    "ShipStation rate request failed (payment required)",
                    exc_info=True,
                    extra={"carrier": carrier_code, "status": status, "response": data},
                )
                break
            if status in (401, 403):
                _mark_unavailable(status, "unauthorized")
                last_error = exc
                last_status = status
                last_response = data
                logger.error(
                    "ShipStation rate request failed (unauthorized)",
                    exc_info=True,
                    extra={"carrier": carrier_code, "status": status, "response": data},
                )
                break

            # If we don't have an HTTP response status, we can't meaningfully "strip serviceCode"
            # to fix a payload validation issue. Preserve latency for downstream fallbacks.
            if status is None:
                last_error = exc
                last_status = None
                last_response = data
                logger.error(
                    "ShipStation rate request failed (no response) (carrier=%s, error=%s, payload=%s)",
                    carrier_code,
                    str(exc),
                    payload,
                    exc_info=True,
                )
                break

            logger.warning(
                "ShipStation rate request failed; retrying without serviceCode (carrier=%s, status=%s, response=%s, payload=%s)",
                carrier_code,
                status,
                data,
                payload,
                exc_info=True,
            )
            try:
                retry_payload = build_payload(carrier_code, service_code, strip_service=True)
                resp = attempt(retry_payload)
                data = resp.json()
                if isinstance(data, list):
                    collected_rates.extend(data)
                continue
            except requests.RequestException as retry_exc:  # pragma: no cover
                retry_data, retry_status = _extract_response(retry_exc)
                if retry_status == 402:
                    _mark_unavailable(retry_status, "payment_required")
                elif retry_status in (401, 403):
                    _mark_unavailable(retry_status, "unauthorized")
                last_error = retry_exc
                last_status = retry_status or status
                last_response = retry_data or data
                logger.error(
                    "ShipStation rate request failed after retry (carrier=%s, status=%s, response=%s, payload=%s)",
                    carrier_code,
                    retry_status,
                    retry_data,
                    retry_payload,
                    exc_info=True,
                )

    if collected_rates:
        return collected_rates

    raise IntegrationError(
        "Failed to retrieve ShipStation rates",
        response=last_response,
        status=last_status or 502,
    ) from last_error or None


def fetch_product_by_sku(sku: Optional[str]) -> Optional[Dict]:
    if not sku or not is_configured():
        return None

    headers, auth = _http_args()
    params = {
        "sku": sku.strip(),
        "includeInactive": "false",
        "pageSize": 1,
    }

    try:
        response = http_client.get(
            f"{API_BASE_URL}/products",
            params=params,
            headers=headers,
            auth=auth,
            timeout=_shipstation_timeout(),
        )
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - defensive logging
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.warning(
            "ShipStation product lookup failed",
            exc_info=False,
            extra={"sku": sku, "error": str(exc)},
        )
        raise IntegrationError("Failed to fetch ShipStation product", response=data) from exc

    payload = response.json() or {}
    products = payload.get("products") if isinstance(payload, dict) else None
    if isinstance(products, list) and products:
        product = products[0] or {}
        return {
            "id": product.get("productId") or product.get("product_id") or product.get("id"),
            "sku": product.get("sku") or sku,
            "name": product.get("name"),
            "stockOnHand": _coerce_inventory_number(
                product.get("onHand"),
                product.get("quantityOnHand"),
                product.get("quantity_on_hand"),
                product.get("stock"),
            ),
            "available": _coerce_inventory_number(
                product.get("available"),
                product.get("quantityAvailable"),
                product.get("quantity_available"),
            ),
        }
    return None


def fetch_order_status(order_number: Optional[str]) -> Optional[Dict]:
    """
    Retrieve ShipStation order details by order number to check fulfillment status/tracking.
    Returns a minimal dict or None if not found.
    """
    if not order_number or not is_configured():
        return None

    if _is_unavailable():
        return None

    normalized = str(order_number).strip()
    now = time.time()
    with _order_status_cache_lock:
        cached = _order_status_cache.get(normalized)
        if cached and float(cached.get("expiresAt") or 0) > now:
            return cached.get("value")  # type: ignore[return-value]

    headers, auth = _http_args()
    try:
        resp = http_client.get(
            f"{API_BASE_URL}/orders",
            params={"orderNumber": normalized, "pageSize": 1},
            headers=headers,
            auth=auth,
            timeout=_shipstation_timeout(),
        )
        resp.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - network path
        status_code = getattr(exc.response, "status_code", None)
        data = _extract_error_payload(exc)

        # ShipStation uses 402 when the account is past due / billing required. Treat this as
        # "integration temporarily unavailable" and avoid spamming logs or breaking order views.
        if status_code == 402:
            _mark_unavailable(status_code, "payment_required")
            _cache_order_status(normalized, None, ttl_seconds=_ORDER_STATUS_CACHE_TTL_SECONDS)
            return None

        # If the account is unauthorized/forbidden, pause lookups as well (typically config or access changes).
        if status_code in (401, 403):
            _mark_unavailable(status_code, "unauthorized")
            _cache_order_status(normalized, None, ttl_seconds=_ORDER_STATUS_CACHE_TTL_SECONDS)
            return None

        # Not found just means ShipStation doesn't know about this order; no need to warn.
        if status_code == 404:
            _cache_order_status(normalized, None, ttl_seconds=_ORDER_STATUS_CACHE_TTL_SECONDS)
            return None

        logger.warning(
            "ShipStation order lookup failed",
            exc_info=False,
            extra={"orderNumber": order_number, "status": status_code, "error": str(exc), "response": data},
        )
        _cache_order_status(normalized, None, ttl_seconds=_ORDER_STATUS_CACHE_TTL_SECONDS)
        return None

    payload = resp.json() or {}
    orders = payload.get("orders") if isinstance(payload, dict) else None
    if not orders:
        return None
    order = orders[0] or {}
    shipments = order.get("shipments") or []

    def _pick_tracking(entries):
        if not isinstance(entries, list):
            return None
        def extract(entry):
            if not entry:
                return None
            return entry.get("trackingNumber") or entry.get("tracking_number") or entry.get("tracking")
        # prefer non-voided first
        for entry in entries:
            if entry and entry.get("voided") is False:
                t = extract(entry)
                if t:
                    return t
        # fallback to any entry
        for entry in entries:
            t = extract(entry)
            if t:
                return t
        return None

    tracking = _pick_tracking(shipments) or order.get("trackingNumber")

    # If tracking still missing, query shipments endpoint as a fallback (covers voided labels too).
    if not tracking:
        try:
            shipment_resp = http_client.get(
                f"{API_BASE_URL}/shipments",
                params={"orderNumber": normalized, "page": 1, "pageSize": 5},
                headers=headers,
                auth=auth,
                timeout=_shipstation_timeout(),
            )
            shipment_resp.raise_for_status()
            shipment_payload = shipment_resp.json() or {}
            shipment_list = shipment_payload.get("shipments") if isinstance(shipment_payload, dict) else None
            tracking = _pick_tracking(shipment_list)
        except requests.RequestException:
            # non-fatal; just leave tracking as None
            pass

    result = {
        "status": order.get("orderStatus"),
        "shipDate": order.get("shipDate"),
        "trackingNumber": tracking,
        "carrierCode": order.get("carrierCode"),
        "serviceCode": order.get("serviceCode"),
        "orderNumber": order.get("orderNumber"),
        "orderId": order.get("orderId"),
    }
    with _order_status_cache_lock:
        _order_status_cache[normalized] = {
            "value": result,
            "expiresAt": now + _ORDER_STATUS_CACHE_TTL_SECONDS,
        }
    return result
