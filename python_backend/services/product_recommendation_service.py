from __future__ import annotations

import math
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Set

from ..repositories import (
    order_repository,
    physician_product_event_repository,
    user_repository,
)
from . import catalog_snapshot_service

MODEL_VERSION = "heuristic-v1"
RECOMMENDATION_REASON_LABELS = {
    "repeat_purchase": "repeat_purchase",
    "cart_intent": "cart_intent",
    "view_intent": "view_intent",
    "category_affinity": "category_affinity",
    "tag_affinity": "tag_affinity",
    "similar_physicians": "similar_physicians",
    "global_popularity": "global_popularity",
}
ALLOWED_EVENT_TYPES = {
    "product_view",
    "add_to_cart",
    "cart_remove",
    "checkout_open",
    "purchase",
}


def _enabled() -> bool:
    raw = str(os.environ.get("RECOMMENDATIONS_ENABLED", "true")).strip().lower()
    return raw not in {"0", "false", "no", "off", "disabled"}


def _normalize_role(role: object) -> str:
    return re.sub(r"[\s-]+", "_", str(role or "").strip().lower())


def _is_physician_role(role: object) -> bool:
    return _normalize_role(role) in {"doctor", "test_doctor"}


def _service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err


def _parse_positive_int(value: object) -> Optional[int]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        try:
            parsed = int(value)
        except Exception:
            return None
        return parsed if parsed > 0 else None
    text = str(value or "").strip()
    if not text:
        return None
    if text.isdigit():
        parsed = int(text)
        return parsed if parsed > 0 else None
    for pattern in (
        r"^woo-(\d+)$",
        r"^woo-product-(\d+)$",
        r"^product-(\d+)$",
    ):
        match = re.match(pattern, text, flags=re.IGNORECASE)
        if match:
            parsed = int(match.group(1))
            return parsed if parsed > 0 else None
    return None


def _parse_positive_variation_id(value: object) -> Optional[int]:
    parsed = _parse_positive_int(value)
    if parsed is not None:
        return parsed
    text = str(value or "").strip()
    match = re.match(r"^woo-variation-(\d+)$", text, flags=re.IGNORECASE)
    if match:
        parsed = int(match.group(1))
        return parsed if parsed > 0 else None
    return None


def _normalize_filter_key(value: object) -> str:
    return re.sub(
        r"^-+|-+$",
        "",
        re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().lower().replace("&", "and")),
    )


def _contains_subscription(value: object) -> bool:
    return "subscription" in str(value or "").strip().lower()


def _catalog_categories(product: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = product.get("categories")
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _catalog_tags(product: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = product.get("tags")
    return [item for item in raw if isinstance(item, dict)] if isinstance(raw, list) else []


def _is_excluded_catalog_product(product: Dict[str, Any]) -> bool:
    status = str(product.get("status") or "").strip().lower()
    if status and status != "publish":
        return True
    if _contains_subscription(product.get("type")) or _contains_subscription(product.get("name")):
        return True
    for category in _catalog_categories(product):
        name = category.get("name")
        slug = category.get("slug")
        if _contains_subscription(name) or _contains_subscription(slug):
            return True
        if _normalize_filter_key(name) == "add-on" or _normalize_filter_key(slug) == "add-on":
            return True
    for field in ("sku", "slug"):
        if _normalize_filter_key(product.get(field)) == "add-on":
            return True
    return False


def _load_catalog_candidates() -> Dict[int, Dict[str, Any]]:
    candidates: Dict[int, Dict[str, Any]] = {}
    page = 1
    while page <= 25:
        try:
            batch = catalog_snapshot_service.get_catalog_products(page=page, per_page=200)
        except Exception:
            break
        if not isinstance(batch, list) or not batch:
            break
        for product in batch:
            if not isinstance(product, dict):
                continue
            woo_id = _parse_positive_int(product.get("id"))
            if woo_id is None or _is_excluded_catalog_product(product):
                continue
            category_keys = {
                _normalize_filter_key(category.get("name") or category.get("slug"))
                for category in _catalog_categories(product)
            }
            tag_keys = {
                _normalize_filter_key(tag.get("slug") or tag.get("name"))
                for tag in _catalog_tags(product)
            }
            candidates[woo_id] = {
                "wooProductId": woo_id,
                "productId": f"woo-{woo_id}",
                "sku": str(product.get("sku") or "").strip() or None,
                "name": str(product.get("name") or "").strip() or None,
                "categoryKeys": {value for value in category_keys if value},
                "tagKeys": {value for value in tag_keys if value},
            }
        if len(batch) < 200:
            break
        page += 1
    return candidates


def _parse_datetime(value: object) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(text)
    except Exception:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _order_created_at(order: Dict[str, Any]) -> Optional[datetime]:
    return _parse_datetime(order.get("createdAt") or order.get("created_at") or order.get("dateCreated"))


def _iter_order_items(order: Dict[str, Any]) -> Iterable[Dict[str, Any]]:
    raw = order.get("items")
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                yield item
    raw_line_items = order.get("lineItems") or order.get("line_items")
    if isinstance(raw_line_items, list):
        for item in raw_line_items:
            if isinstance(item, dict):
                yield item


def _item_sku(item: Dict[str, Any]) -> Optional[str]:
    text = str(item.get("sku") or item.get("variantSku") or "").strip()
    return text or None


def _resolve_item_product_id(item: Dict[str, Any], sku_to_product_id: Dict[str, int]) -> Optional[int]:
    for key in ("wooProductId", "woo_product_id", "productWooId", "product_woo_id", "productId", "product_id", "id"):
        parsed = _parse_positive_int(item.get(key))
        if parsed is not None:
            return parsed
    sku = _item_sku(item)
    return sku_to_product_id.get(sku.lower()) if sku else None


def _item_quantity(item: Dict[str, Any]) -> int:
    try:
        qty = int(float(item.get("quantity") or item.get("qty") or 1))
    except Exception:
        qty = 1
    return max(1, qty)


def _load_physician_role_lookup() -> Dict[str, str]:
    try:
        users = user_repository.get_all()
    except Exception:
        return {}
    roles: Dict[str, str] = {}
    for user in users or []:
        if not isinstance(user, dict):
            continue
        user_id = str(user.get("id") or "").strip()
        if user_id:
            roles[user_id] = _normalize_role(user.get("role"))
    return roles


def _add_score(scores: Dict[int, float], reasons: Dict[int, Set[str]], product_id: int, value: float, reason: str) -> None:
    if product_id <= 0 or value == 0:
        return
    scores[product_id] += value
    reasons[product_id].add(reason)


def _recency_multiplier(at: Optional[datetime], *, half_life_days: float = 45.0) -> float:
    if at is None:
        return 0.4
    now = datetime.now(timezone.utc)
    age_days = max(0.0, (now - at.astimezone(timezone.utc)).total_seconds() / 86400)
    return math.exp(-age_days / max(1.0, half_life_days))


def _recent_orders() -> List[Dict[str, Any]]:
    now = datetime.now(timezone.utc)
    try:
        return order_repository.list_for_commission(now - timedelta(days=90), now)
    except Exception:
        try:
            return order_repository.list_recent(5000)
        except Exception:
            return []


def _current_user_profile(user_id: str) -> Dict[str, Any]:
    try:
        profile = user_repository.find_by_id(user_id)
    except Exception:
        profile = None
    return profile if isinstance(profile, dict) else {}


def get_recommendations(
    current_user: Dict[str, Any],
    *,
    limit: int = 100,
    shadow_active: bool = False,
) -> Dict[str, Any]:
    if not _enabled():
        return {
            "recommendations": [],
            "modelVersion": MODEL_VERSION,
            "fallback": True,
            "fallbackReason": "disabled",
        }
    if shadow_active:
        return {
            "recommendations": [],
            "modelVersion": MODEL_VERSION,
            "fallback": True,
            "fallbackReason": "shadow_session_disabled",
        }
    if not _is_physician_role(current_user.get("role")):
        raise _service_error("Physician access required", 403)

    user_id = str(current_user.get("id") or "").strip()
    if not user_id:
        raise _service_error("User ID is required", 400)

    try:
        safe_limit = max(1, min(int(limit), 500))
    except Exception:
        safe_limit = 100

    candidates = _load_catalog_candidates()
    if not candidates:
        return {
            "recommendations": [],
            "modelVersion": MODEL_VERSION,
            "fallback": True,
            "fallbackReason": "empty_catalog",
        }
    sku_to_product_id = {
        str(candidate.get("sku")).lower(): product_id
        for product_id, candidate in candidates.items()
        if candidate.get("sku")
    }

    scores: Dict[int, float] = defaultdict(float)
    reasons: Dict[int, Set[str]] = defaultdict(set)
    purchased_stats: Dict[int, Dict[str, Any]] = defaultdict(lambda: {"count": 0, "quantity": 0, "lastAt": None})

    try:
        user_orders = order_repository.find_by_user_id(user_id)
    except Exception:
        user_orders = []
    for order in user_orders or []:
        if not isinstance(order, dict):
            continue
        created_at = _order_created_at(order)
        for item in _iter_order_items(order):
            product_id = _resolve_item_product_id(item, sku_to_product_id)
            if product_id not in candidates:
                continue
            stats = purchased_stats[product_id]
            stats["count"] = int(stats.get("count") or 0) + 1
            stats["quantity"] = int(stats.get("quantity") or 0) + _item_quantity(item)
            last_at = stats.get("lastAt")
            if created_at and (not isinstance(last_at, datetime) or created_at > last_at):
                stats["lastAt"] = created_at

    for product_id, stats in purchased_stats.items():
        recency = _recency_multiplier(stats.get("lastAt"), half_life_days=60.0)
        score = 62.0 + (12.0 * math.log1p(int(stats.get("quantity") or 0))) + (34.0 * recency)
        _add_score(scores, reasons, product_id, score, RECOMMENDATION_REASON_LABELS["repeat_purchase"])

    profile = _current_user_profile(user_id)
    cart_items = profile.get("cart") if isinstance(profile.get("cart"), list) else []
    cart_product_ids: Set[int] = set()
    for item in cart_items:
        if not isinstance(item, dict):
            continue
        product_id = _resolve_item_product_id(item, sku_to_product_id)
        if product_id in candidates:
            cart_product_ids.add(product_id)
            _add_score(scores, reasons, product_id, 82.0 + 8.0 * math.log1p(_item_quantity(item)), RECOMMENDATION_REASON_LABELS["cart_intent"])

    try:
        user_events = physician_product_event_repository.find_recent_for_user(user_id, limit=1500)
    except Exception:
        user_events = []
    event_signal_product_ids: Set[int] = set()
    for event in user_events or []:
        if not isinstance(event, dict):
            continue
        product_id = _parse_positive_int(event.get("wooProductId"))
        if product_id not in candidates:
            sku = str(event.get("sku") or "").strip().lower()
            product_id = sku_to_product_id.get(sku)
        if product_id not in candidates:
            continue
        event_type = str(event.get("eventType") or "").strip()
        occurred_at = _parse_datetime(event.get("occurredAt"))
        recency = _recency_multiplier(occurred_at, half_life_days=21.0)
        quantity = max(1, int(event.get("quantity") or 1))
        if event_type == "add_to_cart":
            event_signal_product_ids.add(product_id)
            _add_score(scores, reasons, product_id, 46.0 * recency + 4.0 * math.log1p(quantity), RECOMMENDATION_REASON_LABELS["cart_intent"])
        elif event_type == "product_view":
            event_signal_product_ids.add(product_id)
            _add_score(scores, reasons, product_id, 11.0 * recency, RECOMMENDATION_REASON_LABELS["view_intent"])
        elif event_type == "checkout_open":
            event_signal_product_ids.add(product_id)
            _add_score(scores, reasons, product_id, 22.0 * recency, RECOMMENDATION_REASON_LABELS["cart_intent"])
        elif event_type == "cart_remove":
            _add_score(scores, reasons, product_id, -12.0 * recency, RECOMMENDATION_REASON_LABELS["cart_intent"])

    purchased_product_ids = set(purchased_stats.keys())
    purchased_category_keys: Set[str] = set()
    purchased_tag_keys: Set[str] = set()
    for product_id in purchased_product_ids:
        candidate = candidates.get(product_id) or {}
        purchased_category_keys.update(candidate.get("categoryKeys") or set())
        purchased_tag_keys.update(candidate.get("tagKeys") or set())

    if purchased_category_keys or purchased_tag_keys:
        for product_id, candidate in candidates.items():
            if product_id in purchased_product_ids:
                continue
            category_overlap = len(purchased_category_keys & set(candidate.get("categoryKeys") or set()))
            tag_overlap = len(purchased_tag_keys & set(candidate.get("tagKeys") or set()))
            if category_overlap:
                _add_score(scores, reasons, product_id, min(24.0, 13.0 * category_overlap), RECOMMENDATION_REASON_LABELS["category_affinity"])
            if tag_overlap:
                _add_score(scores, reasons, product_id, min(18.0, 7.0 * tag_overlap), RECOMMENDATION_REASON_LABELS["tag_affinity"])

    role_by_user_id = _load_physician_role_lookup()
    global_quantity: Dict[int, int] = defaultdict(int)
    global_buyers: Dict[int, Set[str]] = defaultdict(set)
    co_purchase_counts: Dict[int, int] = defaultdict(int)

    for order in _recent_orders():
        if not isinstance(order, dict):
            continue
        order_user_id = str(order.get("userId") or order.get("user_id") or "").strip()
        if role_by_user_id and not _is_physician_role(role_by_user_id.get(order_user_id)):
            continue
        order_product_ids: Set[int] = set()
        for item in _iter_order_items(order):
            product_id = _resolve_item_product_id(item, sku_to_product_id)
            if product_id not in candidates:
                continue
            order_product_ids.add(product_id)
            global_quantity[product_id] += _item_quantity(item)
            if order_user_id:
                global_buyers[product_id].add(order_user_id)
        if order_user_id != user_id and purchased_product_ids and order_product_ids & purchased_product_ids:
            for product_id in order_product_ids - purchased_product_ids:
                co_purchase_counts[product_id] += 1

    for product_id, count in co_purchase_counts.items():
        _add_score(scores, reasons, product_id, min(44.0, 14.0 * math.log1p(count)), RECOMMENDATION_REASON_LABELS["similar_physicians"])

    for product_id, quantity in global_quantity.items():
        buyer_count = len(global_buyers.get(product_id) or set())
        popularity_score = min(30.0, 4.0 * math.log1p(quantity) + 3.0 * math.log1p(buyer_count))
        _add_score(scores, reasons, product_id, popularity_score, RECOMMENDATION_REASON_LABELS["global_popularity"])

    has_personal_signal = bool(purchased_product_ids or cart_product_ids or event_signal_product_ids)
    ranked_ids = [
        product_id
        for product_id, score in sorted(
            scores.items(),
            key=lambda item: (-item[1], candidates.get(item[0], {}).get("name") or "", item[0]),
        )
        if product_id in candidates and score > 0
    ][:safe_limit]

    recommendations = [
        {
            "productId": candidates[product_id]["productId"],
            "wooProductId": product_id,
            "score": round(float(scores[product_id]), 6),
            "reasons": sorted(reasons.get(product_id) or []),
            "modelVersion": MODEL_VERSION,
        }
        for product_id in ranked_ids
    ]

    return {
        "recommendations": recommendations,
        "modelVersion": MODEL_VERSION,
        "fallback": not has_personal_signal,
        "fallbackReason": "cold_start_global_popularity" if not has_personal_signal and recommendations else None,
    }


def track_product_event(
    current_user: Dict[str, Any],
    payload: Dict[str, Any],
    *,
    shadow_active: bool = False,
) -> Dict[str, Any]:
    event_type = str(payload.get("eventType") or payload.get("event_type") or payload.get("event") or "").strip()
    if not event_type:
        raise _service_error("eventType is required", 400)
    if event_type not in ALLOWED_EVENT_TYPES:
        raise _service_error("Unsupported product event type", 400)

    if not _enabled() or shadow_active:
        return {"ok": True, "tracked": False, "eventType": event_type}
    if not _is_physician_role(current_user.get("role")):
        raise _service_error("Physician access required", 403)

    user_id = str(current_user.get("id") or "").strip()
    if not user_id:
        raise _service_error("User ID is required", 400)

    woo_product_id = (
        _parse_positive_int(payload.get("wooProductId"))
        or _parse_positive_int(payload.get("woo_product_id"))
        or _parse_positive_int(payload.get("productWooId"))
        or _parse_positive_int(payload.get("productId"))
        or _parse_positive_int(payload.get("product_id"))
    )
    woo_variation_id = (
        _parse_positive_variation_id(payload.get("wooVariationId"))
        or _parse_positive_variation_id(payload.get("woo_variation_id"))
        or _parse_positive_variation_id(payload.get("variantWooId"))
        or _parse_positive_variation_id(payload.get("variationId"))
        or _parse_positive_variation_id(payload.get("variantId"))
    )
    sku = str(payload.get("sku") or "").strip()[:128] or None
    if woo_product_id is None and not sku:
        raise _service_error("Product ID or SKU is required", 400)

    try:
        quantity = int(float(payload.get("quantity") or 1))
    except Exception:
        quantity = 1
    quantity = max(1, quantity)

    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    tracked = physician_product_event_repository.insert_event(
        user_id=user_id,
        event_type=event_type,
        woo_product_id=woo_product_id,
        woo_variation_id=woo_variation_id,
        sku=sku,
        quantity=quantity,
        metadata=metadata,
    )
    return {"ok": True, "tracked": tracked, "eventType": event_type}


def track_order_purchase_events(
    current_user: Dict[str, Any],
    *,
    items: List[Dict[str, Any]],
    order_id: object = None,
) -> None:
    if not _enabled() or not _is_physician_role(current_user.get("role")):
        return
    user_id = str(current_user.get("id") or "").strip()
    if not user_id:
        return
    for item in items or []:
        if not isinstance(item, dict):
            continue
        woo_product_id = (
            _parse_positive_int(item.get("wooProductId"))
            or _parse_positive_int(item.get("productWooId"))
            or _parse_positive_int(item.get("productId"))
            or _parse_positive_int(item.get("product_id"))
            or _parse_positive_int(item.get("id"))
        )
        sku = _item_sku(item)
        if woo_product_id is None and not sku:
            continue
        physician_product_event_repository.insert_event(
            user_id=user_id,
            event_type="purchase",
            woo_product_id=woo_product_id,
            woo_variation_id=(
                _parse_positive_variation_id(item.get("wooVariationId"))
                or _parse_positive_variation_id(item.get("variantWooId"))
                or _parse_positive_variation_id(item.get("variantId"))
                or _parse_positive_variation_id(item.get("variationId"))
            ),
            sku=sku,
            quantity=_item_quantity(item),
            metadata={"orderId": str(order_id or "").strip() or None},
        )
