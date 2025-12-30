from __future__ import annotations

import logging
from typing import Dict, List, Optional

import requests

from ..services import get_config
from ..utils import http_client

logger = logging.getLogger(__name__)

API_BASE_URL = "https://api.shipengine.com/v1"


class IntegrationError(RuntimeError):
    def __init__(self, message: str, response: Optional[Dict] = None):
        super().__init__(message)
        self.response = response


def is_configured() -> bool:
    return bool(get_config().ship_engine.get("api_key"))


def _has_shipping_address(order: Dict) -> bool:
    shipping = order.get("shippingAddress") or {}
    return bool(shipping.get("postalCode"))


def build_shipment_payload(order: Dict, customer: Dict) -> Optional[Dict]:
    if not _has_shipping_address(order):
        return None

    shipping = order.get("shippingAddress") or {}
    total_weight = 0.0
    for item in order.get("items") or []:
        weight = float(item.get("weightOz") or 0)
        quantity = float(item.get("quantity") or 0)
        total_weight += weight * quantity

    config = get_config()
    return {
        "service_code": config.ship_engine.get("default_service_code") or "usps_priority_mail",
        "ship_to": {
            "name": customer.get("name") or "PepPro Customer",
            "phone": customer.get("phone") or "",
            "email": customer.get("email") or "",
            "address_line1": shipping.get("addressLine1"),
            "address_line2": shipping.get("addressLine2") or "",
            "city_locality": shipping.get("city"),
            "state_province": shipping.get("state"),
            "postal_code": shipping.get("postalCode"),
            "country_code": shipping.get("country") or "US",
        },
        "ship_from": {
            "name": config.ship_engine.get("ship_from_name") or "PepPro Fulfillment",
            "address_line1": config.ship_engine.get("ship_from_address1") or "",
            "address_line2": config.ship_engine.get("ship_from_address2") or "",
            "city_locality": config.ship_engine.get("ship_from_city") or "",
            "state_province": config.ship_engine.get("ship_from_state") or "",
            "postal_code": config.ship_engine.get("ship_from_postal_code") or "",
            "country_code": config.ship_engine.get("ship_from_country") or "US",
        },
        "packages": [
            {
                "package_code": "package",
                "weight": {
                    "value": total_weight if total_weight > 0 else 16,
                    "unit": "ounce",
                },
            }
        ],
        "external_order_id": order.get("id"),
    }


def forward_shipment(order: Dict, customer: Dict) -> Dict:
    if not is_configured():
        return {"status": "skipped", "reason": "not_configured"}

    payload = build_shipment_payload(order, customer)
    if not payload:
        return {"status": "skipped", "reason": "missing_shipping_address"}

    config = get_config()
    if not config.ship_engine.get("auto_create_labels"):
        return {"status": "pending", "reason": "auto_create_disabled", "payload": payload}

    headers = {
        "Content-Type": "application/json",
        "API-Key": config.ship_engine["api_key"],
    }

    try:
        response = http_client.post(f"{API_BASE_URL}/labels", json=payload, headers=headers, timeout=10)
        response.raise_for_status()
    except requests.RequestException as exc:
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:  # pragma: no cover
                data = exc.response.text
        logger.error("Failed to create ShipEngine label", exc_info=True, extra={"orderId": order.get("id")})
        raise IntegrationError("ShipEngine label creation failed", response=data) from exc

    body = response.json()
    return {
        "status": "success",
        "payload": payload,
        "response": {
            "labelId": body.get("label_id"),
            "status": body.get("status"),
            "trackingNumber": body.get("tracking_number"),
        },
    }


def estimate_rates(address: Dict, total_weight_oz: float) -> List[Dict]:
    if not is_configured():
        raise IntegrationError("ShipEngine is not configured")

    config = get_config()
    headers = {
        "Content-Type": "application/json",
        "API-Key": config.ship_engine["api_key"],
    }

    payload = {
        "carrier_ids": [config.ship_engine.get("default_carrier_id")] if config.ship_engine.get("default_carrier_id") else None,
        "service_code": config.ship_engine.get("default_service_code") or None,
        "from_country_code": config.ship_engine.get("ship_from_country") or "US",
        "from_postal_code": config.ship_engine.get("ship_from_postal_code") or "",
        "from_city_locality": config.ship_engine.get("ship_from_city") or "",
        "from_state_province": config.ship_engine.get("ship_from_state") or "",
        "to_country_code": address.get("country"),
        "to_postal_code": address.get("postalCode"),
        "to_city_locality": address.get("city"),
        "to_state_province": address.get("state"),
        "packages": [
            {
                "weight": {
                    "value": max(total_weight_oz, 1.0),
                    "unit": "ounce",
                },
            }
        ],
    }

    # Remove empty values that ShipEngine rejects
    payload = {key: value for key, value in payload.items() if value not in (None, "", [])}

    try:
        response = http_client.post(f"{API_BASE_URL}/rates/estimate", json=payload, headers=headers, timeout=10)
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - network errors
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:  # pragma: no cover
                data = exc.response.text
        raise IntegrationError("Failed to estimate ShipEngine rates", response=data) from exc

    body = response.json()
    rates = body.get("rate_response", {}).get("rates")
    if rates is None and isinstance(body, dict):
        rates = body.get("rates")
    return rates or []
