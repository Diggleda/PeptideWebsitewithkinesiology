from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

import requests

from ..services import settings_service

logger = logging.getLogger(__name__)


class StripeTaxError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int = 502,
        code: str = "STRIPE_TAX_ERROR",
        details: Optional[Dict[str, Any]] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}


def _normalize_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _as_cents(amount: Any) -> int:
    try:
        numeric = float(amount or 0)
    except Exception:
        numeric = 0.0
    return max(int(round(numeric * 100)), 0)


def _default_tax_code() -> str:
    return _normalize_str(os.environ.get("STRIPE_TAX_CODE")) or "txcd_99999999"


def _shipping_tax_code() -> str:
    return _normalize_str(os.environ.get("STRIPE_TAX_SHIPPING_CODE")) or "txcd_92010001"


def _tax_debug_enabled() -> bool:
    return (os.environ.get("STRIPE_TAX_DEBUG") or "").strip().lower() in ("1", "true", "yes", "on")


def _build_tax_calculation_form(
    *,
    currency: str,
    items: List[Dict[str, Any]],
    shipping_address: Dict[str, Any],
    shipping_total: Any,
    default_tax_code: str,
    shipping_tax_code: str,
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    address = shipping_address or {}
    normalized_address = {
        "line1": _normalize_str(address.get("addressLine1") or address.get("address1")),
        "line2": _normalize_str(address.get("addressLine2") or address.get("address2")),
        "city": _normalize_str(address.get("city")),
        "state": _normalize_str(address.get("state")),
        "postal_code": _normalize_str(address.get("postalCode") or address.get("postcode") or address.get("zip")),
        "country": _normalize_str(address.get("country")) or "US",
    }

    form: Dict[str, Any] = {
        "currency": currency,
        "customer_details[address_source]": "shipping",
        "customer_details[address][line1]": normalized_address["line1"] or "",
        "customer_details[address][line2]": normalized_address["line2"] or "",
        "customer_details[address][city]": normalized_address["city"] or "",
        "customer_details[address][state]": normalized_address["state"] or "",
        "customer_details[address][postal_code]": normalized_address["postal_code"] or "",
        "customer_details[address][country]": normalized_address["country"] or "US",
    }

    line_items: List[Dict[str, Any]] = []
    for idx, item in enumerate(items or []):
        unit_price = float(item.get("price") or 0)
        quantity = float(item.get("quantity") or 0)
        amount_cents = _as_cents(unit_price * quantity)
        if amount_cents <= 0:
            continue
        reference = _normalize_str(item.get("productId") or item.get("id") or item.get("sku")) or f"line_{idx+1}"
        line_items.append(
            {
                "amount": amount_cents,
                "reference": reference,
                "tax_code": default_tax_code,
            }
        )

    for idx, line in enumerate(line_items):
        form[f"line_items[{idx}][amount]"] = line["amount"]
        form[f"line_items[{idx}][reference]"] = line["reference"]
        form[f"line_items[{idx}][tax_code]"] = line["tax_code"]

    shipping_cents = _as_cents(shipping_total)
    if shipping_cents > 0:
        form["shipping_cost[amount]"] = shipping_cents
        form["shipping_cost[tax_code]"] = shipping_tax_code

    debug_payload = {
        "currency": currency,
        "line_items": line_items,
        "shipping_amount_cents": shipping_cents,
        "default_tax_code": default_tax_code,
        "shipping_tax_code": shipping_tax_code,
        "destination": normalized_address,
    }
    return form, debug_payload


def calculate_tax_amount(
    *,
    items: List[Dict[str, Any]],
    shipping_address: Dict[str, Any],
    shipping_total: Any,
    currency: str = "usd",
) -> Dict[str, Any]:
    secret_key = settings_service.resolve_stripe_secret_key()
    if not secret_key:
        raise StripeTaxError("Stripe secret key is not configured", status=500)

    default_tax_code = _default_tax_code()
    shipping_tax_code = _shipping_tax_code()
    tax_debug = _tax_debug_enabled()

    form, debug_payload = _build_tax_calculation_form(
        currency=currency,
        items=items,
        shipping_address=shipping_address,
        shipping_total=shipping_total,
        default_tax_code=default_tax_code,
        shipping_tax_code=shipping_tax_code,
    )

    if tax_debug:
        logger.info("Stripe Tax request payload %s", debug_payload)

    if not any(key.startswith("line_items[") for key in form.keys()):
        err = StripeTaxError("Stripe tax calculation requires at least one line item", status=400)
        raise err

    try:
        response = requests.post(
            "https://api.stripe.com/v1/tax/calculations",
            data=form,
            auth=(secret_key, ""),
            timeout=20,
        )
    except Exception as exc:  # pragma: no cover
        raise StripeTaxError("Stripe Tax request failed", details={"exception": str(exc)}) from exc

    payload: Dict[str, Any] = {}
    try:
        payload = response.json() or {}
    except Exception:
        payload = {}

    if response.status_code >= 400:
        message = None
        if isinstance(payload, dict):
            error = payload.get("error") or {}
            if isinstance(error, dict):
                message = error.get("message")
        raise StripeTaxError(
            message or "Stripe Tax calculation failed",
            status=400 if response.status_code < 500 else 502,
            details={"status": response.status_code, "response": payload or None},
        )

    tax_exclusive = payload.get("tax_amount_exclusive")
    tax_inclusive = payload.get("tax_amount_inclusive")
    tax_total_cents = tax_exclusive if isinstance(tax_exclusive, int) else (tax_inclusive if isinstance(tax_inclusive, int) else 0)

    result = {
        "tax_total_cents": int(tax_total_cents or 0),
        "calculation_id": payload.get("id"),
    }

    if tax_debug:
        logger.info("Stripe Tax calculation result %s", {**result, "tax_amount_exclusive": tax_exclusive, "tax_amount_inclusive": tax_inclusive})

    return result

