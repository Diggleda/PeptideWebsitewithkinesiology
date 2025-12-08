from __future__ import annotations

import logging
from datetime import datetime
import re
from typing import Dict, Optional, Mapping, Any, List
from uuid import uuid4

import requests
from requests.auth import HTTPBasicAuth
from urllib.parse import quote

from ..services import get_config

logger = logging.getLogger(__name__)


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


def build_line_items(items):
    line_items = []
    for item in items or []:
        quantity = int(item.get("quantity", 0) or 0)
        price = float(item.get("price", 0))
        total = f"{price * quantity:.2f}"
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
        line = {
            "name": item.get("name"),
            "sku": resolved_sku or None,
            "quantity": quantity,
            "product_id": product_id,
            # Woo keeps our explicit totals; also helps ShipStation export items.
            "price": f"{price:.2f}",
            "total": total,
            "subtotal": total,
            "total_tax": "0",
            "subtotal_tax": "0",
            "meta_data": [{"key": "note", "value": item.get("note")}] if item.get("note") else [],
        }
        # Include variation when available so Woo export/ShipStation can map items.
        if variation_id is not None:
            line["variation_id"] = variation_id
        line_items.append(line)
    return line_items


def build_order_payload(order: Dict, customer: Dict) -> Dict:
    # Optional referral credit applied at checkout (negative fee)
    applied_credit = float(order.get("appliedReferralCredit") or 0) or 0.0
    fee_lines = []
    discount_total = "0"
    if applied_credit > 0:
        discount_total = f"-{applied_credit:.2f}"

    shipping_total = float(order.get("shippingTotal") or 0) or 0.0
    shipping_lines = []
    shipping_estimate = order.get("shippingEstimate") or {}
    method_code = shipping_estimate.get("serviceCode") or shipping_estimate.get("serviceType") or "flat_rate"
    method_title = shipping_estimate.get("serviceType") or shipping_estimate.get("serviceCode") or "Shipping"
    shipping_lines.append(
        {
            "method_id": method_code,
            "method_title": method_title,
            "total": f"{shipping_total:.2f}",
        }
    )

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

    return {
        "status": "pending",
        "customer_note": f"Referral code used: {order.get('referralCode')}" if order.get("referralCode") else "",
        "set_paid": False,
        "line_items": build_line_items(order.get("items")),
        "fee_lines": fee_lines,
        "shipping_lines": shipping_lines,
        "discount_total": discount_total,
        "meta_data": [
            {"key": "peppro_order_id", "value": order.get("id")},
            {"key": "peppro_total", "value": order.get("total")},
            {"key": "peppro_created_at", "value": order.get("createdAt")},
            {"key": "peppro_shipping_total", "value": shipping_total},
            {"key": "peppro_shipping_service", "value": shipping_estimate.get("serviceType") or shipping_estimate.get("serviceCode")},
            {"key": "peppro_shipping_carrier", "value": shipping_estimate.get("carrierId")},
            {"key": "peppro_physician_certified", "value": order.get("physicianCertificationAccepted")},
        ],
        "billing": billing_address,
        "shipping": shipping_address,
    }


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

    try:
        response = requests.post(
            url,
            json=payload,
            auth=HTTPBasicAuth(
                _strip(config.woo_commerce.get("consumer_key")),
                _strip(config.woo_commerce.get("consumer_secret")),
            ),
            timeout=10,
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
                f"WOO_COMMERCE_ERROR status={status_code} json={data} text={response_text} payload={payload}",
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
    return {
        "status": "success",
        "payload": payload,
        "response": {
            "id": body.get("id"),
            "number": body.get("number"),
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
    timeout_seconds = get_config().woo_commerce.get("request_timeout_seconds") or 25
    now_iso = datetime.utcnow().isoformat()
    try:
        response = requests.put(
            url,
            json={
                "status": "processing",
                "set_paid": True,
                "payment_method": "stripe",
                "payment_method_title": "Stripe Onsite",
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
        raise IntegrationError("WooCommerce is not configured")

    config = get_config()
    base_url = _strip(config.woo_commerce.get("store_url") or "").rstrip("/")
    api_version = _strip(config.woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    normalized = endpoint.lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/{normalized}"

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
        response.raise_for_status()
        # Try JSON; fall back to text if necessary.
        try:
            return response.json()
        except ValueError:
            return response.text
    except requests.RequestException as exc:  # pragma: no cover - network error path
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:
                data = exc.response.text
        logger.error("WooCommerce catalog fetch failed", exc_info=True, extra={"endpoint": endpoint})
        err = IntegrationError("WooCommerce catalog request failed", response=data)
        setattr(err, "status", getattr(exc.response, "status_code", 502) if exc.response else 502)
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
    return f"{base}/my-account/view-order/{safe_id}/?order={safe_id}&key={safe_key}"


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
    identifier = public_number or f"woo-{uuid4().hex[:8]}"

    if not public_number:
        # Trace situations where we fall back to a generated identifier.
        try:
            logger.debug(
                "Woo map summary missing number/id; using fallback",
                extra={"raw_id": raw_id, "raw_number": raw_number, "fallback_identifier": identifier},
            )
        except Exception:
            pass

    mapped = {
        "id": identifier,
        "wooOrderId": woo_order_id or identifier,
        "wooOrderNumber": public_number or identifier,
        "number": public_number or identifier,
        "status": order.get("status"),
        "total": _num(order.get("total"), _num(order.get("total_ex_tax"), 0.0)),
        "currency": order.get("currency") or "USD",
        "paymentMethod": order.get("payment_method_title") or order.get("payment_method"),
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
            }
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
    return mapped


def fetch_orders_by_email(email: str, per_page: int = 15) -> Any:
    if not email or not is_configured():
        return []
    trimmed = email.strip().lower()
    if not trimmed:
        return []

    size = max(1, min(per_page, 50))
    try:
        response = fetch_catalog("orders", {"per_page": size, "orderby": "date", "order": "desc"})
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
    except IntegrationError:
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
