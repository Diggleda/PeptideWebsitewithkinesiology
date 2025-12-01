from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional

from ..repositories import (
    order_repository,
    user_repository,
    sales_rep_repository,
    referral_code_repository,
)
from ..integrations import ship_engine, stripe_payments, woo_commerce
from . import referral_service

logger = logging.getLogger(__name__)


def _validate_items(items: Optional[List[Dict]]) -> bool:
    return bool(
        isinstance(items, list)
        and items
        and all(isinstance(item, dict) and isinstance(item.get("quantity"), (int, float)) for item in items)
    )


def create_order(
    user_id: str,
    items: List[Dict],
    total: float,
    referral_code: Optional[str],
    shipping_total: Optional[float] = None,
    shipping_address: Optional[Dict] = None,
    shipping_rate: Optional[Dict] = None,
    physician_certified: bool = False,
) -> Dict:
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
        "shippingTotal": float(shipping_total or 0),
        "shippingEstimate": shipping_rate or {},
        "shippingAddress": shipping_address or {},
        "referralCode": normalized_referral,
        "status": "pending",
        "createdAt": now,
        "physicianCertificationAccepted": bool(physician_certified),
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
    if not user:
        raise _service_error("User not found", 404)

    orders = order_repository.find_by_user_id(user_id)
    woo_orders = []
    woo_error = None

    email = (user.get("email") or "").strip().lower()
    if email:
        try:
            woo_orders = woo_commerce.fetch_orders_by_email(email)
        except woo_commerce.IntegrationError as exc:
            logger.error("WooCommerce order lookup failed", exc_info=True, extra={"userId": user_id})
            woo_error = {
                "message": str(exc) or "Unable to load WooCommerce orders.",
                "details": getattr(exc, "response", None),
                "status": getattr(exc, "status", 502),
            }
        except Exception as exc:  # pragma: no cover - unexpected network error path
            logger.error("Unexpected WooCommerce order lookup error", exc_info=True, extra={"userId": user_id})
            woo_error = {"message": "Unable to load WooCommerce orders.", "details": str(exc), "status": 502}

    return {
        "local": orders,
        "woo": woo_orders,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "wooError": woo_error,
    }


def get_orders_for_sales_rep(sales_rep_id: str, include_doctors: bool = False):
    users = user_repository.get_all()
    normalized_sales_rep_id = str(sales_rep_id)
    role_lookup = {u.get("id"): (u.get("role") or "").lower() for u in users}

    doctors = []
    for user in users:
        role = (user.get("role") or "").lower()
        if role not in ("doctor", "test_doctor"):
            continue
        if str(user.get("salesRepId") or "") != normalized_sales_rep_id:
            continue
        # Only attach doctors to real sales reps; if the "rep" is actually an admin,
        # still include these for the admin's personal tracker but not in rep rollups.
        if role_lookup.get(normalized_sales_rep_id) not in ("sales_rep", "rep", "admin"):
            continue
        doctors.append(user)

    doctor_lookup = {
        doc.get("id"): {
            "id": doc.get("id"),
            "name": doc.get("name") or doc.get("email") or "Doctor",
            "email": doc.get("email"),
        }
        for doc in doctors
    }

    summaries: List[Dict] = []
    seen_keys = set()
    for doctor in doctors:
        doctor_id = doctor.get("id")
        doctor_name = doctor.get("name") or doctor.get("email") or "Doctor"
        doctor_email = doctor.get("email")

        for order in order_repository.find_by_user_id(doctor_id):
            key = f"local:{order.get('id')}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            summaries.append(
                {
                    **order,
                    "doctorId": doctor_id,
                    "doctorName": doctor_name,
                    "doctorEmail": doctor_email,
                    "source": order.get("source") or "local",
                }
            )

    summaries.sort(key=lambda o: o.get("createdAt") or "", reverse=True)

    return (
        {
            "orders": summaries,
            "doctors": list(doctor_lookup.values()),
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
        if include_doctors
        else summaries
    )


def get_sales_by_rep(exclude_sales_rep_id: Optional[str] = None):
    users = user_repository.get_all()
    reps = [u for u in users if (u.get("role") or "").lower() == "sales_rep"]
    rep_records = {rep.get("id"): rep for rep in sales_rep_repository.get_all()}
    user_lookup = {u.get("id"): u for u in users}
    doctors = [
        u
        for u in users
        if (u.get("role") or "").lower() in ("doctor", "test_doctor") and u.get("salesRepId")
    ]

    valid_rep_ids = {rep.get("id") for rep in reps}
    doctor_to_rep = {
        doc.get("id"): doc.get("salesRepId")
        for doc in doctors
        if doc.get("salesRepId") in valid_rep_ids
    }
    rep_totals: Dict[str, Dict[str, float]] = {}

    # Local orders
    for order in order_repository.get_all():
        rep_id = doctor_to_rep.get(order.get("userId"))
        if not rep_id:
            continue
        if exclude_sales_rep_id and rep_id == exclude_sales_rep_id:
            continue
        current = rep_totals.get(rep_id, {"totalOrders": 0, "totalRevenue": 0})
        current["totalOrders"] += 1
        current["totalRevenue"] += float(order.get("total") or 0)
        rep_totals[rep_id] = current

    # No WooCommerce aggregation; MySQL/local orders are the source of truth

    rep_lookup = {rep.get("id"): rep for rep in reps}
    summary = []
    for rep_id, totals in rep_totals.items():
        rep = rep_lookup.get(rep_id) or user_lookup.get(rep_id) or {}
        rep_record = rep_records.get(rep_id) or {}
        # Fallback: derive name/email from any user with matching id; otherwise use id
        summary.append(
            {
                "salesRepId": rep_id,
                "salesRepName": rep.get("name") or rep_record.get("name") or rep.get("email") or rep_id or "Sales Rep",
                "salesRepEmail": rep.get("email") or rep_record.get("email"),
                "salesRepPhone": rep.get("phone") or rep_record.get("phone"),
                "totalOrders": totals["totalOrders"],
                "totalRevenue": totals["totalRevenue"],
            }
        )

    summary.sort(key=lambda r: r["totalRevenue"], reverse=True)
    return summary


def _service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err
