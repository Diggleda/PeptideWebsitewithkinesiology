from __future__ import annotations

import logging
from typing import Dict, List, Optional

import requests

from ..services import get_config

logger = logging.getLogger(__name__)

API_BASE_URL = "https://ssapi.shipstation.com"


class IntegrationError(RuntimeError):
    def __init__(self, message: str, response: Optional[Dict] = None, status: int = 500):
        super().__init__(message)
        self.response = response
        self.status = status


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
    for item in items or []:
        total += float(item.get("quantity") or 0) * float(item.get("weightOz") or 0)
    return max(total, 8.0)


def _ship_from() -> Dict:
    cfg = get_config().ship_station.get("ship_from") or {}
    return {
        "city": cfg.get("city") or "",
        "state": cfg.get("state") or "",
        "postal_code": cfg.get("postal_code") or "",
        "country": cfg.get("country_code") or "US",
    }


def estimate_rates(shipping_address: Dict, items: List[Dict]) -> List[Dict]:
    if not is_configured():
        raise IntegrationError("ShipStation is not configured", status=503)

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
    payload = {
        "carrierCode": cfg.get("carrier_code") or None,
        "serviceCode": cfg.get("service_code") or None,
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

    # remove None values ShipStation rejects
    payload = {k: v for k, v in payload.items() if v not in (None, "", {})}

    try:
        response = requests.post(
            f"{API_BASE_URL}/shipments/getrates",
            json=payload,
            headers=headers,
            auth=auth,
            timeout=15,
        )
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.error("ShipStation rate request failed", exc_info=True)
        raise IntegrationError("Failed to retrieve ShipStation rates", response=data, status=502) from exc

    data = response.json()
    return data if isinstance(data, list) else []


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
        response = requests.get(
            f"{API_BASE_URL}/products",
            params=params,
            headers=headers,
            auth=auth,
            timeout=10,
        )
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - defensive logging
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.error("ShipStation product lookup failed", exc_info=True, extra={"sku": sku})
        raise IntegrationError("Failed to fetch ShipStation product", response=data) from exc

    payload = response.json() or {}
    products = payload.get("products") if isinstance(payload, dict) else None
    if isinstance(products, list) and products:
        product = products[0] or {}
        return {
            "id": product.get("productId") or product.get("product_id") or product.get("id"),
            "sku": product.get("sku") or sku,
            "name": product.get("name"),
            "stockOnHand": float(
                product.get("onHand")
                or product.get("quantityOnHand")
                or product.get("quantity_on_hand")
                or product.get("stock")
                or 0
            ),
            "available": float(
                product.get("available") or product.get("quantityAvailable") or product.get("quantity_available") or 0
            ),
        }
    return None
