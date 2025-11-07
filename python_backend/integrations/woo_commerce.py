from __future__ import annotations

import logging
from typing import Dict, Optional, Mapping, Any
from uuid import uuid4

import requests
from requests.auth import HTTPBasicAuth

from ..services import get_config

logger = logging.getLogger(__name__)


class IntegrationError(RuntimeError):
    def __init__(self, message: str, response: Optional[Dict] = None):
        super().__init__(message)
        self.response = response


def is_configured() -> bool:
    config = get_config()
    data = config.woo_commerce
    return bool(data.get("store_url") and data.get("consumer_key") and data.get("consumer_secret"))


def build_line_items(items):
    line_items = []
    for item in items or []:
        quantity = item.get("quantity", 0)
        price = item.get("price", 0)
        total = f"{float(price) * float(quantity):.2f}"
        line_items.append(
            {
                "name": item.get("name"),
                "sku": item.get("productId"),
                "quantity": quantity,
                "total": total,
                "meta_data": [{"key": "note", "value": item.get("note")}] if item.get("note") else [],
            }
        )
    return line_items


def build_order_payload(order: Dict, customer: Dict) -> Dict:
    return {
        "status": "pending",
        "customer_note": f"Referral code used: {order.get('referralCode')}" if order.get("referralCode") else "",
        "set_paid": False,
        "line_items": build_line_items(order.get("items")),
        "meta_data": [
            {"key": "protixa_order_id", "value": order.get("id")},
            {"key": "protixa_total", "value": order.get("total")},
            {"key": "protixa_created_at", "value": order.get("createdAt")},
        ],
        "billing": {
            "first_name": customer.get("name") or "Protixa",
            "email": customer.get("email") or "orders@protixa.example",
        },
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

    base_url = config.woo_commerce.get("store_url", "").rstrip("/")
    api_version = config.woo_commerce.get("api_version", "wc/v3").lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/orders"

    try:
        response = requests.post(
            url,
            json=payload,
            auth=HTTPBasicAuth(config.woo_commerce["consumer_key"], config.woo_commerce["consumer_secret"]),
            timeout=10,
        )
        response.raise_for_status()
    except requests.RequestException as exc:
        data = None
        if exc.response is not None:
            try:
                data = exc.response.json()
            except Exception:  # pragma: no cover - best effort
                data = exc.response.text
        logger.error("Failed to create WooCommerce order", exc_info=True, extra={"orderId": order.get("id")})
        raise IntegrationError("WooCommerce order creation failed", response=data) from exc

    body = response.json()
    return {
        "status": "success",
        "payload": payload,
        "response": {
            "id": body.get("id"),
            "number": body.get("number"),
            "status": body.get("status"),
        },
    }


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
    base_url = (config.woo_commerce.get("store_url") or "").rstrip("/")
    api_version = (config.woo_commerce.get("api_version") or "wc/v3").lstrip("/")
    normalized = endpoint.lstrip("/")
    url = f"{base_url}/wp-json/{api_version}/{normalized}"

    try:
        response = requests.get(
            url,
            params=_sanitize_params(params or {}),
            auth=HTTPBasicAuth(config.woo_commerce["consumer_key"], config.woo_commerce["consumer_secret"]),
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
