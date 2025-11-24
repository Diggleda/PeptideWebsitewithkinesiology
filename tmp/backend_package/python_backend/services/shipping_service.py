from __future__ import annotations

import hashlib
import logging
from typing import Dict, List, Optional, Tuple

from . import get_config
from ..integrations import ship_engine, ship_station

logger = logging.getLogger(__name__)


class ShippingError(RuntimeError):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _normalize_string(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _sanitize_address(raw: Dict) -> Dict:
    return {
        "name": _normalize_string(raw.get("name")) or None,
        "company": _normalize_string(raw.get("company")) or None,
        "addressLine1": _normalize_string(raw.get("addressLine1")),
        "addressLine2": _normalize_string(raw.get("addressLine2")),
        "city": _normalize_string(raw.get("city")),
        "state": _normalize_string(raw.get("state")),
        "postalCode": _normalize_string(raw.get("postalCode")),
        "country": _normalize_string(raw.get("country")) or "US",
        "phone": _normalize_string(raw.get("phone")) or None,
    }


def _ensure_address(raw: Dict) -> Dict:
    if not isinstance(raw, dict):
        raise ShippingError("Shipping address is required")
    sanitized = _sanitize_address(raw)
    required_fields = [
        sanitized["addressLine1"],
        sanitized["city"],
        sanitized["state"],
        sanitized["postalCode"],
        sanitized["country"],
    ]
    if not all(required_fields):
        raise ShippingError("Shipping address must include street, city, state, postal code, and country")
    return sanitized


def _normalize_items(raw_items) -> List[Dict]:
    normalized: List[Dict] = []
    if not isinstance(raw_items, list):
        return normalized
    for item in raw_items:
        try:
            quantity = float(item.get("quantity") or 0)
            weight = float(item.get("weightOz") or 0)
        except (TypeError, ValueError):
            quantity = 0
            weight = 0
        if quantity <= 0:
            continue
        normalized.append({"quantity": quantity, "weightOz": max(weight, 0)})
    return normalized


def _total_weight(items: List[Dict]) -> float:
    weight = 0.0
    for item in items:
        weight += item["quantity"] * item["weightOz"]
    return max(weight, 8.0)


def _create_fingerprint(address: Dict) -> str:
    parts = [
        address.get("addressLine1"),
        address.get("addressLine2"),
        address.get("city"),
        address.get("state"),
        address.get("postalCode"),
        address.get("country"),
    ]
    data = "|".join((part or "").upper() for part in parts)
    return hashlib.sha1(data.encode("utf-8")).hexdigest()


def _extract_amount(rate: Dict) -> Tuple[Optional[float], str]:
    def to_float(value):
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    currency = "USD"
    amount_block = (
        rate.get("shipping_amount")
        or rate.get("shippingAmount")
        or rate.get("amount")
    )
    amount = None
    if isinstance(amount_block, dict):
        amount = to_float(amount_block.get("amount") or amount_block.get("value"))
        currency = amount_block.get("currency") or currency
    else:
        amount = to_float(amount_block)

    if amount is None:
        amount = to_float(
            rate.get("shipmentCost")
            or rate.get("rate")
            or rate.get("shipCost")
        )

    if not currency:
        currency = rate.get("currency") or "USD"

    return amount, currency


def _normalize_rates(raw_rates: List[Dict], fingerprint: str) -> List[Dict]:
    normalized = []
    for rate in raw_rates or []:
        amount, currency = _extract_amount(rate)
        if amount is None:
            continue
        normalized.append(
            {
                "carrierId": rate.get("carrierId")
                or rate.get("carrier_id")
                or rate.get("carrierCode")
                or rate.get("carrier_code"),
                "serviceCode": rate.get("serviceCode")
                or rate.get("service_code"),
                "serviceType": rate.get("serviceType")
                or rate.get("service_type")
                or rate.get("serviceCode"),
                "estimatedDeliveryDays": rate.get("estimatedDeliveryDays")
                or rate.get("delivery_days")
                or rate.get("deliveryDays"),
                "deliveryDateGuaranteed": rate.get("deliveryDateGuaranteed")
                or rate.get("guaranteed_service")
                or rate.get("guaranteedDeliveryDate"),
                "rate": amount,
                "currency": currency,
                "addressFingerprint": fingerprint,
                "meta": {
                    "carrierFriendlyName": rate.get("carrier_friendly_name")
                    or rate.get("carrierFriendlyName"),
                    "serviceDescription": rate.get("service_description")
                    or rate.get("serviceDescription"),
                },
            }
        )
    return normalized


def get_rates(shipping_address: Dict, items) -> Dict:
    address = _ensure_address(shipping_address or {})
    normalized_items = _normalize_items(items or [])
    if not normalized_items:
        raise ShippingError("At least one item with quantity is required to price shipping")

    fingerprint = _create_fingerprint(address)
    total_weight = _total_weight(normalized_items)

    shipstation_cfg = ship_station.is_configured(log=True)
    shipengine_cfg = ship_engine.is_configured()

    logger.debug(
        "Shipping rate request",
        extra={
            "shipstation_configured": shipstation_cfg,
            "shipengine_configured": shipengine_cfg,
            "address_fingerprint": fingerprint,
            "total_weight_oz": total_weight,
        },
    )

    raw_rates = None
    if shipstation_cfg:
        logger.info("Using ShipStation for rate estimate", extra={"address_fingerprint": fingerprint})
        try:
            raw_rates = ship_station.estimate_rates(address, normalized_items)
        except ship_station.IntegrationError as exc:
            logger.error("ShipStation rate estimate failed", exc_info=True)
            raise ShippingError(str(exc), status=getattr(exc, "status", 502)) from exc
    elif shipengine_cfg:
        logger.info("Using ShipEngine for rate estimate", extra={"address_fingerprint": fingerprint})
        try:
            raw_rates = ship_engine.estimate_rates(address, total_weight)
        except ship_engine.IntegrationError as exc:
            logger.error("ShipEngine rate estimate failed", exc_info=True)
            error_message = "Failed to retrieve shipping rates"
            if isinstance(exc.response, dict):
                errors = exc.response.get("errors") or exc.response.get("message")
                if errors:
                    if isinstance(errors, list):
                        error_message = errors[0].get("message") or error_message
                    elif isinstance(errors, str):
                        error_message = errors
            raise ShippingError(error_message, status=502) from exc
    else:
        cfg = get_config()
        logger.warning(
            "Shipping is not configured (both providers disabled/missing credentials)",
            extra={
                "shipstation_config": cfg.ship_station,
                "shipengine_configured": shipengine_cfg,
            },
        )
        raise ShippingError(
            "Shipping is not configured (ShipStation and ShipEngine are both disabled/missing credentials)",
            status=503,
        )

    rates = _normalize_rates(raw_rates or [], fingerprint)

    return {
        "success": True,
        "rates": rates,
        "addressFingerprint": fingerprint,
    }
