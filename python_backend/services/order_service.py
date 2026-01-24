from __future__ import annotations

import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
import json
import re
from typing import Dict, List, Optional
from zoneinfo import ZoneInfo

from ..repositories import (
    order_repository,
    user_repository,
    sales_rep_repository,
    referral_code_repository,
    sales_prospect_repository,
)
from ..integrations import ship_station, stripe_payments, woo_commerce
from ..integrations import stripe_tax
from .. import storage
from . import referral_service
from . import settings_service

logger = logging.getLogger(__name__)

_PERF_LOG_ENABLED = (os.environ.get("PERF_LOG") or "").strip().lower() in ("1", "true", "yes", "on")


def _perf_log(message: str, *, duration_ms: float, threshold_ms: float = 500.0) -> None:
    if _PERF_LOG_ENABLED or duration_ms >= threshold_ms:
        logger.info("[perf] %s (%.0fms)", message, duration_ms)

_SALES_BY_REP_SUMMARY_TTL_SECONDS = 25
_sales_by_rep_summary_lock = threading.Lock()
_sales_by_rep_summary_inflight: Optional[threading.Event] = None
_sales_by_rep_summary_cache: Dict[str, object] = {
    "data": None,
    "fetchedAtMs": 0,
    "expiresAtMs": 0,
}

_SALES_REP_ORDERS_TTL_SECONDS = int(os.environ.get("SALES_REP_ORDERS_TTL_SECONDS", "20").strip() or 20)
_SALES_REP_ORDERS_TTL_SECONDS = max(3, min(_SALES_REP_ORDERS_TTL_SECONDS, 120))
_sales_rep_orders_cache_lock = threading.Lock()
_sales_rep_orders_cache: Dict[str, Dict[str, object]] = {}

_WOO_ORDER_RECONCILE_MAX_LOOKUPS = int(os.environ.get("WOO_ORDER_RECONCILE_MAX_LOOKUPS", "10").strip() or 10)
_WOO_ORDER_RECONCILE_MAX_LOOKUPS = max(0, min(_WOO_ORDER_RECONCILE_MAX_LOOKUPS, 25))

_ADMIN_TAXES_BY_STATE_TTL_SECONDS = int(os.environ.get("ADMIN_TAXES_BY_STATE_TTL_SECONDS", "25").strip() or 25)
_ADMIN_TAXES_BY_STATE_TTL_SECONDS = max(5, min(_ADMIN_TAXES_BY_STATE_TTL_SECONDS, 300))
_admin_taxes_by_state_lock = threading.Lock()
_admin_taxes_by_state_inflight: Optional[threading.Event] = None
_admin_taxes_by_state_cache: Dict[str, object] = {"data": None, "key": None, "expiresAtMs": 0}

_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS = int(os.environ.get("ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS", "25").strip() or 25)
_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS = max(5, min(_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS, 300))
_admin_products_commission_lock = threading.Lock()
_admin_products_commission_inflight: Optional[threading.Event] = None
_admin_products_commission_cache: Dict[str, object] = {"data": None, "key": None, "expiresAtMs": 0}


def _get_report_timezone() -> timezone:
    name = (os.environ.get("REPORT_TIMEZONE") or "America/Los_Angeles").strip() or "America/Los_Angeles"
    try:
        return ZoneInfo(name)
    except Exception:
        # Fallback: keep historical behavior (UTC) if tz database isn't available.
        return timezone.utc


def _resolve_report_period_bounds(
    period_start: Optional[str],
    period_end: Optional[str],
) -> tuple[datetime, datetime, Dict[str, str]]:
    """
    Interpret date-only inputs as PST/PDT day bounds:
      - start: 12:00:00am local
      - end:   11:59:59.999999pm local

    Returns (start_utc, end_utc, period_meta) where period_meta values are the local (PST/PDT) ISO strings.
    """

    tz = _get_report_timezone()

    def _is_date_only(text: str) -> bool:
        return len(text) == 10 and text[4] == "-" and text[7] == "-"

    def _parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
        if not value:
            return None
        text = str(value).strip()
        if not text:
            return None
        try:
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            parsed = datetime.fromisoformat(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except Exception:
            return None

    def _default_period_dates(now_local: datetime) -> tuple[date, date]:
        year = now_local.year
        month = now_local.month
        day_of_month = now_local.day
        # JS: new Date(year, month + 1, 0).getDate()
        if month == 12:
            first_next = date(year + 1, 1, 1)
        else:
            first_next = date(year, month + 1, 1)
        days_in_month = (first_next - timedelta(days=1)).day
        midpoint_day = int((days_in_month + 1) / 2)  # ceil(days/2)
        start_day = 1 if day_of_month <= midpoint_day else midpoint_day
        return date(year, month, start_day), now_local.date()

    now_local = datetime.now(tz)
    default_start_date, default_end_date = _default_period_dates(now_local)

    start_text = str(period_start or "").strip()
    end_text = str(period_end or "").strip()

    start_local: Optional[datetime] = None
    end_local: Optional[datetime] = None

    if start_text and _is_date_only(start_text):
        try:
            d = date.fromisoformat(start_text)
            start_local = datetime(d.year, d.month, d.day, 0, 0, 0, 0, tzinfo=tz)
        except Exception:
            start_local = None
    elif start_text:
        parsed = _parse_iso_datetime(start_text)
        if parsed is not None:
            start_local = parsed.astimezone(tz)

    if end_text and _is_date_only(end_text):
        try:
            d = date.fromisoformat(end_text)
            end_local = datetime(d.year, d.month, d.day, 23, 59, 59, 999999, tzinfo=tz)
        except Exception:
            end_local = None
    elif end_text:
        parsed = _parse_iso_datetime(end_text)
        if parsed is not None:
            end_local = parsed.astimezone(tz)

    if start_local is None:
        start_local = datetime(
            default_start_date.year,
            default_start_date.month,
            default_start_date.day,
            0,
            0,
            0,
            0,
            tzinfo=tz,
        )
    if end_local is None:
        end_local = datetime(
            default_end_date.year,
            default_end_date.month,
            default_end_date.day,
            23,
            59,
            59,
            999999,
            tzinfo=tz,
        )
    if end_local < start_local:
        start_local = datetime(
            default_start_date.year,
            default_start_date.month,
            default_start_date.day,
            0,
            0,
            0,
            0,
            tzinfo=tz,
        )
        end_local = datetime(
            default_end_date.year,
            default_end_date.month,
            default_end_date.day,
            23,
            59,
            59,
            999999,
            tzinfo=tz,
        )

    period_meta = {"periodStart": start_local.isoformat(), "periodEnd": end_local.isoformat()}
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc), period_meta


def _parse_datetime_utc(value: object) -> Optional[datetime]:
    """
    Best-effort ISO datetime parser that returns an aware UTC datetime.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    # Woo sometimes returns ISO-8601 with Z.
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    # Some sources may return a space separator.
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    try:
        parsed = datetime.fromisoformat(text)
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalize_email(value: Optional[str]) -> str:
    if not value:
        return ""
    return str(value).strip().lower()


def _is_doctor_role(role: Optional[str]) -> bool:
    normalized = str(role or "").strip().lower()
    return normalized in ("doctor", "test_doctor")


def _has_reseller_permit_on_file(user: Optional[Dict]) -> bool:
    if not isinstance(user, dict):
        return False
    doctor_id = str(user.get("id") or "").strip()
    email = _normalize_email(user.get("email"))
    if not doctor_id and not email:
        return False
    try:
        prospects = sales_prospect_repository.get_all()
    except Exception:
        return False
    for prospect in prospects or []:
        if not isinstance(prospect, dict):
            continue
        prospect_doctor_id = str(prospect.get("doctorId") or "").strip()
        prospect_email = _normalize_email(prospect.get("contactEmail"))
        matches_doctor = bool(doctor_id and prospect_doctor_id and prospect_doctor_id == doctor_id)
        matches_email = bool(email and prospect_email and prospect_email == email)
        if not matches_doctor and not matches_email:
            continue
        file_path = str(prospect.get("resellerPermitFilePath") or "").strip()
        if file_path:
            return True
    return False


def _is_tax_exempt_for_checkout(user: Optional[Dict]) -> bool:
    if not isinstance(user, dict) or not _is_doctor_role(user.get("role")):
        return False
    if bool(user.get("isTaxExempt")):
        return True
    return _has_reseller_permit_on_file(user)


def _compute_allowed_sales_rep_ids(
    sales_rep_id: str,
    users: List[Dict],
    rep_records: Dict[str, Dict],
) -> set[str]:
    normalized_sales_rep_id = str(sales_rep_id or "").strip()
    allowed_rep_ids: set[str] = {normalized_sales_rep_id} if normalized_sales_rep_id else set()

    legacy_map = {
        str(rep.get("legacyUserId")).strip(): str(rep_id)
        for rep_id, rep in rep_records.items()
        if rep.get("legacyUserId")
    }

    rep_record_id = legacy_map.get(normalized_sales_rep_id)
    if rep_record_id:
        allowed_rep_ids.add(str(rep_record_id))

    def add_legacy_user_id(rep: Dict | None):
        if not isinstance(rep, dict):
            return
        legacy_user_id = str(rep.get("legacyUserId") or "").strip()
        if legacy_user_id:
            allowed_rep_ids.add(str(legacy_user_id))

    direct_rep_record = rep_records.get(normalized_sales_rep_id) if normalized_sales_rep_id else None
    add_legacy_user_id(direct_rep_record if isinstance(direct_rep_record, dict) else None)
    add_legacy_user_id(rep_records.get(str(rep_record_id)) if rep_record_id else None)

    rep_user = next((u for u in users if str(u.get("id")) == normalized_sales_rep_id), None)
    rep_user_email = (rep_user.get("email") or "").strip().lower() if isinstance(rep_user, dict) else ""
    if rep_user_email:
        for rep_id, rep in rep_records.items():
            if (rep.get("email") or "").strip().lower() == rep_user_email:
                allowed_rep_ids.add(str(rep_id))
                add_legacy_user_id(rep)

    rep_email_candidates = set()
    if rep_user_email:
        rep_email_candidates.add(rep_user_email)
    for record in (
        direct_rep_record if isinstance(direct_rep_record, dict) else None,
        rep_records.get(str(rep_record_id)) if rep_record_id else None,
    ):
        if isinstance(record, dict):
            email = (record.get("email") or "").strip().lower()
            if email:
                rep_email_candidates.add(email)

    if rep_email_candidates:
        for user in users:
            email = (user.get("email") or "").strip().lower()
            if not email or email not in rep_email_candidates:
                continue
            role = (user.get("role") or "").lower()
            if role in ("sales_rep", "rep", "admin"):
                allowed_rep_ids.add(str(user.get("id")))

    return allowed_rep_ids


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


def estimate_order_totals(
    *,
    user_id: str,
    items: List[Dict],
    shipping_address: Dict,
    shipping_estimate: Optional[Dict] = None,
    shipping_total: float | int | str = 0,
    payment_method: Optional[str] = None,
) -> Dict:
    if not _validate_items(items):
        err = ValueError("Invalid items payload")
        setattr(err, "status", 400)
        raise err

    try:
        shipping_total_value = float(shipping_total or 0)
    except Exception:
        shipping_total_value = 0.0
    shipping_total_value = max(0.0, shipping_total_value)

    items_total = 0.0
    normalized_items: List[Dict] = []
    for item in items:
        try:
            unit_price = float(item.get("price") or 0)
            quantity = float(item.get("quantity") or 0)
        except Exception:
            unit_price = 0.0
            quantity = 0.0
        unit_price = max(0.0, unit_price)
        quantity = max(0.0, quantity)
        line_total = unit_price * quantity
        if line_total <= 0:
            continue
        items_total += line_total
        normalized_items.append(
            {
                "productId": item.get("productId") or item.get("id") or item.get("sku"),
                "price": unit_price,
                "quantity": quantity,
            }
        )

    if items_total <= 0:
        err = ValueError("No billable line items")
        setattr(err, "status", 400)
        raise err

    user = user_repository.find_by_id(user_id) if user_id else None
    role = str((user or {}).get("role") or "").strip().lower()
    raw_payment_method = str(payment_method or "").strip().lower()
    normalized_payment_method = raw_payment_method
    if normalized_payment_method in ("bacs", "bank", "bank_transfer", "direct_bank_transfer", "zelle"):
        normalized_payment_method = "bacs"
    else:
        normalized_payment_method = "stripe"

    settings = settings_service.get_settings()
    test_override_enabled = bool(settings.get("testPaymentsOverrideEnabled", False))
    test_override_allowed = role in ("admin", "test_doctor")
    test_override_payment = normalized_payment_method == "bacs"
    test_override = bool(test_override_enabled and test_override_allowed and test_override_payment)

    if _is_tax_exempt_for_checkout(user):
        original_grand_total = max(0.0, items_total + shipping_total_value)
        if test_override:
            return {
                "success": True,
                "totals": {
                    "itemsTotal": 0.01,
                    "shippingTotal": 0.0,
                    "taxTotal": 0.0,
                    "grandTotal": 0.01,
                    "currency": "USD",
                    "source": "tax_exempt",
                    "testPaymentOverrideApplied": True,
                    "originalItemsTotal": round(items_total, 2),
                    "originalShippingTotal": round(shipping_total_value, 2),
                    "originalTaxTotal": 0.0,
                    "originalGrandTotal": round(original_grand_total, 2),
                },
            }
        return {
            "success": True,
            "totals": {
                "itemsTotal": round(items_total, 2),
                "shippingTotal": round(shipping_total_value, 2),
                "taxTotal": 0.0,
                "grandTotal": round(original_grand_total, 2),
                "currency": "USD",
                "source": "tax_exempt",
                "testPaymentOverrideApplied": False,
            },
        }

    address = shipping_address or {}
    country = str(address.get("country") or "US").strip().upper()
    state = _normalize_address_field(address.get("state")) or ""
    postal = _normalize_address_field(address.get("postalCode") or address.get("postcode") or address.get("zip")) or ""
    if country == "US" and (not state or not postal):
        err = ValueError("Shipping address must include state and postal code")
        setattr(err, "status", 400)
        raise err

    tax_debug = (os.environ.get("STRIPE_TAX_DEBUG") or "").strip().lower() in ("1", "true", "yes", "on")
    if tax_debug:
        logger.info(
            "[TaxEstimate] Request userId=%s items=%s shippingTotal=%s destination=%s",
            str(user_id or ""),
            len(normalized_items),
            shipping_total_value,
            {"country": country, "state": state, "postal_code": postal, "city": address.get("city")},
        )

    tax_result = stripe_tax.calculate_tax_amount(
        items=normalized_items,
        shipping_address=address,
        shipping_total=shipping_total_value,
        currency="usd",
    )
    tax_total = float(tax_result.get("tax_total_cents") or 0) / 100.0
    tax_total = max(0.0, tax_total)
    grand_total = max(0.0, items_total + shipping_total_value + tax_total)

    totals = {
        "itemsTotal": round(items_total, 2),
        "shippingTotal": round(shipping_total_value, 2),
        "taxTotal": round(tax_total, 2),
        "grandTotal": round(grand_total, 2),
        "currency": "USD",
        "source": "stripe_tax",
        "stripeTaxCalculationId": tax_result.get("calculation_id"),
    }

    if test_override:
        totals = {
            **totals,
            "itemsTotal": 0.01,
            "shippingTotal": 0.0,
            "taxTotal": 0.0,
            "grandTotal": 0.01,
            "testPaymentOverrideApplied": True,
            "originalItemsTotal": round(items_total, 2),
            "originalShippingTotal": round(shipping_total_value, 2),
            "originalTaxTotal": round(tax_total, 2),
            "originalGrandTotal": round(grand_total, 2),
        }
    else:
        totals["testPaymentOverrideApplied"] = False

    if tax_debug:
        logger.info("[TaxEstimate] Result %s", totals)

    return {"success": True, "totals": totals}


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
    payment_method: Optional[str] = None,
    pricing_mode: Optional[str] = None,
    tax_total: Optional[float] = None,
    shipping_total: Optional[float] = None,
    shipping_address: Optional[Dict] = None,
    shipping_rate: Optional[Dict] = None,
    expected_shipment_window: Optional[str] = None,
    physician_certified: bool = False,
) -> Dict:
    if not _validate_items(items):
        raise _service_error("Order requires at least one item", 400)
    items_subtotal = 0.0
    for item in items or []:
        try:
            items_subtotal += float(item.get("price") or 0) * float(item.get("quantity") or 0)
        except Exception:
            continue
    items_subtotal = float(items_subtotal or 0)
    if items_subtotal <= 0:
        raise _service_error("Order requires at least one billable item", 400)

    user = user_repository.find_by_id(user_id)
    if not user:
        raise _service_error("User not found", 404)

    tax_exempt = _is_tax_exempt_for_checkout(user)
    sales_rep_ctx = _resolve_sales_rep_context(user)
    raw_payment_method = str(payment_method or "").strip().lower()
    normalized_payment_method = raw_payment_method
    if normalized_payment_method in ("bacs", "bank", "bank_transfer", "direct_bank_transfer", "zelle"):
        normalized_payment_method = "bacs"
    else:
        normalized_payment_method = "stripe"

    now = datetime.now(timezone.utc).isoformat()
    shipping_address = shipping_address or {}
    try:
        shipping_total_value = float(shipping_total or 0)
    except Exception:
        shipping_total_value = 0.0
    shipping_total_value = max(0.0, shipping_total_value)
    try:
        tax_total_value = float(tax_total or 0)
    except Exception:
        tax_total_value = 0.0
    tax_total_value = max(0.0, tax_total_value)
    if tax_exempt:
        tax_total_value = 0.0

    settings = settings_service.get_settings()
    role = str(user.get("role") or "").strip().lower()

    normalized_pricing_mode = str(pricing_mode or "").strip().lower()
    if normalized_pricing_mode not in ("retail", "wholesale"):
        normalized_pricing_mode = "wholesale"
    if role not in ("admin", "sales_rep", "rep"):
        normalized_pricing_mode = "wholesale"

    test_override_enabled = bool(settings.get("testPaymentsOverrideEnabled", False))
    test_override_allowed = role in ("admin", "test_doctor")
    test_override_payment = normalized_payment_method == "bacs"
    test_override = bool(test_override_enabled and test_override_allowed and test_override_payment)

    address_updates = _extract_user_address_fields(shipping_address)
    if any(address_updates.values()):
        updated_user = user_repository.update({**user, **address_updates})
        if updated_user:
            user = updated_user

    normalized_referral = (referral_code or "").strip().upper() or None
    if test_override:
        normalized_referral = None
    referral_effects: Dict = {}
    order = {
        "id": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
        "userId": user_id,
        "items": items,
        "pricingMode": normalized_pricing_mode,
        # `total` is the items subtotal; shipping/tax are tracked separately.
        "total": float(items_subtotal),
        "itemsSubtotal": float(items_subtotal),
        "shippingTotal": float(shipping_total_value),
        "taxTotal": float(tax_total_value),
        "shippingEstimate": shipping_rate or {},
        "shippingAddress": shipping_address or {},
        "referralCode": normalized_referral,
        "status": "pending",
        "createdAt": now,
        "expectedShipmentWindow": (expected_shipment_window or None),
        "physicianCertificationAccepted": bool(physician_certified),
        "paymentMethod": normalized_payment_method,
        "paymentDetails": raw_payment_method if normalized_payment_method == "bacs" else None,
        "doctorSalesRepId": sales_rep_ctx.get("id"),
        "doctorSalesRepName": sales_rep_ctx.get("name"),
        "doctorSalesRepEmail": sales_rep_ctx.get("email"),
        "doctorSalesRepCode": sales_rep_ctx.get("salesCode"),
    }

    if test_override:
        original_grand_total = round(max(0.0, items_subtotal + shipping_total_value + tax_total_value), 2)
        order["testPaymentOverride"] = {"enabled": True, "amount": 0.01, "originalGrandTotal": float(original_grand_total)}
        order["originalItemsSubtotal"] = float(items_subtotal)
        order["originalShippingTotal"] = float(shipping_total_value)
        order["originalTaxTotal"] = float(tax_total_value)
        order["total"] = 0.01
        order["itemsSubtotal"] = 0.01
        order["shippingTotal"] = 0.0
        order["taxTotal"] = 0.0
        order["grandTotal"] = 0.01
    else:
        # Auto-apply available referral credits to this order
        available_credit = float(user.get("referralCredits") or 0)
        if available_credit > 0 and items_subtotal > 0:
            applied = min(available_credit, items_subtotal)
            order["appliedReferralCredit"] = round(applied, 2)

        referral_effects = referral_service.handle_order_referral_effects(
            purchaser_id=user_id,
            referral_code=normalized_referral,
            order_total=float(items_subtotal),
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

        applied_credit_value = float(order.get("appliedReferralCredit") or 0) or 0.0
        order["grandTotal"] = round(
            max(0.0, items_subtotal - applied_credit_value + shipping_total_value + tax_total_value),
            2,
        )

    order_repository.insert(order)
    try:
        sales_prospect_repository.mark_doctor_as_nurturing_if_purchased(user_id)
    except Exception:
        pass

    integrations = {}

    try:
        t0 = time.perf_counter()
        integrations["wooCommerce"] = woo_commerce.forward_order(order, user)
        _perf_log(
            f"woo_commerce.forward_order orderId={order.get('id')} status={integrations.get('wooCommerce', {}).get('status')}",
            duration_ms=(time.perf_counter() - t0) * 1000,
        )
        woo_resp = integrations["wooCommerce"]
        if woo_resp.get("status") == "success":
            woo_response = woo_resp.get("response", {}) or {}
            woo_id = woo_response.get("id")
            woo_number = woo_response.get("number") or woo_id
            order["wooOrderId"] = woo_id
            order["wooOrderKey"] = woo_response.get("orderKey")
            order["wooOrderNumber"] = woo_number
            # Prefer Woo status/number for immediate display + dedupe in UI.
            if woo_response.get("status"):
                order["status"] = woo_response.get("status")
            if woo_number:
                order["number"] = woo_number
            try:
                order_repository.update_woo_fields(
                    order_id=order.get("id"),
                    woo_order_id=order.get("wooOrderId"),
                    woo_order_number=order.get("wooOrderNumber"),
                    woo_order_key=order.get("wooOrderKey"),
                )
            except Exception:
                pass
            try:
                print(
                    f"[checkout] woo linked order_id={order.get('id')} woo_id={order.get('wooOrderId')} woo_number={order.get('wooOrderNumber')} sales_rep_id={order.get('doctorSalesRepId')}",
                    flush=True,
                )
            except Exception:
                pass
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

    if order.get("wooOrderId") and normalized_payment_method != "bacs":
        try:
            t0 = time.perf_counter()
            integrations["stripe"] = stripe_payments.create_payment_intent(order)
            _perf_log(
                f"stripe_payments.create_payment_intent orderId={order.get('id')} status={integrations.get('stripe', {}).get('status')}",
                duration_ms=(time.perf_counter() - t0) * 1000,
            )
            if integrations["stripe"].get("paymentIntentId"):
                order["paymentIntentId"] = integrations["stripe"]["paymentIntentId"]
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
    elif normalized_payment_method == "bacs":
        integrations["stripe"] = {"status": "skipped", "reason": "payment_method_bacs"}
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

    # ShipEngine is no longer used in production (ShipStation handles fulfillment/inventory).
    integrations["shipEngine"] = {"status": "skipped", "reason": "deprecated"}

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


def sync_order_status_from_woo_webhook(order_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Mirror Woo order status into the local PepPro `orders` table (best-effort).

    This enables near-real-time status updates (e.g., on-hold -> processing) without relying on polling.
    """
    if not isinstance(order_data, dict):
        return {"status": "skipped", "reason": "invalid_payload"}

    raw_id = order_data.get("id")
    woo_order_id = str(raw_id).strip() if raw_id is not None else ""
    woo_order_number = str(order_data.get("number") or "").strip() or None
    woo_order_key = str(order_data.get("order_key") or "").strip() or None
    status = str(order_data.get("status") or "").strip().lower() or None

    if not woo_order_id or not status:
        return {"status": "skipped", "reason": "missing_id_or_status"}

    peppro_order_id = None
    meta = order_data.get("meta_data") or []
    if isinstance(meta, list):
        for entry in meta:
            if not isinstance(entry, dict):
                continue
            if str(entry.get("key") or "").strip() == "peppro_order_id":
                value = entry.get("value")
                peppro_order_id = str(value).strip() if value is not None else None
                if peppro_order_id:
                    break

    local_order = order_repository.find_by_id(peppro_order_id) if peppro_order_id else None
    if not local_order:
        local_order = _find_order_by_woo_id(woo_order_id) or (_find_order_by_woo_id(woo_order_number) if woo_order_number else None)
    if not local_order:
        return {"status": "skipped", "reason": "local_order_not_found", "wooOrderId": woo_order_id}

    changed = str(local_order.get("status") or "").strip().lower() != status

    # Prefer a lightweight DB update to avoid rewriting large payload JSON.
    try:
        order_repository.update_status_fields(
            str(local_order.get("id") or ""),
            status=status,
            woo_order_id=woo_order_id or None,
            woo_order_number=woo_order_number,
            woo_order_key=woo_order_key,
        )
    except Exception:
        # Fallback: update full record for non-MySQL installs.
        try:
            local_order["status"] = status
            if woo_order_id:
                local_order["wooOrderId"] = woo_order_id
            if woo_order_number:
                local_order["wooOrderNumber"] = woo_order_number
            if woo_order_key:
                local_order["wooOrderKey"] = woo_order_key
            local_order["updatedAt"] = datetime.now(timezone.utc).isoformat()
            order_repository.update(local_order)
        except Exception:
            pass

    return {
        "status": "updated" if changed else "noop",
        "orderId": local_order.get("id"),
        "wooOrderId": woo_order_id,
        "wooOrderNumber": woo_order_number,
        "wooStatus": status,
    }


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
        # MySQL `orders.total` is the full total (subtotal - discounts + shipping + tax).
        # Prefer the most accurate total we have without double-counting shipping.
        total_amount = float(local_order.get("grandTotal") or local_order.get("total") or 0)
    elif woo_order:
        meta = woo_order.get("meta_data") or []
        for entry in meta:
            if entry.get("key") == "stripe_payment_intent":
                payment_intent_id = entry.get("value")
                break
        try:
            # Woo's `total` is already the order total including tax+shipping.
            total_amount = float(woo_order.get("total") or 0)
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


def get_orders_for_user(user_id: str, *, force: bool = False):
    user = user_repository.find_by_id(user_id)
    if not user:
        raise _service_error("User not found", 404)

    local_orders = []
    woo_orders = []
    woo_error = None

    try:
        # Avoid pulling large payload columns; only load fields needed to overlay UI.
        local_orders = order_repository.list_user_overlay_fields(user_id) or []
    except Exception:
        local_orders = []

    email = (user.get("email") or "").strip().lower()
    if email:
        try:
            t0 = time.perf_counter()
            woo_orders = woo_commerce.fetch_orders_by_email(email, force=force)
            _perf_log(
                f"woo_commerce.fetch_orders_by_email userId={user_id} count={len(woo_orders) if isinstance(woo_orders, list) else 'n/a'}",
                duration_ms=(time.perf_counter() - t0) * 1000,
                threshold_ms=250.0,
            )
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

    # Reconcile local overlay records against Woo truth:
    # - If a Woo order was deleted, remove it from the local overlay response so it disappears from the UI.
    # - If a Woo order exists but isn't in the first-page email lookup, fetch it by id so it still shows.
    if (
        _WOO_ORDER_RECONCILE_MAX_LOOKUPS > 0
        and woo_error is None
        and isinstance(woo_orders, list)
        and isinstance(local_orders, list)
        and len(local_orders) > 0
        and woo_commerce.is_configured()
    ):
        def normalize_woo_id(value: object) -> str:
            text = str(value or "").strip()
            if text.startswith("#"):
                text = text[1:]
            if text.startswith("woo-"):
                text = text.split("-", 1)[1]
            return text.strip()

        existing_woo_ids: set[str] = set()
        for order in woo_orders:
            if not isinstance(order, dict):
                continue
            woo_id = normalize_woo_id(order.get("wooOrderId"))
            if woo_id:
                existing_woo_ids.add(woo_id)

        missing_ids: List[str] = []
        for local in local_orders:
            if not isinstance(local, dict):
                continue
            woo_id = normalize_woo_id(local.get("wooOrderId") or local.get("woo_order_id"))
            if not woo_id or woo_id in existing_woo_ids:
                continue
            missing_ids.append(woo_id)

        if missing_ids:
            seen: set[str] = set()
            missing_unique: List[str] = []
            for woo_id in missing_ids:
                if woo_id in seen:
                    continue
                seen.add(woo_id)
                missing_unique.append(woo_id)

            deleted_ids: set[str] = set()
            added = 0
            looked_up = 0
            for woo_id in missing_unique[:_WOO_ORDER_RECONCILE_MAX_LOOKUPS]:
                looked_up += 1
                result = woo_commerce.fetch_order_summary(str(woo_id))
                status = (result or {}).get("status")
                if status == "success" and isinstance((result or {}).get("order"), dict):
                    summary = (result or {}).get("order") or {}
                    summary_woo_id = normalize_woo_id(summary.get("wooOrderId") or woo_id)
                    if summary_woo_id and summary_woo_id not in existing_woo_ids:
                        woo_orders.append(summary)
                        existing_woo_ids.add(summary_woo_id)
                        added += 1
                elif status == "not_found":
                    deleted_ids.add(woo_id)

            if deleted_ids:
                before = len(local_orders)
                local_orders = [
                    local
                    for local in local_orders
                    if not (
                        isinstance(local, dict)
                        and normalize_woo_id(local.get("wooOrderId") or local.get("woo_order_id")) in deleted_ids
                    )
                ]
                removed = before - len(local_orders)
                if removed > 0:
                    logger.info(
                        "[Orders] Filtered deleted Woo orders from local overlay userId=%s removed=%s lookedUp=%s added=%s",
                        user_id,
                        removed,
                        looked_up,
                        added,
                    )

    merged_woo_orders = _merge_local_details_into_woo_orders(woo_orders or [], local_orders or [])

    # Also return local orders as a fallback (e.g., if Woo lookup fails due to missing email).
    # The frontend will dedupe/merge local vs Woo entries.
    local_summaries: List[Dict[str, Any]] = []
    for local in local_orders or []:
        if not isinstance(local, dict):
            continue
        identifier = str(local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id") or "").strip()
        if not identifier:
            continue
        local_summaries.append(
            {
                "id": identifier,
                "wooOrderId": local.get("wooOrderId") or None,
                "wooOrderNumber": local.get("wooOrderNumber") or None,
                "number": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "status": local.get("status") or "pending",
                "total": float(local.get("total") or 0),
                "shippingTotal": float(local.get("shippingTotal") or 0),
                "currency": local.get("currency") or "USD",
                "notes": local.get("notes") if local.get("notes") is not None else None,
                "createdAt": local.get("createdAt") or None,
                "updatedAt": local.get("updatedAt") or None,
                "shippingAddress": local.get("shippingAddress") or None,
                "expectedShipmentWindow": local.get("expectedShipmentWindow") or None,
                "shippingCarrier": local.get("shippingCarrier") or None,
                "shippingService": local.get("shippingService") or None,
                "lineItems": local.get("items") or [],
                "source": "peppro",
            }
        )

    # Enrich Woo orders with ShipStation status/tracking
    if merged_woo_orders:
        t0 = time.perf_counter()
        for woo_order in merged_woo_orders:
            _enrich_with_shipstation(woo_order)
        _perf_log(
            f"ship_station.enrich_orders userId={user_id} count={len(merged_woo_orders)}",
            duration_ms=(time.perf_counter() - t0) * 1000,
            threshold_ms=250.0,
        )

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
        "local": local_summaries,
        "woo": merged_woo_orders,
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "wooError": woo_error,
    }


def _merge_local_details_into_woo_orders(woo_orders: List[Dict], local_orders: List[Dict]) -> List[Dict]:
    if not woo_orders or not local_orders:
        return woo_orders

    local_lookup = {str(order.get("id")): order for order in local_orders if order.get("id")}
    local_by_woo_id: Dict[str, Dict] = {}
    local_by_woo_number: Dict[str, Dict] = {}
    for order in local_orders:
        if not isinstance(order, dict):
            continue
        woo_id = order.get("wooOrderId") or order.get("woo_order_id")
        woo_number = order.get("wooOrderNumber") or order.get("woo_order_number")
        if woo_id is not None:
            key = str(woo_id).strip()
            if key:
                local_by_woo_id[key] = order
        if woo_number is not None:
            key = str(woo_number).strip()
            if key:
                local_by_woo_number[key] = order

    for order in woo_orders:
        integrations = _ensure_dict(order.get("integrationDetails"))
        woo_details = _ensure_dict(integrations.get("wooCommerce") or integrations.get("woocommerce"))
        peppro_order_id = (
            woo_details.get("pepproOrderId")
            or woo_details.get("peppro_order_id")
            or order.get("pepproOrderId")
        )
        local_order = local_lookup.get(str(peppro_order_id)) if peppro_order_id else None
        if not local_order:
            woo_id = order.get("wooOrderId") or order.get("id")
            woo_number = order.get("wooOrderNumber") or order.get("number")
            local_order = (
                local_by_woo_id.get(str(woo_id).strip()) if woo_id is not None else None
            ) or (
                local_by_woo_number.get(str(woo_number).strip()) if woo_number is not None else None
            )
        if not local_order:
            continue

        # Prefer local status when present. The local `orders.status` is updated immediately
        # via Woo webhook -> MySQL, while Woo order fetches may be served from cache.
        local_status = local_order.get("status")
        if isinstance(local_status, str) and local_status.strip():
            order["status"] = local_status.strip()
            woo_details["status"] = order["status"]
            integrations["wooCommerce"] = woo_details
            order["integrationDetails"] = integrations

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

        if local_order.get("expectedShipmentWindow"):
            order["expectedShipmentWindow"] = local_order.get("expectedShipmentWindow")

        if local_order.get("notes") is not None:
            order["notes"] = local_order.get("notes")

        if local_order.get("trackingNumber") is not None:
            order["trackingNumber"] = local_order.get("trackingNumber")

        if local_order.get("shippingCarrier") is not None:
            order["shippingCarrier"] = local_order.get("shippingCarrier")
            order.setdefault("shippingEstimate", {})
            if isinstance(order.get("shippingEstimate"), dict):
                order["shippingEstimate"]["carrierId"] = local_order.get("shippingCarrier")
        if local_order.get("shippingService") is not None:
            order["shippingService"] = local_order.get("shippingService")
            order.setdefault("shippingEstimate", {})
            if isinstance(order.get("shippingEstimate"), dict):
                order["shippingEstimate"]["serviceType"] = local_order.get("shippingService")

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


def update_order_notes(*, order_id: str, actor: Dict, notes: Optional[str]) -> Dict:
    """
    Update local order notes. Notes are visible to the doctor.

    Allowed:
    - admin
    - sales_rep/rep for orders belonging to their assigned doctors
    """
    if not order_id:
        raise _service_error("ORDER_ID_REQUIRED", 400)
    actor_role = str(actor.get("role") or "").strip().lower()
    if actor_role not in ("admin", "sales_rep", "rep"):
        raise _service_error("SALES_REP_ACCESS_REQUIRED", 403)

    text = None
    if notes is not None:
        candidate = str(notes)
        candidate = candidate.replace("\x00", "").strip()
        candidate = candidate[:4000]
        text = candidate or None

    local_order = _find_order_by_woo_id(order_id) or order_repository.find_by_id(str(order_id))
    if not local_order:
        raise _service_error("ORDER_NOT_FOUND", 404)

    if actor_role != "admin":
        users = user_repository.get_all()
        rep_records = {
            str(rep.get("id")): rep
            for rep in sales_rep_repository.get_all()
            if isinstance(rep, dict) and rep.get("id") is not None
        }
        allowed_rep_ids = _compute_allowed_sales_rep_ids(str(actor.get("id") or ""), users, rep_records)

        doctor_id = str(local_order.get("userId") or local_order.get("user_id") or "").strip()
        doctor = user_repository.find_by_id(doctor_id) if doctor_id else None
        doctor_rep_id = str((doctor or {}).get("salesRepId") or (doctor or {}).get("sales_rep_id") or "").strip()
        order_rep_id = str(
            local_order.get("doctorSalesRepId")
            or local_order.get("salesRepId")
            or local_order.get("sales_rep_id")
            or local_order.get("doctor_sales_rep_id")
            or ""
        ).strip()

        if (doctor_rep_id and doctor_rep_id not in allowed_rep_ids) and (order_rep_id and order_rep_id not in allowed_rep_ids):
            raise _service_error("ORDER_NOT_FOUND", 404)

    updated = {**local_order, "notes": text, "updatedAt": datetime.now(timezone.utc).isoformat()}
    saved = order_repository.update(updated) or updated
    return {"order": saved}


def update_order_fields(
    *,
    order_id: str,
    actor: Dict,
    tracking_number: Optional[str] = None,
    shipping_carrier: Optional[str] = None,
    shipping_service: Optional[str] = None,
    status: Optional[str] = None,
    expected_shipment_window: Optional[str] = None,
) -> Dict:
    """
    Update local order fields for display in the app (PepPro-local metadata).

    Allowed:
    - admin
    - sales_rep/rep for orders belonging to their assigned doctors
    """
    if not order_id:
        raise _service_error("ORDER_ID_REQUIRED", 400)
    actor_role = str(actor.get("role") or "").strip().lower()
    if actor_role not in ("admin", "sales_rep", "rep"):
        raise _service_error("SALES_REP_ACCESS_REQUIRED", 403)

    def _sanitize_optional_text(value: Optional[str], *, max_len: int) -> Optional[str]:
        if value is None:
            return None
        candidate = str(value).replace("\x00", "").strip()
        candidate = candidate[:max_len]
        return candidate or None

    tracking = _sanitize_optional_text(tracking_number, max_len=64)
    carrier = _sanitize_optional_text(shipping_carrier, max_len=64)
    service = _sanitize_optional_text(shipping_service, max_len=128)
    status_value = _sanitize_optional_text(status, max_len=32)
    expected_window = _sanitize_optional_text(expected_shipment_window, max_len=64)

    local_order = _find_order_by_woo_id(order_id) or order_repository.find_by_id(str(order_id))
    if not local_order:
        raise _service_error("ORDER_NOT_FOUND", 404)

    if actor_role != "admin":
        users = user_repository.get_all()
        rep_records = {
            str(rep.get("id")): rep
            for rep in sales_rep_repository.get_all()
            if isinstance(rep, dict) and rep.get("id") is not None
        }
        allowed_rep_ids = _compute_allowed_sales_rep_ids(str(actor.get("id") or ""), users, rep_records)

        doctor_id = str(local_order.get("userId") or local_order.get("user_id") or "").strip()
        doctor = user_repository.find_by_id(doctor_id) if doctor_id else None
        doctor_rep_id = str((doctor or {}).get("salesRepId") or (doctor or {}).get("sales_rep_id") or "").strip()
        order_rep_id = str(
            local_order.get("doctorSalesRepId")
            or local_order.get("salesRepId")
            or local_order.get("sales_rep_id")
            or local_order.get("doctor_sales_rep_id")
            or ""
        ).strip()

        if (doctor_rep_id and doctor_rep_id not in allowed_rep_ids) and (order_rep_id and order_rep_id not in allowed_rep_ids):
            raise _service_error("ORDER_NOT_FOUND", 404)

    updated = dict(local_order)
    if tracking_number is not None:
        updated["trackingNumber"] = tracking
    if shipping_carrier is not None:
        updated["shippingCarrier"] = carrier
    if shipping_service is not None:
        updated["shippingService"] = service
    if status is not None:
        updated["status"] = status_value or updated.get("status") or "pending"
    if expected_shipment_window is not None:
        updated["expectedShipmentWindow"] = expected_window

    if shipping_carrier is not None or shipping_service is not None:
        estimate = _ensure_dict(updated.get("shippingEstimate"))
        if shipping_carrier is not None:
            estimate["carrierId"] = carrier
        if shipping_service is not None:
            estimate["serviceType"] = service
        updated["shippingEstimate"] = estimate

    updated["updatedAt"] = datetime.now(timezone.utc).isoformat()
    saved = order_repository.update(updated) or updated
    return {"order": saved}


def get_orders_for_sales_rep(sales_rep_id: str, include_doctors: bool = False, force: bool = False):
    logger.info("[SalesRep] Fetch start salesRepId=%s includeDoctors=%s", sales_rep_id, include_doctors)
    cache_key = f"{str(sales_rep_id)}::{'withDoctors' if include_doctors else 'ordersOnly'}"
    now = time.time()
    if not force and _SALES_REP_ORDERS_TTL_SECONDS > 0:
        with _sales_rep_orders_cache_lock:
            cached = _sales_rep_orders_cache.get(cache_key)
            if cached and float(cached.get("expiresAt") or 0) > now:
                logger.info(
                    "[SalesRep] Cache hit salesRepId=%s ttlSeconds=%s",
                    sales_rep_id,
                    _SALES_REP_ORDERS_TTL_SECONDS,
                )
                return cached.get("value")
    users = user_repository.get_all()
    user_by_id = {str(u.get("id")): u for u in users if isinstance(u, dict) and u.get("id") is not None}
    rep_records = {str(rep.get("id")): rep for rep in sales_rep_repository.get_all() if rep.get("id")}
    allowed_rep_ids = _compute_allowed_sales_rep_ids(sales_rep_id, users, rep_records)

    doctors = []
    for user in users:
        role = (user.get("role") or "").lower()
        if role not in ("doctor", "test_doctor"):
            continue
        doctor_sales_rep = str(user.get("salesRepId") or user.get("sales_rep_id") or "")
        if doctor_sales_rep not in allowed_rep_ids:
            continue
        doctors.append(user)

    # Ensure doctors have a stable lead type stored for commission tracking.
    try:
        doctors = referral_service.backfill_lead_types_for_doctors(doctors)
    except Exception:
        pass

    doctor_lookup = {
        str(doc.get("id")): {
            "id": doc.get("id"),
            "name": doc.get("name") or doc.get("email") or "Doctor",
            "email": doc.get("email"),
            "phone": doc.get("phone"),
            "profileImageUrl": doc.get("profileImageUrl"),
            "leadType": doc.get("leadType"),
            "leadTypeSource": doc.get("leadTypeSource"),
            "leadTypeLockedAt": doc.get("leadTypeLockedAt"),
            "address1": doc.get("officeAddressLine1"),
            "address2": doc.get("officeAddressLine2"),
            "city": doc.get("officeCity"),
            "state": doc.get("officeState"),
            "postalCode": doc.get("officePostalCode"),
            "country": doc.get("officeCountry"),
        }
        for doc in doctors
        if doc.get("id") is not None
    }

    def _normalize_rep_id(value: object) -> str:
        if value is None:
            return ""
        return str(value).strip()

    def _meta_value(meta: object, key: str):
        if not isinstance(meta, list):
            return None
        for entry in meta:
            if isinstance(entry, dict) and entry.get("key") == key:
                return entry.get("value")
        return None

    # Pull local PepPro orders to support:
    # - reps seeing orders even when billing email doesn't match the doctor email
    # - resolving doctorId via Woo meta `peppro_order_id`
    local_by_id: Dict[str, Dict] = {}
    try:
        doctor_ids = [str(doc.get("id")) for doc in doctors if doc.get("id") is not None]
        local_orders = order_repository.find_by_user_ids(doctor_ids) if doctor_ids else []
    except Exception:
        local_orders = []

    # Fallback scan catches cases where the doctor user isn't linked to the rep, but the order payload contains doctorSalesRepId.
    if not local_orders:
        try:
            local_orders = order_repository.list_recent(750)
        except Exception:
            local_orders = []

    seen_local_doctor_ids = set(str(doc.get("id")) for doc in doctors if doc.get("id") is not None)
    for local in local_orders or []:
        if not isinstance(local, dict):
            continue
        local_id = local.get("id")
        if local_id is None:
            continue
        local_user_id = str(local.get("userId") or local.get("user_id") or "").strip()
        if not local_user_id:
            continue

        local_user = user_by_id.get(local_user_id)
        local_role = (local_user.get("role") or "").lower() if isinstance(local_user, dict) else ""
        if local_role and local_role not in ("doctor", "test_doctor"):
            continue

        rep_from_order = _normalize_rep_id(
            local.get("doctorSalesRepId")
            or local.get("salesRepId")
            or local.get("sales_rep_id")
            or local.get("doctor_sales_rep_id")
        )
        rep_from_user = _normalize_rep_id(
            (local_user or {}).get("salesRepId")
            or (local_user or {}).get("sales_rep_id")
        )
        if not (
            (rep_from_order and rep_from_order in allowed_rep_ids)
            or (rep_from_user and rep_from_user in allowed_rep_ids)
        ):
            continue

        local_by_id[str(local_id)] = local

        # Ensure the doctor appears in the `doctors` payload even if their `salesRepId` wasn't set.
        if local_user_id not in doctor_lookup and isinstance(local_user, dict):
            doctor_lookup[local_user_id] = {
                "id": local_user.get("id"),
                "name": local_user.get("name") or local_user.get("email") or "Doctor",
                "email": local_user.get("email"),
                "phone": local_user.get("phone"),
                "profileImageUrl": local_user.get("profileImageUrl"),
                "leadType": local_user.get("leadType"),
                "leadTypeSource": local_user.get("leadTypeSource"),
                "leadTypeLockedAt": local_user.get("leadTypeLockedAt"),
                "address1": local_user.get("officeAddressLine1"),
                "address2": local_user.get("officeAddressLine2"),
                "city": local_user.get("officeCity"),
                "state": local_user.get("officeState"),
                "postalCode": local_user.get("officePostalCode"),
                "country": local_user.get("officeCountry"),
            }
        if local_user_id and local_user_id not in seen_local_doctor_ids and isinstance(local_user, dict):
            doctors.append(local_user)
            seen_local_doctor_ids.add(local_user_id)

    summaries: List[Dict] = []
    seen_keys = set()

    # WooCommerce orders (if configured) - single paged pull, filter by doctor email.
    woo_enabled = woo_commerce.is_configured()
    logger.info(
        "[SalesRep] Doctor list computed salesRepId=%s doctorCount=%s wooEnabled=%s doctorEmails=%s",
        sales_rep_id,
        len(doctors),
        woo_enabled,
        [d.get("email") for d in doctors],
    )
    if woo_enabled:
        # Build lookup: normalized email -> list of doctor metadata
        email_to_doctors: Dict[str, List[Dict[str, object]]] = {}
        for doctor in doctors:
            doctor_id = doctor.get("id")
            doctor_name = doctor.get("name") or doctor.get("email") or "Doctor"
            doctor_email = (doctor.get("email") or "").strip()
            candidate_emails: List[str] = []
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
            for key in ("emails", "alternateEmails", "altEmails", "aliases"):
                val = doctor.get(key)
                if isinstance(val, list):
                    for item in val:
                        email_candidate = (item or "").strip().lower()
                        if email_candidate:
                            candidate_emails.append(email_candidate)
            normalized_emails: List[str] = []
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
            for em in normalized_emails:
                email_to_doctors.setdefault(em, []).append(
                    {
                        "id": doctor_id,
                        "name": doctor_name,
                        "email": doctor_email,
                    }
                )

        per_page = 50
        max_pages = 20
        orders_seen = 0
        pages_fetched = 0
        for page in range(1, max_pages + 1):
            payload, _meta = woo_commerce.fetch_catalog_proxy(
                "orders",
                {"per_page": per_page, "page": page, "orderby": "date", "order": "desc", "status": "any"},
            )
            orders = payload if isinstance(payload, list) else []
            pages_fetched += 1
            if not orders:
                break

            for woo_order in orders:
                if not isinstance(woo_order, dict):
                    continue
                meta_data = woo_order.get("meta_data") or []
                rep_id = _normalize_rep_id(_meta_value(meta_data, "peppro_sales_rep_id"))
                billing_email = str((woo_order.get("billing") or {}).get("email") or "").strip().lower()
                if not (
                    (rep_id and rep_id in allowed_rep_ids)
                    or (billing_email and billing_email in email_to_doctors)
                ):
                    continue

                doctor_metas: List[Dict[str, object]] = []
                if billing_email and billing_email in email_to_doctors:
                    doctor_metas = email_to_doctors.get(billing_email, [])
                else:
                    # Fallback: resolve doctor via local PepPro order id (`peppro_order_id`).
                    peppro_order_id = _meta_value(meta_data, "peppro_order_id")
                    peppro_order_id = str(peppro_order_id).strip() if peppro_order_id is not None else ""
                    local = local_by_id.get(peppro_order_id) if peppro_order_id else None
                    if local:
                        local_user_id = str(local.get("userId") or local.get("user_id") or "").strip()
                        doctor_meta = doctor_lookup.get(local_user_id) if local_user_id else None
                        if doctor_meta:
                            doctor_metas = [doctor_meta]

                if not doctor_metas:
                    # Still show activity for rep-attributed orders even if we can't map to a doctor row.
                    doctor_metas = [
                        {
                            "id": billing_email or None,
                            "name": billing_email or "Doctor",
                            "email": billing_email or None,
                        }
                    ]

                for doctor_meta in doctor_metas:
                    key = f"woo:{woo_order.get('id')}:{doctor_meta.get('id') or billing_email or ''}"
                    if key in seen_keys:
                        continue
                    seen_keys.add(key)
                    mapped = woo_commerce._map_woo_order_summary(woo_order)
                    summary = {
                        **mapped,
                        "doctorId": doctor_meta.get("id"),
                        "doctorName": doctor_meta.get("name"),
                        "doctorEmail": doctor_meta.get("email"),
                        "userId": doctor_meta.get("id"),
                        "source": "woocommerce",
                    }
                    _enrich_with_shipstation(summary)
                    summaries.append(summary)
                    orders_seen += 1

            if len(orders) < per_page:
                break

        logger.info(
            "[SalesRep] Woo orders fetched via paged pull salesRepId=%s pages=%s perPage=%s matchedOrders=%s",
            sales_rep_id,
            pages_fetched,
            per_page,
            orders_seen,
        )

    # If Woo is not configured, fall back to local PepPro orders so reps can still see activity.
    if not woo_enabled and local_by_id:
        for local in local_by_id.values():
            local_user_id = str(local.get("userId") or local.get("user_id") or "").strip()
            doctor_meta = doctor_lookup.get(local_user_id) or {}
            key = f"local:{local.get('id')}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            summary = {
                "id": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "wooOrderId": local.get("wooOrderId") or None,
                "wooOrderNumber": local.get("wooOrderNumber") or None,
                "number": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "status": local.get("status") or "pending",
                "total": float(local.get("grandTotal") or local.get("total") or 0),
                "taxTotal": float(local.get("taxTotal") or 0),
                "grandTotal": float(local.get("grandTotal") or local.get("total") or 0),
                "currency": local.get("currency") or "USD",
                "paymentMethod": local.get("paymentMethod") or None,
                "paymentDetails": local.get("paymentDetails") or local.get("paymentMethod") or None,
                "shippingTotal": float(local.get("shippingTotal") or 0),
                "createdAt": local.get("createdAt") or None,
                "updatedAt": local.get("updatedAt") or None,
                "shippingAddress": local.get("shippingAddress") or None,
                "billingAddress": local.get("billingAddress") or None,
                "shippingEstimate": local.get("shippingEstimate") or None,
                "lineItems": local.get("items") or [],
                "doctorId": doctor_meta.get("id") or local_user_id or None,
                "doctorName": doctor_meta.get("name") or doctor_meta.get("email") or "Doctor",
                "doctorEmail": doctor_meta.get("email") or None,
                "userId": doctor_meta.get("id") or local_user_id or None,
                "source": "peppro",
            }
            _enrich_with_shipstation(summary)
            summaries.append(summary)

    summaries.sort(key=lambda o: o.get("createdAt") or "", reverse=True)

    try:
        nurturing_candidates = sorted(
            {
                str(order.get("doctorId"))
                for order in summaries
                if order.get("doctorId") is not None and str(order.get("doctorId")).strip()
            }
        )
        for doctor_id in nurturing_candidates:
            try:
                sales_prospect_repository.mark_doctor_as_nurturing_if_purchased(doctor_id)
            except Exception:
                pass
    except Exception:
        pass

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

    result = (
        {
            "orders": summaries,
            "doctors": list(doctor_lookup.values()),
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
        }
        if include_doctors
        else summaries
    )
    if _SALES_REP_ORDERS_TTL_SECONDS > 0:
        with _sales_rep_orders_cache_lock:
            _sales_rep_orders_cache[cache_key] = {
                "value": result,
                "expiresAt": now + _SALES_REP_ORDERS_TTL_SECONDS,
            }
    return result


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
            exc_info=False,
            extra={
                "orderNumber": order_number,
                "status": getattr(exc, "status", None),
                "error": str(exc),
            },
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


def get_sales_rep_order_detail(order_id: str, sales_rep_id: str, token_role: Optional[str] = None) -> Optional[Dict]:
    """
    Fetch a single Woo order detail and ensure it belongs to a doctor tied to this sales rep.
    """
    if not order_id:
        return None
    if not woo_commerce.is_configured():
        return None

    try:
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
    except Exception:
        # Avoid returning a 500 when the store is having issues; surface a clean 503.
        raise _service_error("Unable to load order details right now. Please try again soon.", 503)

    try:
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
    except Exception:
        raise _service_error("Unable to load order details right now. Please try again soon.", 503)

    # Enrich with ShipStation status/tracking when available
    shipstation_info = None
    try:
        shipstation_info = ship_station.fetch_order_status(
            mapped.get("number") or mapped.get("wooOrderNumber")
        )
    except ship_station.IntegrationError as exc:  # pragma: no cover - network path
        logger.warning(
            "ShipStation status lookup failed",
            exc_info=False,
            extra={
                "orderId": order_id,
                "status": getattr(exc, "status", None),
                "error": str(exc),
            },
        )
    except Exception:
        # Non-fatal enrichment failure.
        shipstation_info = None

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
        is_admin_request = (token_role or "").strip().lower() == "admin"
        if not is_admin_request:
            users = user_repository.get_all()
            rep_records = {str(rep.get("id")): rep for rep in sales_rep_repository.get_all() if rep.get("id")}
            allowed_rep_ids = _compute_allowed_sales_rep_ids(sales_rep_id, users, rep_records)

            doctor_sales_rep = str(doctor.get("salesRepId") or doctor.get("sales_rep_id") or "")
            if doctor_sales_rep and doctor_sales_rep not in allowed_rep_ids:
                raise _service_error("Order not found", 404)
    else:
        # If we can't associate to a known doctor, don't leak order detail to arbitrary reps.
        raise _service_error("Order not found", 404)
    if doctor:
        mapped["doctorId"] = doctor.get("id")
        mapped["doctorName"] = doctor.get("name") or billing_email
        mapped["doctorEmail"] = doctor.get("email")
        mapped["doctorSalesRepId"] = doctor.get("salesRepId")

    # Pull local PepPro order fields (MySQL `orders` table) for display-only details like notes.
    # Prefer lookup by pepproOrderId to avoid scanning all orders.
    try:
        integrations = _ensure_dict(mapped.get("integrationDetails") or mapped.get("integrations"))
        woo_details = _ensure_dict(integrations.get("wooCommerce") or integrations.get("woocommerce"))
        peppro_order_id = woo_details.get("pepproOrderId") or woo_details.get("peppro_order_id") or None
        local_order = None
        if peppro_order_id:
            local_order = order_repository.find_by_id(str(peppro_order_id))
        if not local_order:
            local_order = _find_order_by_woo_id(str(mapped.get("wooOrderId") or mapped.get("id") or mapped.get("wooOrderNumber") or "")) or None
        if local_order:
            if local_order.get("notes") is not None:
                mapped["notes"] = local_order.get("notes")
            if local_order.get("trackingNumber") is not None:
                mapped["trackingNumber"] = local_order.get("trackingNumber")
            if local_order.get("shippingCarrier") is not None:
                mapped["shippingCarrier"] = local_order.get("shippingCarrier")
                mapped.setdefault("shippingEstimate", {})
                if isinstance(mapped.get("shippingEstimate"), dict):
                    mapped["shippingEstimate"]["carrierId"] = local_order.get("shippingCarrier")
            if local_order.get("shippingService") is not None:
                mapped["shippingService"] = local_order.get("shippingService")
                mapped.setdefault("shippingEstimate", {})
                if isinstance(mapped.get("shippingEstimate"), dict):
                    mapped["shippingEstimate"]["serviceType"] = local_order.get("shippingService")
    except Exception:
        pass
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


def get_sales_by_rep(
    exclude_sales_rep_id: Optional[str] = None,
    period_start: Optional[str] = None,
    period_end: Optional[str] = None,
):
    global _sales_by_rep_summary_inflight

    start_dt, end_dt, period_meta = _resolve_report_period_bounds(period_start, period_end)
    period_cache_key = f"{period_meta['periodStart']}::{period_meta['periodEnd']}"

    def _meta_value(meta: object, key: str):
        if not isinstance(meta, list):
            return None
        for entry in meta:
            if isinstance(entry, dict) and entry.get("key") == key:
                return entry.get("value")
        return None

    def _is_truthy(value: object) -> bool:
        if value is True:
            return True
        if value is False or value is None:
            return False
        if isinstance(value, (int, float)):
            try:
                return float(value) != 0
            except Exception:
                return False
        text = str(value).strip().lower()
        return text in ("1", "true", "yes", "y", "on")

    def _safe_float(value: object) -> float:
        try:
            if value is None:
                return 0.0
            return float(value)
        except Exception:
            try:
                return float(str(value).strip() or 0)
            except Exception:
                return 0.0

    def _compute_summary() -> Dict[str, Any]:
        users = user_repository.get_all()
        reps = [u for u in users if (u.get("role") or "").lower() == "sales_rep"]
        rep_records_list = sales_rep_repository.get_all()
        rep_records = {str(rep.get("id")): rep for rep in rep_records_list if rep.get("id")}
        user_lookup = {str(u.get("id")): u for u in users if u.get("id")}

        def _norm_email(value: object) -> str:
            return str(value or "").strip().lower()

        # Canonicalize sales rep ids so we don't double-count reps that exist in both
        # `users` and `sales_reps` with different ids. Prefer `users` as the source of truth
        # for display names (sales reps manage their own name there).
        user_rep_id_by_email: Dict[str, str] = {}
        for rep in reps:
            rep_id = rep.get("id")
            email = _norm_email(rep.get("email"))
            if rep_id and email:
                user_rep_id_by_email[email] = str(rep_id)

        # Map any known alias id (sales_reps.id, legacy_user_id, user.id) -> canonical user id when possible.
        alias_to_rep_id: Dict[str, str] = {}
        for rep in reps:
            rep_id = rep.get("id")
            if rep_id:
                rep_id_str = str(rep_id)
                alias_to_rep_id[rep_id_str] = rep_id_str

        for rep in rep_records_list:
            rep_id = rep.get("id")
            if not rep_id:
                continue
            rep_id_str = str(rep_id)
            rep_email = _norm_email(rep.get("email"))
            canonical = user_rep_id_by_email.get(rep_email) or rep_id_str
            alias_to_rep_id[rep_id_str] = canonical
            legacy_id = rep.get("legacyUserId") or rep.get("legacy_user_id")
            if legacy_id:
                alias_to_rep_id[str(legacy_id)] = canonical

        # Used as a fallback when older Woo orders are missing meta.
        doctors_by_email = {}
        for u in users:
            if (u.get("role") or "").lower() not in ("doctor", "test_doctor"):
                continue
            email = (u.get("email") or "").strip().lower()
            if email:
                doctors_by_email[email] = u

        # Any order placed by an email present in the MySQL `contact_forms` table should be
        # treated as a house/contact-form order and split across admins.
        contact_form_emails: set[str] = set()
        try:
            from . import get_config  # type: ignore
            from ..database import mysql_client  # type: ignore

            if bool(get_config().mysql.get("enabled")):
                rows = mysql_client.fetch_all("SELECT DISTINCT email FROM contact_forms", {})
                for row in rows or []:
                    if not isinstance(row, dict):
                        continue
                    form_email = _norm_email(row.get("email"))
                    if form_email:
                        contact_form_emails.add(form_email)
        except Exception:
            contact_form_emails = set()

        valid_rep_ids = {alias_to_rep_id[str(rep.get("id"))] for rep in reps if rep.get("id")}
        for rep in rep_records_list:
            rep_id = rep.get("id")
            if rep_id:
                valid_rep_ids.add(alias_to_rep_id.get(str(rep_id), str(rep_id)))

        logger.info(
            "[SalesByRep] Begin aggregation",
            extra={
                "validRepCount": len(valid_rep_ids),
                "userReps": len(reps),
                "repoReps": len(rep_records_list),
            },
        )

        attributed_orders: List[Dict[str, object]] = []
        debug_samples: List[Dict[str, object]] = []
        counted_rep = 0
        counted_house = 0
        skipped_unattributed = 0
        skipped_status = 0
        skipped_refunded = 0
        skipped_outside_period = 0

        # WooCommerce is the source of truth for order history.
        per_page = 100
        max_pages = 25
        orders_seen = 0
        for page in range(1, max_pages + 1):
            payload, _meta = woo_commerce.fetch_catalog_proxy(
                "orders",
                {"per_page": per_page, "page": page, "orderby": "date", "order": "desc", "status": "any"},
            )
            orders = payload if isinstance(payload, list) else []
            if not orders:
                break

            for woo_order in orders:
                if not isinstance(woo_order, dict):
                    continue
                status = str(woo_order.get("status") or "").strip().lower()
                if status not in ("processing", "completed"):
                    skipped_status += 1
                    continue
                meta_data = woo_order.get("meta_data") or []
                if _is_truthy(_meta_value(meta_data, "peppro_refunded")) or status == "refunded":
                    skipped_refunded += 1
                    continue

                # Filter to the requested/computed biweekly period.
                created_raw = (
                    woo_order.get("date_created_gmt")
                    or woo_order.get("date_created")
                    or woo_order.get("date")
                    or None
                )
                created_at = _parse_datetime_utc(created_raw)
                if not created_at:
                    # If unknown, skip rather than misattribute outside period.
                    skipped_outside_period += 1
                    continue
                if created_at < start_dt or created_at > end_dt:
                    skipped_outside_period += 1
                    continue

                rep_id = _meta_value(meta_data, "peppro_sales_rep_id")
                rep_id = str(rep_id).strip() if rep_id is not None else ""
                if rep_id:
                    rep_id = alias_to_rep_id.get(rep_id, rep_id)

                billing_email = str((woo_order.get("billing") or {}).get("email") or "").strip().lower()
                force_house_contact_form = bool(billing_email and billing_email in contact_form_emails)

                if not rep_id:
                    # If a sales rep placed the order, it should never be counted as "house".
                    rep_id = user_rep_id_by_email.get(billing_email, "")

                if not rep_id:
                    doctor = doctors_by_email.get(billing_email)
                    rep_id = str(doctor.get("salesRepId") or "").strip() if doctor else ""
                    if rep_id:
                        rep_id = alias_to_rep_id.get(rep_id, rep_id)

                total = _safe_float(woo_order.get("total"))

                if rep_id and rep_id in valid_rep_ids:
                    pricing_mode_hint = (
                        _meta_value(meta_data, "peppro_pricing_mode")
                        or _meta_value(meta_data, "peppro_pricingMode")
                        or _meta_value(meta_data, "pricing_mode")
                        or _meta_value(meta_data, "pricingMode")
                    )
                    attributed_orders.append(
                        {
                            "salesRepId": rep_id,
                            "total": total,
                            "wooId": woo_order.get("id"),
                            "wooNumber": woo_order.get("number"),
                            "pricingModeHint": pricing_mode_hint,
                        }
                    )
                    counted_rep += 1
                else:
                    # "House" sales are only for doctors acquired via the contact form.
                    is_house_contact_form = False
                    if billing_email:
                        doctor = doctors_by_email.get(billing_email)
                        if doctor and str(doctor.get("salesRepId") or "").strip() == "house":
                            is_house_contact_form = True
                        else:
                            try:
                                from ..repositories import sales_prospect_repository

                                prospect = sales_prospect_repository.find_by_contact_email(billing_email)
                                if prospect and str(prospect.get("salesRepId") or "") == "house":
                                    is_house_contact_form = True
                            except Exception:
                                is_house_contact_form = False

                    if is_house_contact_form:
                        pricing_mode_hint = (
                            _meta_value(meta_data, "peppro_pricing_mode")
                            or _meta_value(meta_data, "peppro_pricingMode")
                            or _meta_value(meta_data, "pricing_mode")
                            or _meta_value(meta_data, "pricingMode")
                        )
                        attributed_orders.append(
                            {
                                "salesRepId": "__house__",
                                "total": total,
                                "wooId": woo_order.get("id"),
                                "wooNumber": woo_order.get("number"),
                                "pricingModeHint": pricing_mode_hint,
                            }
                        )
                        counted_house += 1
                    else:
                        skipped_unattributed += 1

                if len(debug_samples) < 10:
                    debug_samples.append(
                        {
                            "wooId": woo_order.get("id"),
                            "wooNumber": woo_order.get("number"),
                            "status": status,
                            "repId": rep_id or None,
                            "metaRepId": _meta_value(meta_data, "peppro_sales_rep_id"),
                            "billingEmail": ((woo_order.get("billing") or {}) or {}).get("email"),
                            "total": total,
                            "pricingModeHint": _meta_value(meta_data, "peppro_pricing_mode")
                            or _meta_value(meta_data, "peppro_pricingMode")
                            or _meta_value(meta_data, "pricing_mode")
                            or _meta_value(meta_data, "pricingMode"),
                        }
                    )

                orders_seen += 1

            if len(orders) < per_page:
                break

        def _normalize_token(value: object) -> str:
            if value is None:
                return ""
            text = str(value).strip()
            if not text:
                return ""
            return text[1:] if text.startswith("#") else text

        woo_ids = []
        woo_numbers = []
        for entry in attributed_orders:
            woo_id = _normalize_token(entry.get("wooId"))
            if woo_id:
                woo_ids.append(woo_id)
            woo_num = _normalize_token(entry.get("wooNumber"))
            if woo_num:
                woo_numbers.append(woo_num)

        pricing_mode_lookup = order_repository.get_pricing_mode_lookup_by_woo(woo_ids, woo_numbers)

        def _resolve_pricing_mode(entry: Dict[str, object]) -> str:
            hint = str(entry.get("pricingModeHint") or "").strip().lower()
            if hint in ("retail", "wholesale"):
                return hint
            woo_id = _normalize_token(entry.get("wooId"))
            if woo_id and woo_id in pricing_mode_lookup:
                return pricing_mode_lookup[woo_id]
            woo_number = _normalize_token(entry.get("wooNumber"))
            if woo_number and woo_number in pricing_mode_lookup:
                return pricing_mode_lookup[woo_number]
            return "wholesale"

        rep_totals: Dict[str, Dict[str, float]] = {}
        house_totals = {"totalOrders": 0.0, "totalRevenue": 0.0, "wholesaleRevenue": 0.0, "retailRevenue": 0.0}

        for entry in attributed_orders:
            rep_id = str(entry.get("salesRepId") or "").strip()
            total = _safe_float(entry.get("total"))
            pricing_mode = _resolve_pricing_mode(entry)
            if rep_id == "__house__":
                house_totals["totalOrders"] += 1.0
                house_totals["totalRevenue"] += total
                if pricing_mode == "retail":
                    house_totals["retailRevenue"] += total
                else:
                    house_totals["wholesaleRevenue"] += total
                continue

            current = rep_totals.get(
                rep_id,
                {"totalOrders": 0.0, "totalRevenue": 0.0, "wholesaleRevenue": 0.0, "retailRevenue": 0.0},
            )
            current["totalOrders"] += 1.0
            current["totalRevenue"] += total
            if pricing_mode == "retail":
                current["retailRevenue"] += total
            else:
                current["wholesaleRevenue"] += total
            rep_totals[rep_id] = current

        rep_lookup: Dict[str, Dict] = {}
        # Seed with canonical user rep records.
        for rep in reps:
            rep_id = rep.get("id")
            if rep_id:
                rep_lookup[str(rep_id)] = rep
        # Fill in any remaining reps from sales_reps (canonicalized).
        for rep_id, rep_record in rep_records.items():
            canonical = alias_to_rep_id.get(rep_id, rep_id)
            rep_lookup.setdefault(canonical, rep_record)

        summary: List[Dict] = []
        for rep_id in sorted(valid_rep_ids):
            totals = rep_totals.get(
                rep_id,
                {"totalOrders": 0.0, "totalRevenue": 0.0, "wholesaleRevenue": 0.0, "retailRevenue": 0.0},
            )
            rep = rep_lookup.get(rep_id) or user_lookup.get(rep_id) or {}
            rep_record = rep_records.get(rep_id) or {}
            # Prefer the user's name if available (sales reps edit their own name there).
            user_rec = user_lookup.get(rep_id) or {}
            preferred_name = (user_rec.get("name") or "").strip() if isinstance(user_rec, dict) else ""
            summary.append(
                {
                    "salesRepId": rep_id,
                    "salesRepName": preferred_name
                    or rep.get("name")
                    or rep_record.get("name")
                    or rep.get("email")
                    or rep_record.get("email")
                    or rep_id
                    or "Sales Rep",
                    "salesRepEmail": rep.get("email") or rep_record.get("email"),
                    "salesRepPhone": rep.get("phone") or rep_record.get("phone"),
                    "totalOrders": int(totals["totalOrders"]),
                    "totalRevenue": float(totals["totalRevenue"]),
                    "wholesaleRevenue": float(totals.get("wholesaleRevenue") or 0.0),
                    "retailRevenue": float(totals.get("retailRevenue") or 0.0),
                }
            )

        if house_totals["totalOrders"] > 0:
            summary.append(
                {
                    "salesRepId": "__house__",
                    "salesRepName": "House / Contact Form",
                    "salesRepEmail": None,
                    "salesRepPhone": None,
                    "totalOrders": int(house_totals["totalOrders"]),
                    "totalRevenue": float(house_totals["totalRevenue"]),
                    "wholesaleRevenue": float(house_totals.get("wholesaleRevenue") or 0.0),
                    "retailRevenue": float(house_totals.get("retailRevenue") or 0.0),
                }
            )

        summary.sort(key=lambda r: float(r.get("totalRevenue") or 0), reverse=True)
        totals_all = {
            "totalOrders": int(sum(int(r.get("totalOrders") or 0) for r in summary)),
            "totalRevenue": float(sum(float(r.get("totalRevenue") or 0) for r in summary)),
            "wholesaleRevenue": float(sum(float(r.get("wholesaleRevenue") or 0) for r in summary)),
            "retailRevenue": float(sum(float(r.get("retailRevenue") or 0) for r in summary)),
        }
        logger.info(
            "[SalesByRep] Summary computed",
            extra={
                "rows": len(summary),
                "ordersSeen": orders_seen,
                "maxPages": max_pages,
                "perPage": per_page,
                "countedRep": counted_rep,
                "countedHouse": counted_house,
                "skippedUnattributed": skipped_unattributed,
                "skippedStatus": skipped_status,
                "skippedRefunded": skipped_refunded,
                "skippedOutsidePeriod": skipped_outside_period,
                "periodStart": period_meta["periodStart"],
                "periodEnd": period_meta["periodEnd"],
                "debugSamples": debug_samples,
            },
        )
        try:
            print(
                f"[sales_by_rep] rows={len(summary)} orders_seen={orders_seen} counted_rep={counted_rep} counted_house={counted_house} reps={len(valid_rep_ids)} samples={debug_samples}",
                flush=True,
            )
        except Exception:
            pass
        return {"orders": summary, "totals": totals_all, **period_meta}

    now_ms = int(time.time() * 1000)
    cached = None
    inflight_event = None
    with _sales_by_rep_summary_lock:
        cached = _sales_by_rep_summary_cache.get("data")
        expires_at = int(_sales_by_rep_summary_cache.get("expiresAtMs") or 0)
        cache_key = _sales_by_rep_summary_cache.get("key")
        if isinstance(cached, dict) and expires_at > now_ms and cache_key == period_cache_key:
            if exclude_sales_rep_id:
                exclude_id = str(exclude_sales_rep_id)
                rows = cached.get("orders") if isinstance(cached.get("orders"), list) else []
                filtered = [row for row in rows if str((row or {}).get("salesRepId")) != exclude_id]
                return {**cached, "orders": filtered}
            return cached
        inflight_event = _sales_by_rep_summary_inflight
        if inflight_event is None:
            inflight_event = threading.Event()
            _sales_by_rep_summary_inflight = inflight_event
            is_leader = True
        else:
            is_leader = False

    if not is_leader and inflight_event is not None:
        inflight_event.wait(timeout=35)
        with _sales_by_rep_summary_lock:
            cached = _sales_by_rep_summary_cache.get("data")
            cache_key = _sales_by_rep_summary_cache.get("key")
            if isinstance(cached, dict) and cache_key == period_cache_key:
                if exclude_sales_rep_id:
                    exclude_id = str(exclude_sales_rep_id)
                    rows = cached.get("orders") if isinstance(cached.get("orders"), list) else []
                    filtered = [row for row in rows if str((row or {}).get("salesRepId")) != exclude_id]
                    return {**cached, "orders": filtered, "stale": True}
                return {**cached, "stale": True}
        # If the leader could not populate cache in time, do not stampede the upstream.
        return {
            "orders": [],
            "totals": {"totalOrders": 0, "totalRevenue": 0.0, "wholesaleRevenue": 0.0, "retailRevenue": 0.0},
            **period_meta,
            "stale": True,
            "error": "Sales summary is temporarily unavailable.",
        }

    try:
        summary = _compute_summary()
        now_ms = int(time.time() * 1000)
        with _sales_by_rep_summary_lock:
            _sales_by_rep_summary_cache["data"] = summary
            _sales_by_rep_summary_cache["key"] = period_cache_key
            _sales_by_rep_summary_cache["fetchedAtMs"] = now_ms
            _sales_by_rep_summary_cache["expiresAtMs"] = now_ms + (_SALES_BY_REP_SUMMARY_TTL_SECONDS * 1000)
        # Best-effort persistence for admins (optional columns).
        for row in summary.get("orders") if isinstance(summary, dict) else []:
            rep_id = row.get("salesRepId")
            if not rep_id or rep_id == "__house__":
                continue
            try:
                target_id = str(rep_id)
                record = sales_rep_repository.find_by_id(target_id)
                if not record:
                    email = row.get("salesRepEmail")
                    if isinstance(email, str) and email.strip():
                        record = sales_rep_repository.find_by_email(email)
                        if record and record.get("id"):
                            target_id = str(record.get("id"))
                sales_rep_repository.update_revenue_summary(
                    target_id,
                    float(row.get("totalRevenue") or 0),
                )
            except Exception:
                continue
        if exclude_sales_rep_id:
            exclude_id = str(exclude_sales_rep_id)
            rows = summary.get("orders") if isinstance(summary, dict) else []
            filtered = [row for row in rows if str((row or {}).get("salesRepId")) != exclude_id]
            return {**summary, "orders": filtered}
        return summary
    except Exception as exc:
        # Serve stale cached data if available.
        with _sales_by_rep_summary_lock:
            cached = _sales_by_rep_summary_cache.get("data")
            if isinstance(cached, dict):
                logger.warning(
                    "[SalesByRep] Using cached summary after failure",
                    exc_info=True,
                    extra={"error": str(exc)},
                )
                if exclude_sales_rep_id:
                    exclude_id = str(exclude_sales_rep_id)
                    rows = cached.get("orders") if isinstance(cached.get("orders"), list) else []
                    filtered = [row for row in rows if str((row or {}).get("salesRepId")) != exclude_id]
                    return {**cached, "orders": filtered, "stale": True, "error": "Sales summary is temporarily unavailable."}
                return {**cached, "stale": True, "error": "Sales summary is temporarily unavailable."}
        # No cached data yet; return an empty/stale response instead of a 500.
        return {
            "orders": [],
            "totals": {"totalOrders": 0, "totalRevenue": 0.0},
            **period_meta,
            "stale": True,
            "error": "Sales summary is temporarily unavailable.",
        }
    finally:
        with _sales_by_rep_summary_lock:
            if _sales_by_rep_summary_inflight is not None:
                try:
                    _sales_by_rep_summary_inflight.set()
                except Exception:
                    pass
            _sales_by_rep_summary_inflight = None


def get_taxes_by_state_for_admin(*, period_start: Optional[str] = None, period_end: Optional[str] = None) -> Dict:
    """
    Aggregate taxes by destination state for the given period.

    Period parsing/bounds intentionally mirror `get_sales_by_rep()` so the admin dashboard can reuse
    the same start/end date inputs.
    """
    global _admin_taxes_by_state_inflight

    start_dt, end_dt, period_meta = _resolve_report_period_bounds(period_start, period_end)

    def _meta_value(meta: object, key: str):
        if not isinstance(meta, list):
            return None
        for entry in meta:
            if isinstance(entry, dict) and entry.get("key") == key:
                return entry.get("value")
        return None

    def _is_truthy(value: object) -> bool:
        if value is True:
            return True
        if value is False or value is None:
            return False
        if isinstance(value, (int, float)):
            try:
                return float(value) != 0
            except Exception:
                return False
        text = str(value).strip().lower()
        return text in ("1", "true", "yes", "y", "on")

    def _safe_float(value: object) -> float:
        try:
            if value is None:
                return 0.0
            return float(value)
        except Exception:
            try:
                return float(str(value).strip() or 0)
            except Exception:
                return 0.0

    period_cache_key = f"{period_meta['periodStart']}::{period_meta['periodEnd']}"

    now_ms = int(time.time() * 1000)
    with _admin_taxes_by_state_lock:
        cached = _admin_taxes_by_state_cache.get("data")
        expires_at = int(_admin_taxes_by_state_cache.get("expiresAtMs") or 0)
        cache_key = _admin_taxes_by_state_cache.get("key")
        if isinstance(cached, dict) and expires_at > now_ms and cache_key == period_cache_key:
            return cached
        inflight = _admin_taxes_by_state_inflight
        if inflight is None:
            inflight = threading.Event()
            _admin_taxes_by_state_inflight = inflight
            is_leader = True
        else:
            is_leader = False

    if not is_leader and inflight is not None:
        inflight.wait(timeout=35)
        with _admin_taxes_by_state_lock:
            cached = _admin_taxes_by_state_cache.get("data")
            cache_key = _admin_taxes_by_state_cache.get("key")
            if isinstance(cached, dict) and cache_key == period_cache_key:
                return {**cached, "stale": True}
        return {"rows": [], "totals": {"orderCount": 0, "taxTotal": 0.0}, **period_meta, "stale": True}

    try:
        per_page = 100
        max_pages = 25
        bucket: Dict[str, Dict[str, float]] = {}
        order_lines: List[Dict[str, object]] = []
        order_count = 0
        tax_total_all = 0.0

        for page in range(1, max_pages + 1):
            payload, _meta = woo_commerce.fetch_catalog_proxy(
                "orders",
                {"per_page": per_page, "page": page, "orderby": "date", "order": "desc", "status": "any"},
            )
            orders = payload if isinstance(payload, list) else []
            if not orders:
                break

            reached_start = False
            for woo_order in orders:
                if not isinstance(woo_order, dict):
                    continue
                status = str(woo_order.get("status") or "").strip().lower()
                if status not in ("processing", "completed"):
                    continue
                meta_data = woo_order.get("meta_data") or []
                if _is_truthy(_meta_value(meta_data, "peppro_refunded")) or status == "refunded":
                    continue

                created_raw = (
                    woo_order.get("date_created_gmt")
                    or woo_order.get("date_created")
                    or woo_order.get("date")
                    or None
                )
                created_at = _parse_datetime_utc(created_raw)
                if not created_at:
                    continue
                if created_at > end_dt:
                    continue
                if created_at < start_dt:
                    reached_start = True
                    continue

                shipping = woo_order.get("shipping") or {}
                billing = woo_order.get("billing") or {}
                state = (
                    str((shipping or {}).get("state") or "").strip().upper()
                    or str((billing or {}).get("state") or "").strip().upper()
                    or "UNKNOWN"
                )

                tax_source = None
                meta_tax_raw = _meta_value(meta_data, "peppro_tax_total")
                tax_total = _safe_float(meta_tax_raw)
                if tax_total > 0:
                    tax_source = "meta:peppro_tax_total"
                else:
                    order_tax = _safe_float(woo_order.get("total_tax"))
                    if order_tax > 0:
                        tax_total = order_tax
                        tax_source = "order:total_tax"
                if tax_total <= 0:
                    for fee in woo_order.get("fee_lines") or []:
                        try:
                            name = str((fee or {}).get("name") or "").strip().lower()
                        except Exception:
                            name = ""
                        if name and "tax" in name:
                            tax_total = _safe_float((fee or {}).get("total"))
                            tax_source = "fee_lines"
                            break

                order_count += 1
                tax_total_all += tax_total
                current = bucket.get(state) or {"taxTotal": 0.0, "orderCount": 0.0}
                current["taxTotal"] = float(current.get("taxTotal") or 0.0) + float(tax_total or 0.0)
                current["orderCount"] = float(current.get("orderCount") or 0.0) + 1.0
                bucket[state] = current
                order_lines.append(
                    {
                        "orderNumber": woo_order.get("number") or woo_order.get("id"),
                        "wooId": woo_order.get("id"),
                        "state": state,
                        "status": status,
                        "createdAt": created_at.isoformat(),
                        "taxTotal": round(float(tax_total or 0.0), 2),
                        "taxSource": tax_source or "unknown",
                    }
                )

            if len(orders) < per_page or reached_start:
                break

        rows = [
            {
                "state": state,
                "taxTotal": round(float(values.get("taxTotal") or 0.0), 2),
                "orderCount": int(values.get("orderCount") or 0),
            }
            for state, values in bucket.items()
        ]
        rows.sort(key=lambda r: float(r.get("taxTotal") or 0.0), reverse=True)
        # Show math lines for verification: orderNumber -> taxTotal.
        order_lines.sort(key=lambda o: str(o.get("orderNumber") or ""))
        result = {
            "rows": rows,
            "totals": {"orderCount": order_count, "taxTotal": round(tax_total_all, 2)},
            "orderTaxes": order_lines,
            **period_meta,
        }

        now_ms = int(time.time() * 1000)
        with _admin_taxes_by_state_lock:
            _admin_taxes_by_state_cache["data"] = result
            _admin_taxes_by_state_cache["key"] = period_cache_key
            _admin_taxes_by_state_cache["expiresAtMs"] = now_ms + (_ADMIN_TAXES_BY_STATE_TTL_SECONDS * 1000)
        return result
    finally:
        with _admin_taxes_by_state_lock:
            if _admin_taxes_by_state_inflight is not None:
                try:
                    _admin_taxes_by_state_inflight.set()
                except Exception:
                    pass
            _admin_taxes_by_state_inflight = None


def get_products_and_commission_for_admin(*, period_start: Optional[str] = None, period_end: Optional[str] = None) -> Dict:
    """
    For the given period:
      - Count quantity sold per product/sku
      - Compute commissions:
          wholesale: 10% of (order_total - tax - shipping)
          retail: 20% of (order_total - tax - shipping)
        House/contact-form orders split commission equally across admins.
      - Include supplier "share" as (base - commission).
    """
    global _admin_products_commission_inflight

    start_dt, end_dt, period_meta = _resolve_report_period_bounds(period_start, period_end)

    def _meta_value(meta: object, key: str):
        if not isinstance(meta, list):
            return None
        for entry in meta:
            if isinstance(entry, dict) and entry.get("key") == key:
                return entry.get("value")
        return None

    def _is_truthy(value: object) -> bool:
        if value is True:
            return True
        if value is False or value is None:
            return False
        if isinstance(value, (int, float)):
            try:
                return float(value) != 0
            except Exception:
                return False
        text = str(value).strip().lower()
        return text in ("1", "true", "yes", "y", "on")

    def _safe_float(value: object) -> float:
        try:
            if value is None:
                return 0.0
            return float(value)
        except Exception:
            try:
                return float(str(value).strip() or 0)
            except Exception:
                return 0.0

    period_cache_key = f"{period_meta['periodStart']}::{period_meta['periodEnd']}"

    now_ms = int(time.time() * 1000)
    with _admin_products_commission_lock:
        cached = _admin_products_commission_cache.get("data")
        expires_at = int(_admin_products_commission_cache.get("expiresAtMs") or 0)
        cache_key = _admin_products_commission_cache.get("key")
        if isinstance(cached, dict) and expires_at > now_ms and cache_key == period_cache_key:
            return cached
        inflight = _admin_products_commission_inflight
        if inflight is None:
            inflight = threading.Event()
            _admin_products_commission_inflight = inflight
            is_leader = True
        else:
            is_leader = False

    if not is_leader and inflight is not None:
        inflight.wait(timeout=35)
        with _admin_products_commission_lock:
            cached = _admin_products_commission_cache.get("data")
            cache_key = _admin_products_commission_cache.get("key")
            if isinstance(cached, dict) and cache_key == period_cache_key:
                return {**cached, "stale": True}
        return {"products": [], "commissions": [], "totals": {}, **period_meta, "stale": True}

    try:
        users = user_repository.get_all()
        admins = [u for u in users if (u.get("role") or "").lower() == "admin"]
        reps = [u for u in users if (u.get("role") or "").lower() == "sales_rep"]
        rep_records_list = sales_rep_repository.get_all()
        report_tz = _get_report_timezone()

        def _norm_email(value: object) -> str:
            return str(value or "").strip().lower()

        user_rep_id_by_email: Dict[str, str] = {}
        for rep in reps:
            rep_id = rep.get("id")
            email = _norm_email(rep.get("email"))
            if rep_id and email:
                user_rep_id_by_email[email] = str(rep_id)

        admin_emails = {_norm_email(a.get("email")) for a in admins if _norm_email(a.get("email"))}

        alias_to_rep_id: Dict[str, str] = {}
        for rep in reps:
            rep_id = rep.get("id")
            if rep_id:
                rep_id_str = str(rep_id)
                alias_to_rep_id[rep_id_str] = rep_id_str

        for rep in rep_records_list:
            rep_id = rep.get("id")
            if not rep_id:
                continue
            rep_id_str = str(rep_id)
            rep_email = _norm_email(rep.get("email"))
            canonical = user_rep_id_by_email.get(rep_email) or rep_id_str
            alias_to_rep_id[rep_id_str] = canonical
            legacy_id = rep.get("legacyUserId") or rep.get("legacy_user_id")
            if legacy_id:
                alias_to_rep_id[str(legacy_id)] = canonical

        doctors_by_email = {}
        for u in users:
            if (u.get("role") or "").lower() not in ("doctor", "test_doctor"):
                continue
            email = (u.get("email") or "").strip().lower()
            if email:
                doctors_by_email[email] = u

        # Any order placed by an email present in the MySQL `contact_forms` table should be
        # treated as a house/contact-form order and split across admins.
        contact_form_emails: set[str] = set()
        try:
            from . import get_config  # type: ignore
            from ..database import mysql_client  # type: ignore

            if bool(get_config().mysql.get("enabled")):
                rows = mysql_client.fetch_all("SELECT DISTINCT email FROM contact_forms", {})
                for row in rows or []:
                    if not isinstance(row, dict):
                        continue
                    form_email = _norm_email(row.get("email"))
                    if form_email:
                        contact_form_emails.add(form_email)
        except Exception:
            contact_form_emails = set()

        recipient_rows: Dict[str, Dict[str, object]] = {}
        for rep in reps:
            rep_id = rep.get("id")
            if not rep_id:
                continue
            recipient_rows[str(rep_id)] = {
                "id": str(rep_id),
                "name": rep.get("name") or "Sales Rep",
                "role": "sales_rep",
                "amount": 0.0,
            }
        for rep in rep_records_list:
            rep_id = rep.get("id")
            if not rep_id:
                continue
            rep_email = _norm_email(rep.get("email"))
            # If a rep record shares an admin email, do not list it as a sales rep line item.
            # (Admins will still appear under their admin identity.)
            if rep_email and rep_email in admin_emails:
                continue
            canonical = alias_to_rep_id.get(str(rep_id), str(rep_id))
            if canonical in recipient_rows:
                continue
            recipient_rows[canonical] = {"id": canonical, "name": rep.get("name") or "Sales Rep", "role": "sales_rep", "amount": 0.0}
        for admin in admins:
            admin_id = admin.get("id")
            if not admin_id:
                continue
            recipient_rows[str(admin_id)] = {"id": str(admin_id), "name": admin.get("name") or "Admin", "role": "admin", "amount": 0.0}

        supplier_name = str(os.environ.get("COMMISSION_SUPPLIER_NAME") or "Supplier").strip() or "Supplier"
        supplier_row_id = "__supplier__"
        recipient_rows[supplier_row_id] = {"id": supplier_row_id, "name": supplier_name, "role": "supplier", "amount": 0.0}

        admin_ids = [str(a.get("id")) for a in admins if a.get("id")]
        special_admin_email = "petergibbons7@icloud.com"
        special_admin_rate = 0.03
        special_admin_monthly_cap = 6000.0
        special_admin_user = next((a for a in admins if _norm_email(a.get("email")) == special_admin_email), None)
        special_admin_id = str(special_admin_user.get("id")) if isinstance(special_admin_user, dict) and special_admin_user.get("id") else None

        per_page = 100
        max_pages = 25
        orders_seen = 0
        product_totals: Dict[str, Dict[str, object]] = {}
        attributed_orders: List[Dict[str, object]] = []
        skipped_status = 0
        skipped_refunded = 0
        skipped_outside_period = 0

        for page in range(1, max_pages + 1):
            payload, _meta = woo_commerce.fetch_catalog_proxy(
                "orders",
                {"per_page": per_page, "page": page, "orderby": "date", "order": "desc", "status": "any"},
            )
            orders = payload if isinstance(payload, list) else []
            if not orders:
                break

            reached_start = False
            for woo_order in orders:
                if not isinstance(woo_order, dict):
                    continue
                status = str(woo_order.get("status") or "").strip().lower()
                if status not in ("processing", "completed"):
                    skipped_status += 1
                    continue
                meta_data = woo_order.get("meta_data") or []
                if _is_truthy(_meta_value(meta_data, "peppro_refunded")) or status == "refunded":
                    skipped_refunded += 1
                    continue

                created_raw = (
                    woo_order.get("date_created_gmt")
                    or woo_order.get("date_created")
                    or woo_order.get("date")
                    or None
                )
                created_at = _parse_datetime_utc(created_raw)
                if not created_at:
                    skipped_outside_period += 1
                    continue
                if created_at > end_dt:
                    skipped_outside_period += 1
                    continue
                if created_at < start_dt:
                    reached_start = True
                    skipped_outside_period += 1
                    continue

                billing_email = str((woo_order.get("billing") or {}).get("email") or "").strip().lower()
                force_house_contact_form = bool(billing_email and billing_email in contact_form_emails)

                rep_id = _meta_value(meta_data, "peppro_sales_rep_id")
                rep_id = str(rep_id).strip() if rep_id is not None else ""
                if rep_id:
                    rep_id = alias_to_rep_id.get(rep_id, rep_id)

                if force_house_contact_form:
                    rep_id = ""

                if not rep_id:
                    rep_id = user_rep_id_by_email.get(billing_email, "")

                if not rep_id:
                    doctor = doctors_by_email.get(billing_email)
                    rep_id = str(doctor.get("salesRepId") or "").strip() if doctor else ""
                    if rep_id:
                        rep_id = alias_to_rep_id.get(rep_id, rep_id)

                recipient_id = rep_id
                # "house" is a sentinel salesRepId for contact-form sourced doctors and should be
                # handled as a house sale (split across admins), not a real rep id.
                if str(recipient_id or "").strip().lower() == "house":
                    recipient_id = ""
                if recipient_id and recipient_id not in recipient_rows:
                    # If an admin id shows up as attribution, include it.
                    admin = next((a for a in admins if str(a.get("id")) == str(recipient_id)), None)
                    if admin:
                        recipient_rows[str(recipient_id)] = {"id": str(recipient_id), "name": admin.get("name") or "Admin", "role": "admin", "amount": 0.0}
                    else:
                        recipient_rows[str(recipient_id)] = {"id": str(recipient_id), "name": f"User {recipient_id}", "role": "unknown", "amount": 0.0}

                if not recipient_id:
                    # House orders for contact-form sourced doctors (including any email present in
                    # the MySQL contact_forms table).
                    is_house_contact_form = force_house_contact_form
                    if billing_email:
                        doctor = doctors_by_email.get(billing_email)
                        if doctor and str(doctor.get("salesRepId") or "").strip() == "house":
                            is_house_contact_form = True
                        else:
                            try:
                                prospect = sales_prospect_repository.find_by_contact_email(billing_email)
                                if prospect:
                                    prospect_rep = str(prospect.get("salesRepId") or "").strip().lower()
                                    prospect_contact_form_id = str(prospect.get("contactFormId") or "").strip()
                                    prospect_identifier = str(prospect.get("id") or "")
                                    if prospect_rep == "house" or prospect_contact_form_id or prospect_identifier.startswith("contact_form:"):
                                        is_house_contact_form = True
                                if not is_house_contact_form and doctor and doctor.get("id"):
                                    doctor_prospect = sales_prospect_repository.find_contact_form_by_doctor_id(str(doctor.get("id")))
                                    if doctor_prospect:
                                        is_house_contact_form = True
                            except Exception:
                                is_house_contact_form = False
                    if is_house_contact_form:
                        recipient_id = "__house__"

                # Product quantities
                for item in woo_order.get("line_items") or []:
                    if not isinstance(item, dict):
                        continue
                    qty = int(_safe_float(item.get("quantity")))
                    if qty <= 0:
                        continue
                    sku = str(item.get("sku") or "").strip()
                    product_id = item.get("product_id")
                    variation_id = item.get("variation_id")
                    key = sku or f"id:{product_id}:{variation_id}"
                    entry = product_totals.get(key) or {
                        "key": key,
                        "sku": sku or None,
                        "productId": product_id,
                        "variationId": variation_id,
                        "name": item.get("name") or sku or str(product_id or ""),
                        "quantity": 0,
                    }
                    entry["quantity"] = int(entry.get("quantity") or 0) + qty
                    product_totals[key] = entry

                # Commission base + pricing mode hint
                total = _safe_float(woo_order.get("total"))
                shipping_total = _safe_float(woo_order.get("shipping_total"))
                tax_total = _safe_float(_meta_value(meta_data, "peppro_tax_total")) or _safe_float(woo_order.get("total_tax"))
                created_at = _parse_datetime_utc(
                    woo_order.get("date_created_gmt")
                    or woo_order.get("date_created")
                    or woo_order.get("date")
                    or None
                )
                pricing_mode_hint = (
                    _meta_value(meta_data, "peppro_pricing_mode")
                    or _meta_value(meta_data, "peppro_pricingMode")
                    or _meta_value(meta_data, "pricing_mode")
                    or _meta_value(meta_data, "pricingMode")
                )
                attributed_orders.append(
                    {
                        "recipientId": recipient_id or "",
                        "total": total,
                        "shippingTotal": shipping_total,
                        "taxTotal": tax_total,
                        "wooId": woo_order.get("id"),
                        "wooNumber": woo_order.get("number"),
                        "pricingModeHint": pricing_mode_hint,
                        "createdAt": created_at.isoformat() if created_at else None,
                    }
                )
                orders_seen += 1

            if len(orders) < per_page or reached_start:
                break

        def _normalize_token(value: object) -> str:
            if value is None:
                return ""
            text = str(value).strip()
            if not text:
                return ""
            return text[1:] if text.startswith("#") else text

        woo_ids = []
        woo_numbers = []
        for entry in attributed_orders:
            woo_id = _normalize_token(entry.get("wooId"))
            if woo_id:
                woo_ids.append(woo_id)
            woo_num = _normalize_token(entry.get("wooNumber"))
            if woo_num:
                woo_numbers.append(woo_num)

        pricing_mode_lookup = order_repository.get_pricing_mode_lookup_by_woo(woo_ids, woo_numbers)

        def _resolve_pricing_mode(entry: Dict[str, object]) -> str:
            hint = str(entry.get("pricingModeHint") or "").strip().lower()
            if hint in ("retail", "wholesale"):
                return hint
            woo_id = _normalize_token(entry.get("wooId"))
            if woo_id and woo_id in pricing_mode_lookup:
                return pricing_mode_lookup[woo_id]
            woo_number = _normalize_token(entry.get("wooNumber"))
            if woo_number and woo_number in pricing_mode_lookup:
                return pricing_mode_lookup[woo_number]
            return "wholesale"

        def _add_commission(recipient_id: str, amount: float) -> None:
            row = recipient_rows.get(recipient_id)
            if not row:
                recipient_rows[recipient_id] = {"id": recipient_id, "name": recipient_id, "role": "unknown", "amount": 0.0}
                row = recipient_rows[recipient_id]
            row["amount"] = float(row.get("amount") or 0.0) + float(amount or 0.0)

        def _split_amount(amount: float, targets: List[str]) -> Dict[str, float]:
            ids = [str(t) for t in (targets or []) if str(t).strip()]
            if not ids:
                return {}
            cents = int(round(float(amount or 0.0) * 100))
            each = int(cents // len(ids))
            remainder = int(cents - (each * len(ids)))
            allocations: Dict[str, float] = {}
            for idx, target_id in enumerate(ids):
                portion = each + (1 if idx < remainder else 0)
                allocations[target_id] = portion / 100.0
            return allocations

        totals = {
            "ordersCounted": 0,
            "commissionableBase": 0.0,
            "commissionTotal": 0.0,
            "supplierShare": 0.0,
            "wholesaleBase": 0.0,
            "retailBase": 0.0,
        }

        # Per-recipient math breakdown so the admin dashboard can show the calculation.
        per_recipient_stats: Dict[str, Dict[str, object]] = {}
        # For the special admin 3% payout: track base by month (PST/PDT calendar month).
        special_admin_month_base: Dict[str, float] = {}

        def _ensure_stats(recipient_id: str) -> Dict[str, object]:
            row = per_recipient_stats.get(recipient_id)
            if row is None:
                row = {
                    "retailOrders": 0,
                    "wholesaleOrders": 0,
                    "retailBase": 0.0,
                    "wholesaleBase": 0.0,
                }
                per_recipient_stats[recipient_id] = row
            return row

        def _accumulate_stats(recipient_id: str, *, pricing_mode: str, base: float) -> None:
            stats = _ensure_stats(recipient_id)
            if pricing_mode == "retail":
                stats["retailOrders"] = int(stats.get("retailOrders") or 0) + 1
                stats["retailBase"] = round(float(stats.get("retailBase") or 0.0) + float(base or 0.0), 2)
            else:
                stats["wholesaleOrders"] = int(stats.get("wholesaleOrders") or 0) + 1
                stats["wholesaleBase"] = round(float(stats.get("wholesaleBase") or 0.0) + float(base or 0.0), 2)

        order_breakdown: List[Dict[str, object]] = []

        for entry in attributed_orders:
            recipient_id = str(entry.get("recipientId") or "").strip()
            base = max(0.0, float(entry.get("total") or 0.0) - float(entry.get("shippingTotal") or 0.0) - float(entry.get("taxTotal") or 0.0))
            if base <= 0:
                continue
            pricing_mode = _resolve_pricing_mode(entry)
            rate = 0.2 if pricing_mode == "retail" else 0.1
            commission = round(base * rate, 2)
            supplier_share = round(base - commission, 2)
            created_at = _parse_datetime_utc(entry.get("createdAt")) if entry.get("createdAt") else None

            totals["ordersCounted"] += 1
            totals["commissionableBase"] = round(float(totals["commissionableBase"]) + base, 2)
            totals["commissionTotal"] = round(float(totals["commissionTotal"]) + commission, 2)
            totals["supplierShare"] = round(float(totals["supplierShare"]) + supplier_share, 2)
            if pricing_mode == "retail":
                totals["retailBase"] = round(float(totals["retailBase"]) + base, 2)
            else:
                totals["wholesaleBase"] = round(float(totals["wholesaleBase"]) + base, 2)

            if created_at:
                local_dt = created_at.astimezone(report_tz)
                month_key = f"{local_dt.year:04d}-{local_dt.month:02d}"
                special_admin_month_base[month_key] = float(special_admin_month_base.get(month_key) or 0.0) + float(base or 0.0)

            if recipient_id == "__house__":
                allocations = _split_amount(commission, admin_ids)
                if not allocations:
                    # If no admins are configured, keep the commission on the supplier line.
                    _add_commission(supplier_row_id, commission)
                else:
                    for target_id, amount in allocations.items():
                        _add_commission(target_id, amount)
                        # Attribute a proportional slice of the base for math display.
                        if commission > 0:
                            _accumulate_stats(target_id, pricing_mode=pricing_mode, base=(base * (amount / commission)))
            elif recipient_id:
                _add_commission(recipient_id, commission)
                _accumulate_stats(recipient_id, pricing_mode=pricing_mode, base=base)

            _add_commission(supplier_row_id, supplier_share)

            order_breakdown.append(
                {
                    "orderNumber": entry.get("wooNumber") or entry.get("wooId"),
                    "wooId": entry.get("wooId"),
                    "pricingMode": pricing_mode,
                    "recipientId": recipient_id or None,
                    "commissionRate": rate,
                    "commission": commission,
                    "commissionableBase": round(base, 2),
                    "taxTotal": round(float(entry.get("taxTotal") or 0.0), 2),
                    "shippingTotal": round(float(entry.get("shippingTotal") or 0.0), 2),
                    "orderTotal": round(float(entry.get("total") or 0.0), 2),
                }
            )

        # Special admin 3% payout with monthly cap.
        if special_admin_id:
            bonus_total = 0.0
            bonus_by_month: Dict[str, float] = {}
            for month_key, month_base in special_admin_month_base.items():
                raw = round(float(month_base or 0.0) * special_admin_rate, 2)
                capped = min(raw, special_admin_monthly_cap)
                bonus_by_month[month_key] = capped
                bonus_total = round(bonus_total + capped, 2)
            if bonus_total > 0:
                _add_commission(special_admin_id, bonus_total)
                # Track separately for display.
                stats = _ensure_stats(special_admin_id)
                stats["specialAdminBonus"] = bonus_total
                stats["specialAdminBonusRate"] = special_admin_rate
                stats["specialAdminBonusMonthlyCap"] = special_admin_monthly_cap
                stats["specialAdminBonusByMonth"] = bonus_by_month

        products = list(product_totals.values())
        products.sort(key=lambda p: int(p.get("quantity") or 0), reverse=True)

        commissions = list(recipient_rows.values())
        commissions.sort(key=lambda r: float(r.get("amount") or 0.0), reverse=True)

        result = {
            "products": products,
            "commissions": [
                {
                    "id": row.get("id"),
                    "name": row.get("name"),
                    "role": row.get("role"),
                    "amount": round(float(row.get("amount") or 0.0), 2),
                    "retailOrders": int(per_recipient_stats.get(str(row.get("id")), {}).get("retailOrders") or 0),
                    "wholesaleOrders": int(per_recipient_stats.get(str(row.get("id")), {}).get("wholesaleOrders") or 0),
                    "retailBase": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("retailBase") or 0.0), 2),
                    "wholesaleBase": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("wholesaleBase") or 0.0), 2),
                    "specialAdminBonus": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("specialAdminBonus") or 0.0), 2),
                }
                for row in commissions
            ],
            "totals": totals,
            "orderBreakdown": order_breakdown,
            "debug": {
                "ordersSeen": orders_seen,
                "skippedStatus": skipped_status,
                "skippedRefunded": skipped_refunded,
                "skippedOutsidePeriod": skipped_outside_period,
            },
            **period_meta,
        }

        now_ms = int(time.time() * 1000)
        with _admin_products_commission_lock:
            _admin_products_commission_cache["data"] = result
            _admin_products_commission_cache["key"] = period_cache_key
            _admin_products_commission_cache["expiresAtMs"] = now_ms + (_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS * 1000)
        return result
    finally:
        with _admin_products_commission_lock:
            if _admin_products_commission_inflight is not None:
                try:
                    _admin_products_commission_inflight.set()
                except Exception:
                    pass
            _admin_products_commission_inflight = None


def _service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err
