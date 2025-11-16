from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from ..repositories import order_repository, user_repository
from ..integrations import ship_engine, stripe_payments, woo_commerce
from . import referral_service

logger = logging.getLogger(__name__)


def _validate_items(items: Optional[List[Dict]]) -> bool:
    return bool(
        isinstance(items, list)
        and items
        and all(isinstance(item, dict) and isinstance(item.get("quantity"), (int, float)) for item in items)
    )


def create_order(user_id: str, items: List[Dict], total: float, referral_code: Optional[str]) -> Dict:
    if not _validate_items(items):
        raise _service_error("Order requires at least one item", 400)
    if not isinstance(total, (int, float)) or total <= 0:
        raise _service_error("Order total must be a positive number", 400)

    user = user_repository.find_by_id(user_id)
    if not user:
        raise _service_error("User not found", 404)

    now = datetime.now(timezone.utc).isoformat()
    normalized_referral = (referral_code or "").strip().upper() or None
    order = {
        "id": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
        "userId": user_id,
        "items": items,
        "total": float(total),
        "referralCode": normalized_referral,
        "status": "pending",
        "createdAt": now,
    }

    # Auto-apply available referral credits to this order
    available_credit = float(user.get("referralCredits") or 0)
    if available_credit > 0 and float(total) > 0:
        applied = min(available_credit, float(total))
        order["appliedReferralCredit"] = round(applied, 2)

    referral_effects = referral_service.handle_order_referral_effects(
        purchaser_id=user_id,
        referral_code=normalized_referral,
        order_total=float(total),
        order_id=order["id"],
    )

    if referral_effects.get("checkoutBonus"):
        bonus = referral_effects["checkoutBonus"]
        order["referrerBonus"] = {
            "referrerId": bonus.get("referrerId"),
            "referrerName": bonus.get("referrerName"),
            "commission": bonus.get("commission"),
            "type": "checkout_code",
        }

    if referral_effects.get("firstOrderBonus"):
        bonus = referral_effects["firstOrderBonus"]
        order["firstOrderBonus"] = {
            "referrerId": bonus.get("referrerId"),
            "referrerName": bonus.get("referrerName"),
            "amount": bonus.get("amount"),
        }

    order_repository.insert(order)

    integrations = {}

    try:
        integrations["wooCommerce"] = woo_commerce.forward_order(order, user)
        woo_resp = integrations["wooCommerce"]
        if woo_resp.get("status") == "success":
            order["wooOrderId"] = woo_resp.get("response", {}).get("id")
            order["wooOrderKey"] = woo_resp.get("response", {}).get("orderKey")
        # On successful Woo order creation, finalize referral credit deduction
        if order.get("appliedReferralCredit"):
            try:
                referral_service.apply_referral_credit(user_id, float(order["appliedReferralCredit"]), order["id"])
            except Exception as credit_exc:  # best effort; don't fail checkout
                logger.error("Failed to apply referral credit", exc_info=True, extra={"orderId": order["id"]})
    except Exception as exc:  # pragma: no cover - network error path
        logger.error("WooCommerce integration failed", exc_info=True, extra={"orderId": order["id"]})
        integrations["wooCommerce"] = {
            "status": "error",
            "message": str(exc),
            "details": getattr(exc, "response", None),
        }

    try:
        integrations["stripe"] = stripe_payments.create_payment_intent(order)
    except Exception as exc:  # pragma: no cover - network error path
        logger.error("Stripe integration failed", exc_info=True, extra={"orderId": order["id"]})
        integrations["stripe"] = {
            "status": "error",
            "message": str(exc),
            "details": getattr(exc, "response", None),
        }

    try:
        integrations["shipEngine"] = ship_engine.forward_shipment(order, user)
    except Exception as exc:  # pragma: no cover - network error path
        logger.error("ShipEngine integration failed", exc_info=True, extra={"orderId": order["id"]})
        integrations["shipEngine"] = {
            "status": "error",
            "message": str(exc),
            "details": getattr(exc, "response", None),
        }

    order["integrations"] = {
        "wooCommerce": integrations.get("wooCommerce", {}).get("status"),
        "stripe": integrations.get("stripe", {}).get("status"),
        "shipEngine": integrations.get("shipEngine", {}).get("status"),
    }
    if integrations.get("stripe", {}).get("paymentIntentId"):
        order["paymentIntentId"] = integrations["stripe"]["paymentIntentId"]
    order_repository.update(order)

    message = None
    if referral_effects.get("checkoutBonus"):
        bonus = referral_effects["checkoutBonus"]
        message = f"{bonus.get('referrerName')} earned ${bonus.get('commission'):.2f} commission!"
    elif referral_effects.get("firstOrderBonus"):
        bonus = referral_effects["firstOrderBonus"]
        message = f"{bonus.get('referrerName')} earned a ${bonus.get('amount'):.2f} referral credit!"

    return {
        "success": True,
        "order": order,
        "message": message,
        "integrations": integrations,
    }


def get_orders_for_user(user_id: str):
    user = user_repository.find_by_id(user_id)
    local_orders = order_repository.find_by_user_id(user_id)

    woo_orders = []
    woo_error = None
    if user and user.get("email"):
        try:
            woo_orders = woo_commerce.fetch_orders_by_email(user.get("email"), per_page=15)
        except Exception as exc:
            logger.error("Failed to fetch WooCommerce orders for user", exc_info=True, extra={"userId": user_id})
            woo_error = getattr(exc, "response", None) or {"message": str(exc)}

    return {
        "local": local_orders,
        "woo": woo_orders,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "wooError": woo_error,
    }


def _service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err
