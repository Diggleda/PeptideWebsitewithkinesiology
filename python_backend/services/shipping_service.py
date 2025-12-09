from __future__ import annotations

import json
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


def _text_contains_address_issue(text: Optional[str]) -> bool:
    if not text:
        return False
    lowered = text.lower()
    if "address" not in lowered:
        return False
    keywords = (
        "invalid",
        "not found",
        "unrecognized",
        "unable",
        "cannot",
        "unverified",
        "identified",
    )
    return any(keyword in lowered for keyword in keywords)


def _friendly_rate_error(message: str, response_payload, status: int) -> str:
    if status >= 500:
        return "Shipping provider is unavailable. Please try again in a moment."

    default = "Unable to calculate shipping for that address."
    if status == 400:
        return "Address cannot be identified."

    payload_text = ""
    if isinstance(response_payload, dict):
        try:
            payload_text = json.dumps(response_payload)
        except Exception:  # pragma: no cover - defensive
            payload_text = str(response_payload)
    elif isinstance(response_payload, str):
        payload_text = response_payload

    if _text_contains_address_issue(payload_text) or _text_contains_address_issue(
        message
    ):
        return "Address cannot be identified."

    if "<html" in (payload_text or "").lower():
        return default

    cleaned = (message or "").strip()
    if cleaned and "<" in cleaned and ">" in cleaned:
        return default

    if cleaned:
        return cleaned

    return default


def _normalize_string(value) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_country(value) -> str:
    if value is None:
        return "US"
    text = str(value).strip()
    if not text:
        return "US"
    lowered = text.lower()
    if lowered in (
        "us",
        "usa",
        "u.s.",
        "u.s.a.",
        "united states",
        "united states of america",
        "america",
    ):
        return "US"
    if lowered in ("ca", "canada"):
        return "CA"
    if len(text) == 2:
        return text.upper()
    return text[:2].upper()


def _normalize_state(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text:
        return ""
    states = {
        "alabama": "AL",
        "alaska": "AK",
        "arizona": "AZ",
        "arkansas": "AR",
        "california": "CA",
        "colorado": "CO",
        "connecticut": "CT",
        "delaware": "DE",
        "district of columbia": "DC",
        "florida": "FL",
        "georgia": "GA",
        "hawaii": "HI",
        "idaho": "ID",
        "illinois": "IL",
        "indiana": "IN",
        "iowa": "IA",
        "kansas": "KS",
        "kentucky": "KY",
        "louisiana": "LA",
        "maine": "ME",
        "maryland": "MD",
        "massachusetts": "MA",
        "michigan": "MI",
        "minnesota": "MN",
        "mississippi": "MS",
        "missouri": "MO",
        "montana": "MT",
        "nebraska": "NE",
        "nevada": "NV",
        "new hampshire": "NH",
        "new jersey": "NJ",
        "new mexico": "NM",
        "new york": "NY",
        "north carolina": "NC",
        "north dakota": "ND",
        "ohio": "OH",
        "oklahoma": "OK",
        "oregon": "OR",
        "pennsylvania": "PA",
        "rhode island": "RI",
        "south carolina": "SC",
        "south dakota": "SD",
        "tennessee": "TN",
        "texas": "TX",
        "utah": "UT",
        "vermont": "VT",
        "virginia": "VA",
        "washington": "WA",
        "west virginia": "WV",
        "wisconsin": "WI",
        "wyoming": "WY",
    }
    lowered = text.lower()
    if lowered in states:
        return states[lowered]
    if len(text) == 2:
        return text.upper()
    return text[:2].upper()


def _sanitize_address(raw: Dict) -> Dict:
    return {
        "name": _normalize_string(raw.get("name")) or None,
        "company": _normalize_string(raw.get("company")) or None,
        "addressLine1": _normalize_string(raw.get("addressLine1")),
        "addressLine2": _normalize_string(raw.get("addressLine2")),
        "city": _normalize_string(raw.get("city")),
        "state": _normalize_state(raw.get("state")),
        "postalCode": _normalize_string(raw.get("postalCode")),
        "country": _normalize_country(raw.get("country")),
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
        length = _coerce_positive_number(
            item.get("length")
            or item.get("lengthIn")
            or item.get("l")
        )
        width = _coerce_positive_number(
            item.get("width")
            or item.get("widthIn")
            or item.get("w")
        )
        height = _coerce_positive_number(
            item.get("height")
            or item.get("heightIn")
            or item.get("h")
        )
        try:
            quantity = float(item.get("quantity") or 0)
            weight = float(item.get("weightOz") or 0)
        except (TypeError, ValueError):
            quantity = 0
            weight = 0
        if quantity <= 0:
            continue
        normalized.append(
            {
                "quantity": quantity,
                "weightOz": max(weight, 0),
                "length": length,
                "width": width,
                "height": height,
            }
        )
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


def _coerce_positive_number(value) -> Optional[float]:
    if value in (None, "", False):
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None
    return numeric if numeric > 0 else None


def _extract_dimensions(rate: Dict) -> Optional[Dict]:
    raw = rate.get("dimensions") or rate.get("packageDimensions") or {}
    if not isinstance(raw, dict):
        return None
    length = _coerce_positive_number(
        raw.get("length")
        or raw.get("lengthIn")
        or raw.get("l")
    )
    width = _coerce_positive_number(
        raw.get("width")
        or raw.get("widthIn")
        or raw.get("w")
    )
    height = _coerce_positive_number(
        raw.get("height")
        or raw.get("heightIn")
        or raw.get("h")
    )
    if not (length and width and height):
        return None
    return {
        "length": round(length, 3),
        "width": round(width, 3),
        "height": round(height, 3),
    }


def _normalize_rates(raw_rates: List[Dict], fingerprint: str) -> List[Dict]:
    normalized = []
    for rate in raw_rates or []:
        amount, currency = _extract_amount(rate)
        if amount is None:
            continue
        package_code = (
            rate.get("packageCode")
            or rate.get("package_code")
            or rate.get("packageType")
            or rate.get("package")
        )
        weight_block = rate.get("weight") or {}
        weight_value = None
        if isinstance(weight_block, dict):
            weight_value = _coerce_positive_number(
                weight_block.get("value") or weight_block.get("weight")
            )
        else:
            weight_value = _coerce_positive_number(
                rate.get("weightOz")
                or rate.get("weight_oz")
                or rate.get("weight")
            )
        dimensions = _extract_dimensions(rate)
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
                    "packageType": rate.get("packageType")
                    or rate.get("package_type")
                    or rate.get("packageCode"),
                },
                "packageCode": package_code,
                "packageDimensions": dimensions,
                "weightOz": weight_value,
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
    shipstation_error = None
    if shipstation_cfg:
        logger.info("Using ShipStation for rate estimate", extra={"address_fingerprint": fingerprint})
        try:
            raw_rates = ship_station.estimate_rates(address, normalized_items)
        except ship_station.IntegrationError as exc:
            shipstation_error = exc
            logger.error("ShipStation rate estimate failed", exc_info=True)
            if shipengine_cfg:
                logger.info("Falling back to ShipEngine after ShipStation error", extra={"address_fingerprint": fingerprint})

    if raw_rates is None and shipengine_cfg:
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
            friendly = _friendly_rate_error(error_message, getattr(exc, "response", None), getattr(exc, "status", 502))
            raise ShippingError(friendly, status=getattr(exc, "status", 502)) from exc
    elif raw_rates is None and not shipstation_cfg:
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
    elif raw_rates is None and shipstation_error:
        friendly = _friendly_rate_error(
            str(shipstation_error),
            getattr(shipstation_error, "response", None),
            getattr(shipstation_error, "status", 502),
        )
        logger.warning(
            "ShipStation unavailable; returning graceful error payload",
            extra={
                "address_fingerprint": fingerprint,
                "status": getattr(shipstation_error, "status", 502),
            },
        )
        return {
            "success": False,
            "rates": [],
            "addressFingerprint": fingerprint,
            "error": friendly,
            "provider": "shipstation",
        }

    rates = _normalize_rates(raw_rates or [], fingerprint)

    return {
        "success": True,
        "rates": rates,
        "addressFingerprint": fingerprint,
    }
