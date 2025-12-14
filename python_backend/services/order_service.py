from __future__ import annotations

import logging
from datetime import datetime, timezone
import json
import re
from typing import Dict, List, Optional

from ..repositories import (
    order_repository,
    user_repository,
    sales_rep_repository,
    referral_code_repository,
)
from ..integrations import ship_engine, ship_station, stripe_payments, woo_commerce
from .. import storage
from . import referral_service
from . import settings_service

logger = logging.getLogger(__name__)


def _ensure_dict(value):
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _validate_items(items: Optional[List[Dict]]) -> bool:
    return bool(
        isinstance(items, list)
        and items
        and all(isinstance(item, dict) and isinstance(item.get("quantity"), (int, float)) for item in items)
    )


def _normalize_address_field(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    cleaned = str(value).strip()
    return cleaned or None


def _extract_user_address_fields(shipping_address: Optional[Dict]) -> Dict[str, Optional[str]]:
    if not isinstance(shipping_address, dict):
        return {}
    return {
        "officeAddressLine1": _normalize_address_field(shipping_address.get("addressLine1")),
        "officeAddressLine2": _normalize_address_field(shipping_address.get("addressLine2")),
        "officeCity": _normalize_address_field(shipping_address.get("city")),
        "officeState": _normalize_address_field(shipping_address.get("state")),
        "officePostalCode": _normalize_address_field(shipping_address.get("postalCode")),
        "officeCountry": _normalize_address_field(shipping_address.get("country")),
    }


def _normalize_woo_order_id(value: Optional[object]) -> Optional[str]:
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
    return None


def _extract_woo_order_id(local_order: Optional[Dict]) -> Optional[str]:
    if not local_order:
        return None
    candidates = [
        local_order.get("wooOrderId"),
        local_order.get("woo_order_id"),
    ]
    details = _ensure_dict(local_order.get("integrationDetails") or local_order.get("integrations"))
    woo_details = _ensure_dict(details.get("wooCommerce") or details.get("woocommerce"))
    response = _ensure_dict(woo_details.get("response"))
    payload = _ensure_dict(woo_details.get("payload"))
    candidates.extend(
        [
            response.get("id"),
            payload.get("id"),
        ],
    )
    for candidate in candidates:
        normalized = _normalize_woo_order_id(candidate)
        if normalized:
            return normalized
    return None


def _resolve_sales_rep_context(doctor: Dict) -> Dict[str, Optional[str]]:
    rep_id = str(doctor.get("salesRepId") or doctor.get("sales_rep_id") or "").strip()
    if not rep_id:
        return {}

    rep = sales_rep_repository.find_by_id(rep_id)
    if not rep:
        rep_user = user_repository.find_by_id(rep_id)
        if rep_user and (rep_user.get("role") or "").lower() == "sales_rep":
            rep = {
                "id": rep_user.get("id"),
                "name": rep_user.get("name") or "Sales Rep",
                "email": rep_user.get("email"),
            }

    name = (rep.get("name") or "").strip() if isinstance(rep, dict) else ""
    email = (rep.get("email") or "").strip() if isinstance(rep, dict) else ""
    sales_code = (rep.get("salesCode") or rep.get("sales_code") or "").strip() if isinstance(rep, dict) else ""

    return {
        "id": (rep.get("id") if isinstance(rep, dict) else None) or rep_id,
        "name": name or None,
        "email": email or None,
        "salesCode": sales_code or None,
    }


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

    sales_rep_ctx = _resolve_sales_rep_context(user)

    now = datetime.now(timezone.utc).isoformat()
    shipping_address = shipping_address or {}
    address_updates = _extract_user_address_fields(shipping_address)
    if any(address_updates.values()):
        updated_user = user_repository.update({**user, **address_updates})
        if updated_user:
            user = updated_user

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
        "doctorSalesRepId": sales_rep_ctx.get("id"),
        "doctorSalesRepName": sales_rep_ctx.get("name"),
        "doctorSalesRepEmail": sales_rep_ctx.get("email"),
        "doctorSalesRepCode": sales_rep_ctx.get("salesCode"),
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
            woo_response = woo_resp.get("response", {}) or {}
            order["wooOrderId"] = woo_response.get("id")
            order["wooOrderKey"] = woo_response.get("orderKey")
            order["wooOrderNumber"] = woo_response.get("number")
            try:
                woo_commerce.update_order_metadata(
                    {
                        "woo_order_id": order.get("wooOrderId"),
                        "order_key": order.get("wooOrderKey"),
                        "peppro_order_id": order.get("id"),
                        "sales_rep_id": order.get("doctorSalesRepId"),
                        "sales_rep_name": order.get("doctorSalesRepName"),
                        "sales_rep_email": order.get("doctorSalesRepEmail"),
                        "sales_rep_code": order.get("doctorSalesRepCode"),
                        "stripe_mode": settings_service.get_effective_stripe_mode(),
                    }
                )
            except Exception:
                logger.warning(
                    "Failed to attach initial metadata to Woo order",
                    exc_info=True,
                    extra={"orderId": order.get("id"), "wooOrderId": order.get("wooOrderId")},
                )
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

    if order.get("wooOrderId"):
        try:
            integrations["stripe"] = stripe_payments.create_payment_intent(order)
            if integrations["stripe"].get("paymentIntentId"):
                order["paymentIntentId"] = integrations["stripe"]["paymentIntentId"]
                try:
                    woo_commerce.update_order_metadata(
                        {
                            "woo_order_id": order.get("wooOrderId"),
                            "payment_intent_id": order.get("paymentIntentId"),
                            "order_key": order.get("wooOrderKey"),
                            "peppro_order_id": order.get("id"),
                            "sales_rep_id": order.get("doctorSalesRepId"),
                            "sales_rep_name": order.get("doctorSalesRepName"),
                            "sales_rep_email": order.get("doctorSalesRepEmail"),
                            "sales_rep_code": order.get("doctorSalesRepCode"),
                            "stripe_mode": settings_service.get_effective_stripe_mode(),
                            "payment_method": "stripe",
                            "payment_method_title": "Stripe Onsite",
                        }
                    )
                except Exception:
                    logger.warning(
                        "Failed to attach Stripe metadata to Woo order",
                        exc_info=True,
                        extra={
                            "orderId": order.get("id"),
                            "wooOrderId": order.get("wooOrderId"),
                            "paymentIntentId": order.get("paymentIntentId"),
                        },
                    )
            else:
                try:
                    print(
                        f"[order_service] stripe intent not created: order_id={order.get('id')} stripe={integrations.get('stripe')}",
                        flush=True,
                    )
                except Exception:
                    pass
        except Exception as exc:  # pragma: no cover - network error path
            logger.error("Stripe integration failed", exc_info=True, extra={"orderId": order["id"]})
            integrations["stripe"] = {
                "status": "error",
                "message": str(exc),
                "details": getattr(exc, "response", None),
            }
    else:
        integrations["stripe"] = {
            "status": "skipped",
            "reason": "woo_order_missing",
        }
        logger.warning(
            "Stripe payment skipped because WooCommerce order failed",
            extra={
                "orderId": order["id"],
                "wooStatus": integrations.get("wooCommerce", {}).get("status"),
                "wooMessage": integrations.get("wooCommerce", {}).get("message"),
            },
        )

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


def _find_order_by_woo_id(woo_order_id: str) -> Optional[Dict]:
    """Best-effort lookup of a local order using a WooCommerce order id/number."""
    if not woo_order_id:
        return None
    target = _normalize_woo_order_id(woo_order_id) or str(woo_order_id)
    for order in order_repository.get_all():
        local_candidate = _normalize_woo_order_id(order.get("wooOrderId") or order.get("woo_order_id"))
        if local_candidate and local_candidate == target:
            return order
        local_number = _normalize_woo_order_id(order.get("wooOrderNumber") or order.get("woo_order_number"))
        if local_number and local_number == target:
            return order
        details = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        woo_details = _ensure_dict(details.get("wooCommerce") or details.get("woocommerce"))
        detail_candidate = _normalize_woo_order_id(
            woo_details.get("wooOrderNumber")
            or woo_details.get("woo_order_number")
            or _ensure_dict(woo_details.get("payload")).get("number")
            or _ensure_dict(woo_details.get("response")).get("number")
        )
        if detail_candidate and detail_candidate == target:
            return order
    return None


def cancel_order(user_id: str, order_id: str, reason: Optional[str] = None) -> Dict:
    """
    Cancel a WooCommerce order first (source of truth), then mirror status locally if present.
    """
    local_order = _find_order_by_woo_id(order_id) or order_repository.find_by_id(order_id)
    stripe_refund = None
    woo_order = None
    woo_order_id = _extract_woo_order_id(local_order)

    # If we don't know Woo order id yet, attempt to fetch using provided identifier.
    if not local_order or not woo_order_id:
        woo_order = woo_commerce.fetch_order(order_id)
        if not woo_order:
            woo_order = woo_commerce.fetch_order_by_number(order_id)
        if not woo_order:
            woo_order = woo_commerce.fetch_order_by_peppro_id(order_id)
        if woo_order and woo_order.get("id"):
            woo_order_id = str(woo_order.get("id"))

    # If we resolved a Woo id that differs from the provided identifier, ensure we have Woo details.
    if woo_order_id and woo_order_id != order_id and woo_order is None:
        woo_order = (
            woo_commerce.fetch_order(woo_order_id)
            or woo_commerce.fetch_order_by_number(woo_order_id)
            or woo_commerce.fetch_order_by_peppro_id(woo_order_id)
        )

    if not woo_order_id:
        woo_order_id = order_id

    # Attempt Stripe refund first if we have a PaymentIntent.
    payment_intent_id = None
    total_amount = None
    intent_data = None
    intent_amount_cents = None
    if local_order and local_order.get("paymentIntentId"):
        payment_intent_id = local_order["paymentIntentId"]
        total_amount = float(local_order.get("total") or 0) + float(local_order.get("shippingTotal") or 0)
    elif woo_order:
        meta = woo_order.get("meta_data") or []
        for entry in meta:
            if entry.get("key") == "stripe_payment_intent":
                payment_intent_id = entry.get("value")
                break
        try:
            total_amount = float(woo_order.get("total") or 0)
            total_amount += float(woo_order.get("shipping_total") or 0)
        except Exception:
            total_amount = None

    did_refund = False
    refund_amount = None
    woo_refund = None

    if payment_intent_id:
        intent_status = None
        charged_amount_cents = None
        try:
            intent_data = stripe_payments.retrieve_payment_intent(payment_intent_id)
            intent = (intent_data or {}).get("intent") or {}
            intent_status = str(intent.get("status") or "").strip().lower() or None
            amount_received = intent.get("amount_received")
            charges = (intent.get("charges") or {}).get("data") or []
            if isinstance(amount_received, int) and amount_received > 0:
                charged_amount_cents = amount_received
            else:
                for charge in reversed(charges):
                    paid = charge.get("paid")
                    charge_status = str(charge.get("status") or "").strip().lower()
                    if paid is not True and charge_status != "succeeded":
                        continue
                    candidate = charge.get("amount_captured") or charge.get("amount")
                    if isinstance(candidate, int) and candidate > 0:
                        charged_amount_cents = candidate
                        break
            intent_amount_cents = charged_amount_cents
        except Exception as exc:  # pragma: no cover - retrieval failure path
            logger.error(
                "Failed to retrieve Stripe PaymentIntent before refund",
                exc_info=True,
                extra={"orderId": order_id, "paymentIntentId": payment_intent_id},
            )

        if intent_amount_cents is None or intent_amount_cents <= 0:
            logger.info(
                "Stripe refund skipped (no successful charge)",
                extra={"orderId": order_id, "paymentIntentId": payment_intent_id, "intentStatus": intent_status},
            )
        else:
            fallback_amount_cents = (
                int(round(total_amount * 100)) if total_amount and total_amount > 0 else None
            )
            target_amount_cents = (
                min(intent_amount_cents, fallback_amount_cents)
                if fallback_amount_cents
                else intent_amount_cents
            )
            try:
                stripe_refund = stripe_payments.refund_payment_intent(
                    payment_intent_id,
                    amount_cents=target_amount_cents,
                    reason=reason or None,
                    metadata={"peppro_order_id": local_order.get("id") if local_order else None, "woo_order_id": order_id},
                )
                did_refund = bool(stripe_refund) and stripe_refund.get("status") not in (None, "skipped")
                if did_refund:
                    try:
                        refund_amount = float(stripe_refund.get("amount") or 0) / 100.0
                    except Exception:
                        refund_amount = None
                    try:
                        woo_commerce.update_order_metadata(
                            {
                                "woo_order_id": str(woo_order_id),
                                "payment_intent_id": payment_intent_id,
                                "peppro_order_id": local_order.get("id") if local_order else None,
                                "refunded": True,
                                "stripe_refund_id": stripe_refund.get("id") if isinstance(stripe_refund, dict) else None,
                                "refund_amount": refund_amount,
                                "refund_currency": stripe_refund.get("currency") if isinstance(stripe_refund, dict) else None,
                                "refund_created_at": datetime.utcnow().isoformat(),
                            }
                        )
                    except Exception:
                        logger.warning(
                            "WooCommerce order refund metadata update failed",
                            exc_info=True,
                            extra={"orderId": order_id, "wooOrderId": woo_order_id},
                        )
            except Exception as exc:  # pragma: no cover - network path
                logger.error("Stripe refund failed during cancellation", exc_info=True, extra={"orderId": order_id})
                raise _service_error("Unable to refund this order right now. Please try again soon.", 502)

    woo_result = None
    try:
        if did_refund and refund_amount and refund_amount > 0:
            try:
                woo_refund = woo_commerce.create_refund(
                    woo_order_id=str(woo_order_id),
                    amount=float(refund_amount),
                    reason=reason or "Refunded via PepPro (Stripe)",
                    metadata={
                        "stripe_payment_intent": payment_intent_id,
                        "peppro_order_id": local_order.get("id") if local_order else None,
                    },
                )
            except Exception:
                logger.warning(
                    "WooCommerce refund record creation failed",
                    exc_info=True,
                    extra={"orderId": order_id, "wooOrderId": woo_order_id},
                )
        woo_result = woo_commerce.cancel_order(
            woo_order_id,
            reason or "",
            status_override="refunded" if did_refund else None,
        )
    except woo_commerce.IntegrationError as exc:  # pragma: no cover - network path
        logger.error("WooCommerce cancellation failed", exc_info=True, extra={"orderId": order_id})
        status = getattr(exc, "status", 502)
        raise _service_error(str(exc) or "Unable to cancel this order right now.", status)
    except Exception as exc:  # pragma: no cover - unexpected error path
        logger.error("WooCommerce cancellation failed", exc_info=True, extra={"orderId": order_id})
        raise _service_error("Unable to cancel this order right now.", 502)

    woo_status = woo_result.get("status") if isinstance(woo_result, dict) else None
    if woo_status == "not_found" and not local_order:
        raise _service_error("Order not found", 404)
    elif woo_status in (None, "error"):
        message = woo_result.get("message") if isinstance(woo_result, dict) else None
        raise _service_error(message or "Unable to cancel this order right now.", 502)

    # Mirror status locally if we have a record; do not block on missing or mismatched ownership.
    if local_order:
        local_order["status"] = "refunded" if did_refund else "cancelled"
        local_order["cancellationReason"] = reason or ""
        order_repository.update(local_order)

    return {
        "status": "refunded" if did_refund else (woo_result.get("status") if isinstance(woo_result, dict) else "cancelled"),
        "order": local_order,
        "wooCancellation": woo_result,
        "wooRefund": woo_refund,
        "stripeRefund": stripe_refund,
    }


def get_orders_for_user(user_id: str):
    user = user_repository.find_by_id(user_id)
    if not user:
        raise _service_error("User not found", 404)

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

    merged_woo_orders = woo_orders

    # Enrich Woo orders with ShipStation status/tracking
    for woo_order in merged_woo_orders:
        _enrich_with_shipstation(woo_order)

    try:
        sample = merged_woo_orders[0] if merged_woo_orders else {}
        logger.info(
            "[Orders] User response snapshot userId=%s wooCount=%s sampleId=%s sampleTracking=%s shipStationStatus=%s",
            user_id,
            len(merged_woo_orders),
            sample.get("id") or sample.get("number") or sample.get("wooOrderNumber"),
            sample.get("trackingNumber")
            or _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("trackingNumber"),
            _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("status"),
        )
    except Exception:
        pass

    return {
        "local": [],
        "woo": merged_woo_orders,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "wooError": woo_error,
    }


def _merge_local_details_into_woo_orders(woo_orders: List[Dict], local_orders: List[Dict]) -> List[Dict]:
    if not woo_orders or not local_orders:
        return woo_orders

    local_lookup = {str(order.get("id")): order for order in local_orders if order.get("id")}

    for order in woo_orders:
        integrations = _ensure_dict(order.get("integrationDetails"))
        woo_details = _ensure_dict(integrations.get("wooCommerce") or integrations.get("woocommerce"))
        peppro_order_id = (
            woo_details.get("pepproOrderId")
            or woo_details.get("peppro_order_id")
            or order.get("pepproOrderId")
        )
        if not peppro_order_id:
            continue

        local_order = local_lookup.get(str(peppro_order_id))
        if not local_order:
            continue

        shipping_address = local_order.get("shippingAddress") or local_order.get("shipping_address")
        billing_address = local_order.get("billingAddress") or local_order.get("billing_address")
        if shipping_address:
            order["shippingAddress"] = shipping_address
        if billing_address:
            order["billingAddress"] = billing_address

        if local_order.get("shippingTotal") is not None:
            try:
                order["shippingTotal"] = float(local_order.get("shippingTotal") or 0)
            except Exception:
                order["shippingTotal"] = local_order.get("shippingTotal")
        if local_order.get("shippingEstimate"):
            order["shippingEstimate"] = local_order.get("shippingEstimate")

        if local_order.get("items") and not order.get("lineItems"):
            order["lineItems"] = local_order.get("items")

        order["paymentMethod"] = local_order.get("paymentMethod") or order.get("paymentMethod")
        order["paymentDetails"] = (
            local_order.get("paymentDetails")
            or local_order.get("paymentMethod")
            or order.get("paymentDetails")
            or order.get("paymentMethod")
        )

        local_integrations = _ensure_dict(local_order.get("integrationDetails") or local_order.get("integrations"))
        stripe_meta = _ensure_dict(local_integrations.get("stripe"))
        if stripe_meta:
            integrations["stripe"] = stripe_meta
        if woo_details:
            integrations["wooCommerce"] = woo_details
        order["integrationDetails"] = integrations

    return woo_orders


def get_orders_for_sales_rep(sales_rep_id: str, include_doctors: bool = False):
    logger.info("[SalesRep] Fetch start salesRepId=%s includeDoctors=%s", sales_rep_id, include_doctors)
    users = user_repository.get_all()
    normalized_sales_rep_id = str(sales_rep_id)
    role_lookup = {u.get("id"): (u.get("role") or "").lower() for u in users}
    rep_records = {rep.get("id"): rep for rep in sales_rep_repository.get_all()}
    # Allow matching by legacyUserId to catch migrated reps
    legacy_map = {rep.get("legacyUserId"): rep_id for rep_id, rep in rep_records.items() if rep.get("legacyUserId")}
    allowed_rep_ids = {normalized_sales_rep_id}
    if normalized_sales_rep_id in legacy_map:
        allowed_rep_ids.add(legacy_map[normalized_sales_rep_id])
    # Also allow doctors tied directly to sales_reps table ids (in case user id differs)
    allowed_rep_ids.update(rep_records.keys())

    doctors = []
    for user in users:
        role = (user.get("role") or "").lower()
        if role not in ("doctor", "test_doctor"):
            continue
        doctor_sales_rep = str(user.get("salesRepId") or "")
        if doctor_sales_rep not in allowed_rep_ids:
            continue
        doctors.append(user)

    doctor_lookup = {
        doc.get("id"): {
            "id": doc.get("id"),
            "name": doc.get("name") or doc.get("email") or "Doctor",
            "email": doc.get("email"),
            "phone": doc.get("phone"),
            "profileImageUrl": doc.get("profileImageUrl"),
            "address1": doc.get("officeAddressLine1"),
            "address2": doc.get("officeAddressLine2"),
            "city": doc.get("officeCity"),
            "state": doc.get("officeState"),
            "postalCode": doc.get("officePostalCode"),
            "country": doc.get("officeCountry"),
        }
        for doc in doctors
    }

    summaries: List[Dict] = []
    seen_keys = set()

    # WooCommerce orders (if configured)
    woo_enabled = woo_commerce.is_configured()
    logger.info(
        "[SalesRep] Doctor list computed salesRepId=%s doctorCount=%s wooEnabled=%s doctorEmails=%s",
        sales_rep_id,
        len(doctors),
        woo_enabled,
        [d.get("email") for d in doctors],
    )
    if woo_enabled:
        for doctor in doctors:
            doctor_id = doctor.get("id")
            doctor_name = doctor.get("name") or doctor.get("email") or "Doctor"
            doctor_email = (doctor.get("email") or "").strip()
            # gather possible doctor emails (no sales rep email fallback)
            candidate_emails = []
            primary_email = doctor_email.lower()
            if primary_email:
                candidate_emails.append(primary_email)
            for key in (
                "doctorEmail",
                "userEmail",
                "contactEmail",
                "billingEmail",
                "wooEmail",
                "officeEmail",
            ):
                val = (doctor.get(key) or "").strip().lower()
                if val:
                    candidate_emails.append(val)
            # lists of alternates if present
            for key in ("emails", "alternateEmails", "altEmails", "aliases"):
                val = doctor.get(key)
                if isinstance(val, list):
                    for item in val:
                        email_candidate = (item or "").strip().lower()
                        if email_candidate:
                            candidate_emails.append(email_candidate)
            # dedupe
            normalized_emails = []
            for em in candidate_emails:
                if em and em not in normalized_emails:
                    normalized_emails.append(em)

            if not normalized_emails:
                logger.info(
                    "[SalesRep] Skipping Woo fetch; missing doctor email salesRepId=%s doctorId=%s",
                    sales_rep_id,
                    doctor_id,
                )
                continue

            woo_orders: List[Dict] = []
            for email_candidate in normalized_emails:
                try:
                    orders_for_email = woo_commerce.fetch_orders_by_email(email_candidate, per_page=50)
                    logger.info(
                        "[SalesRep] Woo orders fetched salesRepId=%s doctorId=%s email=%s count=%s",
                        sales_rep_id,
                        doctor_id,
                        email_candidate,
                        len(orders_for_email),
                    )
                    woo_orders.extend(orders_for_email)
                except Exception:
                    logger.warning(
                        "Failed to load Woo orders for doctor email salesRepId=%s doctorId=%s email=%s",
                        sales_rep_id,
                        doctor_id,
                        email_candidate,
                        exc_info=True,
                    )

            for woo_order in woo_orders:
                key = f"woo:{woo_order.get('id')}"
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                summary = {
                    **woo_order,
                    "doctorId": doctor_id,
                    "doctorName": doctor_name,
                    "doctorEmail": doctor_email,
                    "source": "woocommerce",
                }
                _enrich_with_shipstation(summary)
                summaries.append(summary)

    summaries.sort(key=lambda o: o.get("createdAt") or "", reverse=True)

    logger.info(
        "[SalesRep] Fetch complete salesRepId=%s doctorCount=%s orderCount=%s sampleOrders=%s",
        sales_rep_id,
        len(doctors),
        len(summaries),
        [o.get("id") or o.get("number") for o in summaries[:5]],
    )

    try:
        sample = summaries[0] if summaries else {}
        logger.info(
            "[SalesRep] Response snapshot salesRepId=%s orderCount=%s sampleId=%s sampleTracking=%s shipStationStatus=%s",
            sales_rep_id,
            len(summaries),
            sample.get("id") or sample.get("number") or sample.get("wooOrderNumber"),
            sample.get("trackingNumber")
            or _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("trackingNumber"),
            _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("status"),
        )
    except Exception:
        pass

    try:
        sample = summaries[0] if summaries else {}
        logger.info(
            "[SalesRep] Response snapshot salesRepId=%s orderCount=%s sampleId=%s sampleTracking=%s shipStationStatus=%s",
            sales_rep_id,
            len(summaries),
            sample.get("id") or sample.get("number") or sample.get("wooOrderNumber"),
            sample.get("trackingNumber")
            or _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("trackingNumber"),
            _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("status"),
        )
    except Exception:
        pass

    return (
        {
            "orders": summaries,
            "doctors": list(doctor_lookup.values()),
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
        if include_doctors
        else summaries
    )


def _normalize_order_identifier(order_id: str) -> List[str]:
    """
    Build candidate identifiers (id and number) from an incoming order id/number string.
    Strips prefixes like 'woo-' and extracts digits for Woo lookups.
    """
    if not order_id:
        return []
    raw = str(order_id).strip()
    candidates = [raw]
    if raw.lower().startswith("woo-"):
        candidates.append(raw.split("-", 1)[1])
    digits_only = re.sub(r"[^\d]", "", raw)
    if digits_only and digits_only not in candidates:
        candidates.append(digits_only)
    return [c for c in candidates if c]


def _persist_shipping_update(
    order_id: Optional[str],
    shipping_estimate: Optional[Dict],
    tracking: Optional[str],
    shipstation_info: Optional[Dict],
) -> None:
    """
    Persist shipping metadata to primary store (MySQL) and best-effort to local JSON for testing.
    """
    if not order_id:
        return
    try:
        existing = order_repository.find_by_id(str(order_id))
    except Exception:
        existing = None
    if not existing:
        return

    merged = dict(existing)
    if shipping_estimate:
        current_est = _ensure_dict(merged.get("shippingEstimate"))
        current_est.update(shipping_estimate)
        merged["shippingEstimate"] = current_est
    if tracking and not merged.get("trackingNumber"):
        merged["trackingNumber"] = tracking

    integrations = _ensure_dict(merged.get("integrationDetails") or merged.get("integrations"))
    if shipstation_info:
        integrations["shipStation"] = shipstation_info
    merged["integrationDetails"] = integrations

    try:
        order_repository.update(merged)
    except Exception:
        logger.warning(
            "Failed to persist shipping update to primary store",
            exc_info=True,
            extra={"orderId": order_id},
        )

    # Best-effort local JSON update for testing
    try:
        store = storage.order_store
        if store:
            orders = list(store.read())
            updated = False
            for idx, entry in enumerate(orders):
                if str(entry.get("id")) == str(order_id):
                    orders[idx] = {**entry, **merged}
                    updated = True
                    break
            if not updated:
                orders.append(merged)
            store.write(orders)
    except Exception:
        logger.warning(
            "Failed to persist shipping update to local JSON store",
            exc_info=True,
            extra={"orderId": order_id},
        )


def _enrich_with_shipstation(order: Dict) -> None:
    """
    Mutates order dict in-place with ShipStation status/tracking, and persists shipping metadata.
    """
    if not order:
        return
    order_number = order.get("number") or order.get("wooOrderNumber")
    if not order_number:
        return
    info = None
    try:
        info = ship_station.fetch_order_status(order_number)
    except ship_station.IntegrationError as exc:  # pragma: no cover - network path
        logger.warning(
            "ShipStation status lookup failed",
            exc_info=True,
            extra={"orderNumber": order_number, "status": getattr(exc, "status", None)},
        )
    except Exception:  # pragma: no cover - unexpected path
        logger.warning("ShipStation status lookup failed (unexpected)", exc_info=True, extra={"orderNumber": order_number})
    if not info:
        return

    try:
        logger.info(
            "[ShipStation] Status lookup order=%s status=%s tracking=%s shipDate=%s",
            order_number,
            info.get("status"),
            info.get("trackingNumber"),
            info.get("shipDate"),
        )
    except Exception:
        pass

    integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
    integrations["shipStation"] = info
    order["integrationDetails"] = integrations
    ship_status = (info.get("status") or "").lower()
    if ship_status == "shipped":
        order["status"] = order.get("status") or "shipped"
        estimate = _ensure_dict(order.get("shippingEstimate"))
        estimate["status"] = "shipped"
        if info.get("shipDate"):
            estimate["shipDate"] = info["shipDate"]
        order["shippingEstimate"] = estimate
    if info.get("trackingNumber"):
        order["trackingNumber"] = info["trackingNumber"]

    peppro_order_id = (
        _ensure_dict(order.get("integrationDetails") or {})
        .get("wooCommerce", {})
        .get("pepproOrderId")
    ) or order.get("id")
    _persist_shipping_update(
        peppro_order_id,
        order.get("shippingEstimate"),
        order.get("trackingNumber"),
        info,
    )


def get_sales_rep_order_detail(order_id: str, sales_rep_id: str) -> Optional[Dict]:
    """
    Fetch a single Woo order detail and ensure it belongs to a doctor tied to this sales rep.
    """
    if not order_id:
        return None
    if not woo_commerce.is_configured():
        return None

    candidates = _normalize_order_identifier(order_id)
    woo_order = None
    logger.debug(
        "[SalesRep] Order detail lookup start",
        extra={"orderId": order_id, "salesRepId": sales_rep_id, "candidates": candidates},
    )
    for candidate in candidates:
        woo_order = woo_commerce.fetch_order(candidate)
        if woo_order:
            break
    if woo_order is None:
        for candidate in candidates:
            woo_order = woo_commerce.fetch_order_by_number(candidate)
            if woo_order:
                break
    if not woo_order:
        return None

    mapped = woo_commerce._map_woo_order_summary(woo_order)
    try:
        logger.debug(
            "[SalesRep] Order detail mapped",
            extra={
                "orderId": order_id,
                "salesRepId": sales_rep_id,
                "mappedId": mapped.get("id"),
                "mappedNumber": mapped.get("number"),
                "mappedWooOrderNumber": mapped.get("wooOrderNumber"),
                "mappedWooOrderId": mapped.get("wooOrderId"),
                "billingEmail": (woo_order.get("billing") or {}).get("email"),
            },
        )
    except Exception:
        pass

    # Enrich with ShipStation status/tracking when available
    shipstation_info = None
    try:
        shipstation_info = ship_station.fetch_order_status(mapped.get("number") or mapped.get("wooOrderNumber"))
    except ship_station.IntegrationError as exc:  # pragma: no cover - network path
        logger.warning(
            "ShipStation status lookup failed",
            exc_info=True,
            extra={"orderId": order_id, "status": getattr(exc, "status", None)},
        )
    except Exception:  # pragma: no cover - unexpected path
        logger.warning(
            "ShipStation status lookup failed (unexpected)",
            exc_info=True,
            extra={"orderId": order_id},
        )

    if shipstation_info:
        mapped.setdefault("integrationDetails", {})
        mapped["integrationDetails"]["shipStation"] = shipstation_info
        ship_status = (shipstation_info.get("status") or "").lower()
        carrier_code = shipstation_info.get("carrierCode")
        service_code = shipstation_info.get("serviceCode")
        if ship_status == "shipped":
            mapped["status"] = mapped.get("status") or "shipped"
            mapped.setdefault("shippingEstimate", {})
            mapped["shippingEstimate"]["status"] = "shipped"
            if shipstation_info.get("shipDate"):
                mapped["shippingEstimate"]["shipDate"] = shipstation_info["shipDate"]
        mapped.setdefault("shippingEstimate", {})
        if carrier_code:
            # Prefer carrierCode for display (e.g., UPS)
            mapped["shippingEstimate"]["carrierId"] = carrier_code
            mapped["shippingCarrier"] = carrier_code
        if service_code:
            mapped["shippingEstimate"]["serviceType"] = service_code
            mapped["shippingService"] = service_code
        if shipstation_info.get("trackingNumber"):
            mapped["trackingNumber"] = shipstation_info["trackingNumber"]
        peppro_order_id = (
            _ensure_dict(mapped.get("integrationDetails") or {})
            .get("wooCommerce", {})
            .get("pepproOrderId")
        ) or mapped.get("id")
        _persist_shipping_update(
            peppro_order_id,
            mapped.get("shippingEstimate"),
            mapped.get("trackingNumber"),
            shipstation_info,
        )

    # Associate doctor by billing email
    billing_email = (woo_order.get("billing") or {}).get("email") or mapped.get("billingEmail")
    doctor = user_repository.find_by_email(billing_email) if billing_email else None
    if doctor:
        mapped["doctorId"] = doctor.get("id")
        mapped["doctorName"] = doctor.get("name") or billing_email
        mapped["doctorEmail"] = doctor.get("email")
        mapped["doctorSalesRepId"] = doctor.get("salesRepId")
    try:
        logger.debug(
            "[SalesRep] Order detail return",
            extra={
                "orderId": order_id,
                "salesRepId": sales_rep_id,
                "returnId": mapped.get("id"),
                "returnNumber": mapped.get("number"),
                "returnWooOrderNumber": mapped.get("wooOrderNumber"),
                "returnWooOrderId": mapped.get("wooOrderId"),
            },
        )
    except Exception:
        pass

    return mapped


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
