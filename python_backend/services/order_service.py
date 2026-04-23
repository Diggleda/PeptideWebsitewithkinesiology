from __future__ import annotations

import logging
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
import json
import re
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from ..utils.http import service_error as _service_error
from ..utils.crypto_envelope import decrypt_text
from ..repositories import (
    order_repository,
    user_repository,
    sales_rep_repository,
    referral_code_repository,
    sales_prospect_repository,
    discount_code_repository,
)
from ..database import mysql_client
from ..integrations import ship_station, stripe_payments, ups_tracking, woo_commerce
from .. import storage
from . import referral_service
from . import settings_service
from . import discount_code_service
from . import tax_tracking_service
from . import user_media_service

logger = logging.getLogger(__name__)

_PERF_LOG_ENABLED = (os.environ.get("PERF_LOG") or "").strip().lower() in ("1", "true", "yes", "on")
FACILITY_PICKUP_LOCATION = {
    "name": "PepPro Facility Pickup",
    "addressLine1": "640 S Grand Ave",
    "addressLine2": "Unit #107",
    "city": "Santa Ana",
    "state": "CA",
    "postalCode": "92705",
    "country": "US",
}
FACILITY_PICKUP_LABEL = "Facility pickup"
FACILITY_PICKUP_NOTICE = None
FACILITY_PICKUP_SERVICE_CODE = "facility_pickup"
HAND_DELIVERY_LABEL = "Hand Delivered"
HAND_DELIVERY_SERVICE_CODE = "hand_delivery"
_CA_FIXED_TAX_RATE = 0.0875


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

_ADMIN_TAXES_BY_STATE_TTL_SECONDS = int(os.environ.get("ADMIN_TAXES_BY_STATE_TTL_SECONDS", "300").strip() or 300)
_ADMIN_TAXES_BY_STATE_TTL_SECONDS = max(5, min(_ADMIN_TAXES_BY_STATE_TTL_SECONDS, 300))
_admin_taxes_by_state_lock = threading.Lock()
_admin_taxes_by_state_inflight: Optional[threading.Event] = None
_admin_taxes_by_state_cache: Dict[str, object] = {"data": None, "key": None, "expiresAtMs": 0}

_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS = int(os.environ.get("ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS", "25").strip() or 25)
_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS = max(5, min(_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS, 300))
_admin_products_commission_lock = threading.Lock()
_admin_products_commission_inflight: Optional[threading.Event] = None
_admin_products_commission_cache: Dict[str, object] = {"data": None, "key": None, "expiresAtMs": 0}

_SHIP_TIME_AVERAGE_TTL_SECONDS = int(os.environ.get("ORDER_SHIP_TIME_AVERAGE_TTL_SECONDS", "0").strip() or 0)
_SHIP_TIME_AVERAGE_TTL_SECONDS = max(0, min(_SHIP_TIME_AVERAGE_TTL_SECONDS, 3600))
_SHIP_TIME_AVERAGE_SAMPLE_LIMIT = int(os.environ.get("ORDER_SHIP_TIME_AVERAGE_SAMPLE_LIMIT", "250").strip() or 250)
_SHIP_TIME_AVERAGE_SAMPLE_LIMIT = max(25, min(_SHIP_TIME_AVERAGE_SAMPLE_LIMIT, 1000))
_ship_time_average_lock = threading.Lock()
_ship_time_average_cache: Dict[str, object] = {"data": None, "expiresAtMs": 0}


def _normalize_bool(value: Any) -> bool:
    if value is True or value is False:
        return value
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0.0
        except Exception:
            return False
    return str(value or "").strip().lower() in ("1", "true", "yes", "y", "on")


def _normalize_role(value: Any) -> str:
    return str(value or "").strip().lower().replace(" ", "_").replace("-", "_")


def _is_sales_rep_role(value: Any) -> bool:
    return _normalize_role(value) in ("sales_rep", "sales_partner", "rep")


def _is_sales_access_role(value: Any) -> bool:
    return _normalize_role(value) in ("admin", "sales_rep", "sales_partner", "rep", "sales_lead", "saleslead")


def _is_basic_sales_rep_viewer_role(value: Any) -> bool:
    return _normalize_role(value) in ("sales_rep", "sales_partner", "rep", "test_rep")


def _is_sales_lead_role(value: Any) -> bool:
    return _normalize_role(value) in ("sales_lead", "saleslead")


def _resolve_rep_record_role(rep: Dict | None) -> str:
    if not isinstance(rep, dict):
        return "sales_rep"
    if _normalize_bool(rep.get("isPartner") if "isPartner" in rep else rep.get("is_partner")):
        return "sales_partner"
    normalized = _normalize_role(rep.get("role"))
    if normalized == "sales_partner":
        return "sales_partner"
    if normalized in ("sales_rep", "rep"):
        return "sales_rep"
    return normalized or "sales_rep"


def _resolve_sales_rep_record_for_user(
    user: Dict | None,
    rep_records: Dict[str, Dict] | None = None,
) -> Dict | None:
    if not isinstance(user, dict):
        return None

    records = rep_records
    if records is None:
        records = {
            str(rep.get("id")): rep
            for rep in sales_rep_repository.get_all()
            if isinstance(rep, dict) and rep.get("id") is not None
        }

    for candidate in (
        user.get("salesRepId"),
        user.get("sales_rep_id"),
        user.get("ownerSalesRepId"),
        user.get("owner_sales_rep_id"),
        user.get("id"),
    ):
        normalized = str(candidate or "").strip()
        if normalized and normalized in records:
            return records[normalized]

    user_id = str(user.get("id") or "").strip()
    if user_id:
        for rep in records.values():
            legacy_user_id = str(rep.get("legacyUserId") or rep.get("legacy_user_id") or "").strip()
            if legacy_user_id and legacy_user_id == user_id:
                return rep

    email = str(user.get("email") or "").strip().lower()
    if email:
        for rep in records.values():
            rep_email = str(rep.get("email") or "").strip().lower()
            if rep_email and rep_email == email:
                return rep

    return None


def _normalize_contact_form_email(value: Any) -> str:
    return str(value or "").strip().lower()


def _read_contact_form_email(row: Dict[str, Any], *, table: str) -> Optional[str]:
    if table == "contact_forms":
        decrypted = decrypt_text(
            row.get("email"),
            aad={"table": "contact_forms", "field": "email"},
        )
        if isinstance(decrypted, str) and decrypted.strip():
            text = decrypted.strip()
            if text != "[ENCRYPTED]":
                return text
        decrypted = decrypt_text(
            row.get("email_encrypted"),
            aad={"table": "contact_forms", "field": "email"},
        )
        if isinstance(decrypted, str) and decrypted.strip():
            return decrypted.strip()
    value = row.get("email")
    if value is None:
        return None
    text = str(value).strip()
    if not text or text == "[ENCRYPTED]":
        return None
    return text


def _load_contact_form_emails_from_mysql() -> set[str]:
    contact_form_emails: set[str] = set()
    try:
        from . import get_config  # type: ignore
        from ..database import mysql_client  # type: ignore

        if not bool(get_config().mysql.get("enabled")):
            return contact_form_emails

        for table in ("contact_form", "contact_forms"):
            try:
                query = (
                    "SELECT DISTINCT email FROM contact_forms"
                    if table == "contact_forms"
                    else f"SELECT DISTINCT email FROM {table}"
                )
                rows = mysql_client.fetch_all(query, {})
            except Exception:
                rows = []
            for row in rows or []:
                if not isinstance(row, dict):
                    continue
                form_email = _normalize_contact_form_email(
                    _read_contact_form_email(row, table=table)
                )
                if form_email:
                    contact_form_emails.add(form_email)
    except Exception:
        return set()
    return contact_form_emails


def invalidate_admin_taxes_by_state_cache() -> None:
    with _admin_taxes_by_state_lock:
        _admin_taxes_by_state_cache["data"] = None
        _admin_taxes_by_state_cache["key"] = None
        _admin_taxes_by_state_cache["expiresAtMs"] = 0


def invalidate_ship_time_average_cache() -> None:
    with _ship_time_average_lock:
        _ship_time_average_cache["data"] = None
        _ship_time_average_cache["expiresAtMs"] = 0


def _get_report_timezone() -> timezone:
    name = (os.environ.get("REPORT_TIMEZONE") or "America/Los_Angeles").strip() or "America/Los_Angeles"
    try:
        return ZoneInfo(name)
    except Exception:
        # Fallback: keep historical behavior (UTC) if tz database isn't available.
        return timezone.utc


def _get_order_timezone() -> timezone:
    name = (os.environ.get("ORDER_TIMEZONE") or "America/Los_Angeles").strip() or "America/Los_Angeles"
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def _now_order_iso() -> str:
    """
    Generate an ISO timestamp anchored to the configured order timezone (default Pacific).
    """
    tz = _get_order_timezone()
    return datetime.now(tz).isoformat()


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


def _business_days_between(start_at: datetime, end_at: datetime) -> float:
    start_date = start_at.date()
    end_date = end_at.date()
    if end_date < start_date:
        return 0.0

    current_date = start_date
    total_days = 0.0
    while current_date <= end_date:
        if current_date.weekday() < 5:
            total_days += 1.0
        current_date += timedelta(days=1)
    return total_days


def _trimmed_average(values: List[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(float(value) for value in values if value is not None)
    if not ordered:
        return 0.0
    if len(ordered) < 10:
        return sum(ordered) / len(ordered)
    trim = min(max(int(len(ordered) * 0.1), 1), max((len(ordered) - 1) // 2, 0))
    trimmed = ordered[trim : len(ordered) - trim] if trim else ordered
    if not trimmed:
        trimmed = ordered
    return sum(trimmed) / len(trimmed)


def _fetch_ship_time_average_rows(limit: int) -> List[Dict[str, object]]:
    try:
        return mysql_client.fetch_all(
            """
            SELECT created_at, shipped_at, tracking_number
            FROM orders
            WHERE NULLIF(TRIM(COALESCE(tracking_number, '')), '') IS NOT NULL
              AND created_at IS NOT NULL
              AND shipped_at IS NOT NULL
              AND DATE(shipped_at) >= DATE(created_at)
              AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled', 'refunded', 'failed')
            ORDER BY shipped_at DESC
            LIMIT %(limit)s
            """,
            {"limit": int(limit)},
        )
    except Exception:
        orders = order_repository.get_all()
        fallback_rows: List[Dict[str, object]] = []
        for order in orders:
            if not isinstance(order, dict):
                continue
            status = str(order.get("status") or "").strip().lower()
            if status in {"cancelled", "canceled", "refunded", "failed"}:
                continue
            tracking_number = str(order.get("trackingNumber") or order.get("tracking_number") or "").strip()
            if not tracking_number:
                continue
            created_at = order.get("createdAt") or order.get("created_at")
            shipped_at = order.get("shippedAt") or order.get("shipped_at")
            if created_at and shipped_at:
                fallback_rows.append(
                    {"created_at": created_at, "shipped_at": shipped_at, "tracking_number": tracking_number}
                )
        return fallback_rows[:limit]


def _get_historical_ship_time_average() -> Dict[str, object]:
    now_ms = int(time.time() * 1000)
    if _SHIP_TIME_AVERAGE_TTL_SECONDS > 0:
        with _ship_time_average_lock:
            cached = _ship_time_average_cache.get("data")
            expires_at = int(_ship_time_average_cache.get("expiresAtMs") or 0)
            if isinstance(cached, dict) and expires_at > now_ms:
                return dict(cached)

    durations: List[float] = []
    rows = _fetch_ship_time_average_rows(_SHIP_TIME_AVERAGE_SAMPLE_LIMIT)
    for row in rows:
        created_at = _parse_datetime_utc((row or {}).get("created_at"))
        shipped_at = _parse_datetime_utc((row or {}).get("shipped_at"))
        if not created_at or not shipped_at or shipped_at.date() < created_at.date():
            continue
        durations.append(_business_days_between(created_at, shipped_at))

    sample_size = len(durations)
    average_business_days = _trimmed_average(durations) if sample_size > 0 else 0.0
    rounded_business_days = max(1, int(round(average_business_days))) if average_business_days > 0 else 1
    result = {
        "averageBusinessDays": round(average_business_days, 2) if average_business_days > 0 else None,
        "roundedBusinessDays": rounded_business_days,
        "sampleSize": sample_size,
        "usedHistoricalAverage": bool(average_business_days > 0),
    }

    if _SHIP_TIME_AVERAGE_TTL_SECONDS > 0:
        with _ship_time_average_lock:
            _ship_time_average_cache["data"] = dict(result)
            _ship_time_average_cache["expiresAtMs"] = now_ms + (_SHIP_TIME_AVERAGE_TTL_SECONDS * 1000)
    return result


def _list_house_lead_users_for_sales_tracking() -> List[Dict]:
    try:
        rows = mysql_client.fetch_all(
            """
            SELECT
                id,
                name,
                email,
                role,
                sales_rep_id,
                lead_type,
                lead_type_source,
                lead_type_locked_at,
                phone,
                office_address_line1,
                office_address_line2,
                office_city,
                office_state,
                office_postal_code,
                office_country,
                profile_image_url
            FROM users
            WHERE LOWER(TRIM(COALESCE(lead_type, ''))) = 'house'
            """,
            {},
        )
    except Exception:
        logger.warning("[SalesRep] Failed to load house users from MySQL", exc_info=True)
        return []

    house_users: List[Dict] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        user_id = str(row.get("id") or "").strip()
        if not user_id:
            continue
        house_users.append(
            {
                "id": user_id,
                "name": row.get("name") or row.get("email") or "House / Contact Form",
                "email": row.get("email"),
                "role": row.get("role"),
                "salesRepId": str(row.get("sales_rep_id") or "").strip() or None,
                "leadType": row.get("lead_type") or "house",
                "leadTypeSource": row.get("lead_type_source") or "users.lead_type",
                "leadTypeLockedAt": row.get("lead_type_locked_at"),
                "phone": row.get("phone"),
                "officeAddressLine1": row.get("office_address_line1"),
                "officeAddressLine2": row.get("office_address_line2"),
                "officeCity": row.get("office_city"),
                "officeState": row.get("office_state"),
                "officePostalCode": row.get("office_postal_code"),
                "officeCountry": row.get("office_country"),
                "profileImageUrl": row.get("profile_image_url"),
            }
        )
    return house_users


def _is_doctor_role(role: Optional[str]) -> bool:
    normalized = str(role or "").strip().lower()
    return normalized in ("doctor", "test_doctor")


def _sync_user_permit_from_source(user: Optional[Dict], permit_source: Optional[Dict]) -> Optional[Dict]:
    if not isinstance(user, dict) or not user.get("id"):
        return user
    if not isinstance(permit_source, dict) or not str(permit_source.get("resellerPermitFilePath") or "").strip():
        return user
    permit_changed = any(
        str(user.get(key) or "").strip() != str(permit_source.get(key) or "").strip()
        for key in ("resellerPermitFilePath", "resellerPermitFileName", "resellerPermitUploadedAt")
    )
    preserve_manual_tax_exemption = bool(user.get("isTaxExempt")) and str(user.get("taxExemptSource") or "").strip().upper() not in (
        "",
        "RESELLER_PERMIT",
    )
    update_payload = {
        "id": user.get("id"),
        "resellerPermitFilePath": permit_source.get("resellerPermitFilePath"),
        "resellerPermitFileName": permit_source.get("resellerPermitFileName"),
        "resellerPermitUploadedAt": permit_source.get("resellerPermitUploadedAt"),
    }
    if permit_changed:
        update_payload["resellerPermitApprovedByRep"] = False
        update_payload["isTaxExempt"] = user.get("isTaxExempt") if preserve_manual_tax_exemption else False
        update_payload["taxExemptSource"] = user.get("taxExemptSource") if preserve_manual_tax_exemption else None
        update_payload["taxExemptReason"] = user.get("taxExemptReason") if preserve_manual_tax_exemption else None
    return user_repository.update(
        update_payload
    ) or user


def _has_reseller_permit_on_file(user: Optional[Dict]) -> bool:
    if not isinstance(user, dict):
        return False
    direct_path = str(user.get("resellerPermitFilePath") or "").strip()
    if direct_path:
        return True
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
            _sync_user_permit_from_source(
                user,
                {
                    "resellerPermitFilePath": file_path,
                    "resellerPermitFileName": prospect.get("resellerPermitFileName"),
                    "resellerPermitUploadedAt": prospect.get("resellerPermitUploadedAt"),
                },
            )
            return True
    return False


def _is_tax_exempt_for_checkout(user: Optional[Dict]) -> bool:
    if not isinstance(user, dict):
        return False
    source = str(user.get("taxExemptSource") or user.get("tax_exempt_source") or "").strip().upper()
    has_reseller_permit = _has_reseller_permit_on_file(user)
    if bool(user.get("isTaxExempt")) and source not in ("", "RESELLER_PERMIT"):
        return True
    if bool(user.get("isTaxExempt")) and not source and not has_reseller_permit:
        return True
    if not _is_doctor_role(user.get("role")) and not _is_sales_access_role(user.get("role")):
        return False
    if not has_reseller_permit:
        return False
    return _normalize_bool(
        user.get("resellerPermitApprovedByRep")
        if "resellerPermitApprovedByRep" in user
        else user.get("reseller_permit_approved_by_rep")
    )


def _can_user_use_hand_delivery_for_checkout(user: Optional[Dict]) -> bool:
    if not isinstance(user, dict):
        return False
    if not _is_doctor_role(user.get("role")) and not _is_sales_access_role(user.get("role")):
        return False
    return _normalize_bool(
        user.get("handDelivered")
        if "handDelivered" in user
        else user.get("hand_delivered")
    )


def _can_user_use_facility_pickup_for_checkout(user: Optional[Dict]) -> bool:
    if not isinstance(user, dict):
        return False
    return _is_sales_access_role(user.get("role"))


def _normalize_fulfillment_selector(value: object) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _is_facility_pickup_shipping_estimate(estimate: object) -> bool:
    if not isinstance(estimate, dict):
        return False
    normalized = {
        _normalize_fulfillment_selector(estimate.get("serviceType")),
        _normalize_fulfillment_selector(estimate.get("serviceCode")),
        _normalize_fulfillment_selector(estimate.get("carrierId")),
    }
    return bool({"facility_pickup", "fascility_pickup"} & normalized)


def _normalize_facility_address_part(value: object) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    text = re.sub(r"[.,#]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def _is_facility_pickup_address(address: object) -> bool:
    if not isinstance(address, dict):
        return False

    name = _normalize_facility_address_part(address.get("name"))
    line1 = _normalize_facility_address_part(address.get("addressLine1"))
    line2 = _normalize_facility_address_part(address.get("addressLine2"))
    combined = " ".join(part for part in (line1, line2) if part).strip()
    city = _normalize_facility_address_part(address.get("city"))
    state = _normalize_facility_address_part(address.get("state"))
    postal_code = _normalize_facility_address_part(
        address.get("postalCode") if address.get("postalCode") is not None else address.get("postcode")
    )

    matches_name = name == "peppro facility pickup"
    matches_street = line1 == "640 s grand ave" or "640 s grand ave" in combined
    matches_unit = line2 == "unit 107" or "unit 107" in combined
    matches_location = city == "santa ana" and state == "ca" and postal_code == "92705"
    return (matches_street and matches_unit and matches_location) or (matches_name and matches_location)


def _is_facility_pickup_recipient_placeholder(value: object) -> bool:
    return _normalize_facility_address_part(value) == _normalize_facility_address_part(
        FACILITY_PICKUP_LOCATION.get("name")
    )


def _is_facility_pickup_request(*, shipping_estimate: object, shipping_address: object) -> bool:
    return _is_facility_pickup_shipping_estimate(shipping_estimate) or _is_facility_pickup_address(shipping_address)


def _normalize_optional_text(value: object) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _resolve_order_exemption_snapshot(user: Optional[Dict], tax_exempt: bool = False) -> Dict[str, object]:
    user = user if isinstance(user, dict) else {}
    reseller_permit_file_path = _normalize_optional_text(
        user.get("resellerPermitFilePath") or user.get("reseller_permit_file_path")
    )
    reseller_permit_file_name = _normalize_optional_text(
        user.get("resellerPermitFileName") or user.get("reseller_permit_file_name")
    )
    reseller_permit_uploaded_at = _normalize_optional_text(
        user.get("resellerPermitUploadedAt") or user.get("reseller_permit_uploaded_at")
    )
    has_reseller_permit_uploaded = bool(
        reseller_permit_file_path or reseller_permit_file_name or reseller_permit_uploaded_at
    )
    tax_exempt_source = _normalize_optional_text(
        user.get("taxExemptSource") or user.get("tax_exempt_source")
    ) or ("RESELLER_PERMIT" if tax_exempt and has_reseller_permit_uploaded else None)
    tax_exempt_reason = _normalize_optional_text(
        user.get("taxExemptReason") or user.get("tax_exempt_reason")
    ) or ("Reseller permit approved by sales rep" if tax_exempt and has_reseller_permit_uploaded else None)
    return {
        "isTaxExempt": bool(tax_exempt),
        "taxExemptSource": tax_exempt_source,
        "taxExemptReason": tax_exempt_reason,
        "resellerPermitFilePath": reseller_permit_file_path,
        "resellerPermitFileName": reseller_permit_file_name,
        "resellerPermitUploadedAt": reseller_permit_uploaded_at,
        "resellerPermitApprovedByRep": _normalize_bool(
            user.get("resellerPermitApprovedByRep")
            if "resellerPermitApprovedByRep" in user
            else user.get("reseller_permit_approved_by_rep")
        ),
        "hasResellerPermitUploaded": has_reseller_permit_uploaded,
    }


def _normalize_country_code(value: object) -> str:
    normalized = str(value or "").strip().upper()
    if normalized in ("US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"):
        return "US"
    return normalized


def _normalize_state_lookup_value(value: object) -> str:
    normalized = str(value or "").strip()
    if not normalized:
        return ""
    return normalized.rstrip(",. ")


def _is_california_address(address: Optional[Dict]) -> bool:
    if not isinstance(address, dict):
        return False
    state_code, _state_name = tax_tracking_service.canonicalize_state(
        _normalize_state_lookup_value(address.get("state") or address.get("stateCode"))
    )
    return state_code == "CA"


def _resolve_woo_tax_class_for_lookup(value: object) -> Optional[str]:
    normalized = str(value or "").strip().lower()
    if normalized in ("", "standard", "none"):
        return None
    return normalized


def _calculate_tax_from_rates(rates: object, items_subtotal: float, shipping_total: float) -> float:
    if not isinstance(rates, list) or not rates:
        return 0.0
    sorted_rates = sorted(
        rates,
        key=lambda rate: int(_safe_float((rate or {}).get("priority"), 0)),
    )
    accumulated_tax = 0.0
    for rate in sorted_rates:
        if not isinstance(rate, dict):
            continue
        percentage = _safe_float(rate.get("rate"), 0.0)
        if percentage <= 0:
            continue
        multiplier = percentage / 100.0
        compound = bool(rate.get("compound"))
        shipping_applies = rate.get("shipping") in (True, 1, "1", "yes", "true")
        tax_base = float(items_subtotal) + accumulated_tax if compound else float(items_subtotal)
        line_tax = tax_base * multiplier
        shipping_tax = float(shipping_total) * multiplier if shipping_applies else 0.0
        accumulated_tax += line_tax + shipping_tax
    return accumulated_tax


def _fetch_woo_tax_rates_for_checkout(
    *,
    country: str,
    state: str,
    postcode: str,
    city: str,
    tax_class: Optional[str],
) -> List[Dict[str, Any]]:
    if not woo_commerce.is_configured():
        return []
    try:
        payload, _meta = woo_commerce.fetch_catalog_proxy(
            "taxes",
            {
                "country": country or None,
                "state": state or None,
                "postcode": postcode or None,
                "city": city or None,
                "class": tax_class or None,
                "per_page": 100,
            },
        )
        return payload if isinstance(payload, list) else []
    except Exception:
        logger.warning("Woo tax rate lookup failed during checkout", exc_info=True)
        raise


def _calculate_checkout_tax(
    *,
    items_subtotal: float,
    shipping_total: float,
    shipping_address: Optional[Dict],
) -> Tuple[float, str, Optional[Dict[str, Any]]]:
    address = shipping_address or {}
    country = _normalize_country_code(address.get("country") or "US")
    if country != "US":
        return 0.0, "non_us", None

    if _is_california_address(address):
        tax_total = round(max(0.0, float(items_subtotal or 0.0) * _CA_FIXED_TAX_RATE), 2)
        state_profile = tax_tracking_service.get_state_tax_profile("CA")
        return tax_total, "ca_fixed_rate", state_profile

    state_profile = tax_tracking_service.get_state_tax_profile(
        _normalize_state_lookup_value(address.get("state") or address.get("stateCode"))
    )
    if not bool(state_profile.get("nexusTriggered")):
        return 0.0, "no_nexus", state_profile
    if not bool(state_profile.get("collectTaxDefault")):
        return 0.0, "state_no_collection", state_profile
    if not bool(state_profile.get("taxCollectionRequiredAfterNexus")):
        return 0.0, "state_not_collectable_after_nexus", state_profile
    if not bool(state_profile.get("researchReagentTaxable", True)):
        return 0.0, "product_not_taxable", state_profile

    try:
        buffered_rate = float(state_profile.get("bufferedTaxRate"))
    except Exception:
        buffered_rate = 0.0
    if buffered_rate <= 0:
        return 0.0, "buffered_rate_missing", state_profile
    tax_total = round(max(0.0, float(items_subtotal or 0.0) * buffered_rate), 2)
    return tax_total, "buffered_tax_rate", state_profile


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
            role = _normalize_role(user.get("role"))
            if _is_sales_access_role(role):
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


def _extract_woo_details(integrations_value):
    integrations = _ensure_dict(integrations_value)
    return _ensure_dict(integrations.get("wooCommerce") or integrations.get("woocommerce"))


def _extract_peppro_order_id_from_integrations(integrations_value, fallback=None):
    woo_details = _extract_woo_details(integrations_value)
    return (
        woo_details.get("pepproOrderId")
        or woo_details.get("peppro_order_id")
        or fallback
    )


def _extract_image_source(value: object) -> Optional[str]:
    if isinstance(value, str):
        normalized = value.strip()
        return normalized or None
    if isinstance(value, dict):
        for key in ("src", "url", "href", "source", "image", "imageUrl", "image_url", "thumbnail", "thumb"):
            resolved = _extract_image_source(value.get(key))
            if resolved:
                return resolved
        return None
    if isinstance(value, list):
        for entry in value:
            resolved = _extract_image_source(entry)
            if resolved:
                return resolved
    return None


def _parse_positive_int(value: object) -> Optional[int]:
    try:
        parsed = int(str(value or "").strip())
    except Exception:
        return None
    return parsed if parsed > 0 else None


def _decode_snapshot_product_row(row: object) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return None
    raw = row.get("data")
    if isinstance(raw, memoryview):
        raw = raw.tobytes()
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except Exception:
            return None
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _get_catalog_snapshot_product(*, product_id: object = None, sku: object = None) -> Optional[Dict[str, Any]]:
    normalized_product_id = _parse_positive_int(product_id)
    if normalized_product_id is not None:
        try:
            row = mysql_client.fetch_one(
                """
                SELECT data
                FROM product_documents
                WHERE woo_product_id = %(woo_product_id)s
                  AND kind IN (%(kind_full)s, %(kind_light)s)
                ORDER BY CASE WHEN kind = %(kind_full)s THEN 0 ELSE 1 END
                LIMIT 1
                """,
                {
                    "woo_product_id": normalized_product_id,
                    "kind_full": "catalog_product_full",
                    "kind_light": "catalog_product_light",
                },
            )
        except Exception:
            row = None
        parsed = _decode_snapshot_product_row(row)
        if parsed:
            return parsed

    normalized_sku = _normalize_optional_text(sku)
    if normalized_sku:
        try:
            row = mysql_client.fetch_one(
                """
                SELECT data
                FROM product_documents
                WHERE product_sku = %(product_sku)s
                  AND kind IN (%(kind_full)s, %(kind_light)s)
                ORDER BY CASE WHEN kind = %(kind_full)s THEN 0 ELSE 1 END,
                         woo_synced_at DESC,
                         updated_at DESC
                LIMIT 1
                """,
                {
                    "product_sku": normalized_sku,
                    "kind_full": "catalog_product_full",
                    "kind_light": "catalog_product_light",
                },
            )
        except Exception:
            row = None
        parsed = _decode_snapshot_product_row(row)
        if parsed:
            return parsed

    return None


def _resolve_catalog_snapshot_line_item_image(
    item: Dict[str, Any],
    *,
    snapshot_by_product_id: Dict[int, Optional[Dict[str, Any]]],
    snapshot_by_sku: Dict[str, Optional[Dict[str, Any]]],
) -> Optional[str]:
    product_id = _parse_positive_int(
        item.get("productId") or item.get("product_id") or item.get("wooProductId") or item.get("id")
    )
    variation_id = _parse_positive_int(
        item.get("variationId")
        or item.get("variation_id")
        or item.get("variantId")
        or item.get("variant_id")
        or item.get("wooVariationId")
    )
    sku = _normalize_optional_text(item.get("sku"))

    snapshot: Optional[Dict[str, Any]] = None
    if product_id is not None:
        if product_id not in snapshot_by_product_id:
            snapshot_by_product_id[product_id] = _get_catalog_snapshot_product(product_id=product_id)
        snapshot = snapshot_by_product_id.get(product_id)

    normalized_sku_key = sku.lower() if sku else None
    if snapshot is None and normalized_sku_key:
        if normalized_sku_key not in snapshot_by_sku:
            snapshot_by_sku[normalized_sku_key] = _get_catalog_snapshot_product(sku=sku)
        snapshot = snapshot_by_sku.get(normalized_sku_key)

    if not isinstance(snapshot, dict):
        return None

    if variation_id is not None:
        for variation in snapshot.get("variations") or []:
            if not isinstance(variation, dict):
                continue
            if _parse_positive_int(variation.get("id")) != variation_id:
                continue
            resolved = _extract_image_source(variation.get("image")) or _extract_image_source(variation.get("images"))
            if resolved:
                return resolved

    return _extract_image_source(snapshot.get("image")) or _extract_image_source(snapshot.get("images"))


def _resolve_live_woo_line_item_image(
    item: Dict[str, Any],
    *,
    woo_image_cache: Dict[tuple, Optional[str]],
) -> Optional[str]:
    product_id = _parse_positive_int(
        item.get("productId") or item.get("product_id") or item.get("wooProductId") or item.get("id")
    )
    variation_id = _parse_positive_int(
        item.get("variationId")
        or item.get("variation_id")
        or item.get("variantId")
        or item.get("variant_id")
        or item.get("wooVariationId")
    )
    sku = _normalize_optional_text(item.get("sku"))

    if product_id is not None and variation_id is not None:
        variation_key = ("variation", product_id, variation_id)
        if variation_key not in woo_image_cache:
            try:
                variation = woo_commerce.fetch_catalog(f"products/{product_id}/variations/{variation_id}")
            except Exception:
                variation = None
            woo_image_cache[variation_key] = (
                _extract_image_source((variation or {}).get("image"))
                or _extract_image_source((variation or {}).get("images"))
                if isinstance(variation, dict)
                else None
            )
        if woo_image_cache.get(variation_key):
            return woo_image_cache[variation_key]

    if product_id is not None:
        product_key = ("product", product_id)
        if product_key not in woo_image_cache:
            try:
                product = woo_commerce.fetch_catalog(f"products/{product_id}")
            except Exception:
                product = None
            woo_image_cache[product_key] = (
                _extract_image_source((product or {}).get("image"))
                or _extract_image_source((product or {}).get("images"))
                if isinstance(product, dict)
                else None
            )
        if woo_image_cache.get(product_key):
            return woo_image_cache[product_key]

    if sku:
        sku_key = ("sku", sku.lower())
        if sku_key not in woo_image_cache:
            try:
                product = woo_commerce.find_product_by_sku(sku)
            except Exception:
                product = None
            woo_image_cache[sku_key] = (
                _extract_image_source((product or {}).get("image"))
                or _extract_image_source((product or {}).get("images"))
                if isinstance(product, dict)
                else None
            )
        if woo_image_cache.get(sku_key):
            return woo_image_cache[sku_key]

    return None


def _hydrate_line_items_with_images(
    line_items: object,
    *,
    persist_order_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    if not isinstance(line_items, list):
        return []

    snapshot_by_product_id: Dict[int, Optional[Dict[str, Any]]] = {}
    snapshot_by_sku: Dict[str, Optional[Dict[str, Any]]] = {}
    woo_image_cache: Dict[tuple, Optional[str]] = {}
    updated_items: List[Dict[str, Any]] = []
    changed = False

    for raw_item in line_items:
        if not isinstance(raw_item, dict):
            continue

        item = dict(raw_item)
        resolved_image = (
            _extract_image_source(item.get("image"))
            or _extract_image_source(item.get("imageUrl"))
            or _extract_image_source(item.get("image_url"))
            or _extract_image_source(item.get("thumbnail"))
            or _extract_image_source(item.get("thumb"))
        )

        if not resolved_image:
            resolved_image = _resolve_catalog_snapshot_line_item_image(
                item,
                snapshot_by_product_id=snapshot_by_product_id,
                snapshot_by_sku=snapshot_by_sku,
            ) or _resolve_live_woo_line_item_image(item, woo_image_cache=woo_image_cache)

        if resolved_image:
            if item.get("image") != resolved_image:
                item["image"] = resolved_image
                changed = True
            if _normalize_optional_text(item.get("imageUrl")) != resolved_image:
                item["imageUrl"] = resolved_image
                changed = True
            if _normalize_optional_text(item.get("thumbnail")) != resolved_image:
                item["thumbnail"] = resolved_image
                changed = True

        updated_items.append(item)

    if changed and persist_order_id:
        try:
            order_repository.update_items(persist_order_id, updated_items)
        except Exception:
            logger.warning(
                "Failed to persist order item image backfill",
                exc_info=True,
                extra={"orderId": persist_order_id},
            )

    return updated_items


def _normalize_ups_tracking_status(value: Any) -> Optional[str]:
    normalized = ups_tracking.normalize_tracking_status(value)
    if not normalized or normalized == "unknown":
        return None
    return normalized


def _normalize_delivery_date(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _normalize_ups_estimated_delivery_value(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _normalize_ups_expected_shipment_window(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    if not text:
        return None
    if len(text) <= 128:
        return text
    return text[:128].rstrip() or None


def _normalize_timestamp_like_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    text = str(value or "").strip()
    if not text:
        return None
    normalized = text
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    if " " in normalized and "T" not in normalized:
        normalized = normalized.replace(" ", "T", 1)
    try:
        datetime.fromisoformat(normalized)
    except Exception:
        return None
    return normalized


def _extract_delivery_date(*orders: Optional[Dict]) -> Optional[str]:
    for order in orders:
        if not isinstance(order, dict):
            continue
        estimate = _ensure_dict(order.get("shippingEstimate"))
        integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        carrier_tracking = _ensure_dict(integrations.get("carrierTracking") or integrations.get("carrier_tracking"))
        for candidate in (
            order.get("deliveryDate"),
            order.get("delivery_date"),
            order.get("expectedShipmentWindow"),
            order.get("expected_shipment_window"),
            estimate.get("deliveryDateGuaranteed"),
            estimate.get("delivery_date_guaranteed"),
            estimate.get("estimatedArrivalDate"),
            estimate.get("estimated_arrival_date"),
            order.get("upsDeliveredAt"),
            estimate.get("deliveredAt"),
            estimate.get("delivered_at"),
            carrier_tracking.get("deliveredAt"),
            carrier_tracking.get("delivered_at"),
        ):
            normalized = _normalize_delivery_date(candidate)
            if normalized:
                return normalized
    return None


def _extract_ups_delivered_at(*orders: Optional[Dict]) -> Optional[str]:
    for order in orders:
        if not isinstance(order, dict):
            continue
        estimate = _ensure_dict(order.get("shippingEstimate"))
        integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        carrier_tracking = _ensure_dict(integrations.get("carrierTracking") or integrations.get("carrier_tracking"))
        for candidate in (
            order.get("upsDeliveredAt"),
            estimate.get("deliveredAt"),
            estimate.get("delivered_at"),
            carrier_tracking.get("deliveredAt"),
            carrier_tracking.get("delivered_at"),
        ):
            normalized = _normalize_delivery_date(candidate)
            if normalized:
                return normalized
        delivered_status = _normalize_ups_tracking_status(
            order.get("upsTrackingStatus")
            if order.get("upsTrackingStatus") is not None
            else order.get("ups_tracking_status") or estimate.get("status")
        )
        if delivered_status == "delivered":
            for candidate in (
                order.get("deliveryDate"),
                order.get("delivery_date"),
            ):
                normalized = _normalize_timestamp_like_value(candidate)
                if normalized:
                    return normalized
    return None


def _extract_persisted_delivery_date(*orders: Optional[Dict]) -> Optional[str]:
    for order in orders:
        if not isinstance(order, dict):
            continue
        for candidate in (
            order.get("delivery_date"),
        ):
            normalized = _normalize_delivery_date(candidate)
            if normalized:
                return normalized
    return None


def _extract_ups_estimated_arrival_date(*orders: Optional[Dict]) -> Optional[str]:
    for order in orders:
        if not isinstance(order, dict):
            continue
        estimate = _ensure_dict(order.get("shippingEstimate"))
        for candidate in (
            estimate.get("estimatedArrivalDate"),
            estimate.get("estimated_arrival_date"),
            estimate.get("deliveryDateGuaranteed"),
            estimate.get("delivery_date_guaranteed"),
        ):
            normalized = _normalize_ups_estimated_delivery_value(candidate)
            if normalized:
                return normalized
    return None


def _extract_ups_delivery_date_guaranteed(*orders: Optional[Dict]) -> Optional[str]:
    for order in orders:
        if not isinstance(order, dict):
            continue
        estimate = _ensure_dict(order.get("shippingEstimate"))
        for candidate in (
            estimate.get("deliveryDateGuaranteed"),
            estimate.get("delivery_date_guaranteed"),
            estimate.get("estimatedArrivalDate"),
            estimate.get("estimated_arrival_date"),
        ):
            normalized = _normalize_ups_estimated_delivery_value(candidate)
            if normalized:
                return normalized
    return None


def _extract_ups_expected_shipment_window(*orders: Optional[Dict]) -> Optional[str]:
    for order in orders:
        if not isinstance(order, dict):
            continue
        for candidate in (
            order.get("expectedShipmentWindow"),
            order.get("expected_shipment_window"),
        ):
            normalized = _normalize_ups_expected_shipment_window(candidate)
            if normalized:
                return normalized
    return None


def _apply_ups_delivery_estimate(
    order: Dict,
    *,
    estimated_arrival_date: Optional[str] = None,
    delivery_date_guaranteed: Optional[str] = None,
    expected_shipment_window: Optional[str] = None,
    clear: bool = False,
) -> None:
    if not isinstance(order, dict):
        return
    estimate = _ensure_dict(order.get("shippingEstimate"))
    if clear:
        estimate.pop("estimatedArrivalDate", None)
        estimate.pop("deliveryDateGuaranteed", None)
        order["expectedShipmentWindow"] = None
    else:
        if estimated_arrival_date:
            estimate["estimatedArrivalDate"] = estimated_arrival_date
        if delivery_date_guaranteed:
            estimate["deliveryDateGuaranteed"] = delivery_date_guaranteed
        if expected_shipment_window:
            order["expectedShipmentWindow"] = expected_shipment_window
    order["shippingEstimate"] = estimate


def _apply_authoritative_ups_tracking_status(order: Dict) -> Optional[str]:
    if not isinstance(order, dict):
        return None
    raw_status = order.get("upsTrackingStatus") if order.get("upsTrackingStatus") is not None else order.get("ups_tracking_status")
    normalized = _normalize_ups_tracking_status(raw_status)
    delivery_date = _extract_delivery_date(order)
    delivered_at = _extract_ups_delivered_at(order)
    order["upsTrackingStatus"] = normalized
    order["deliveryDate"] = delivery_date
    order["upsDeliveredAt"] = delivered_at
    if not normalized:
        estimate = _ensure_dict(order.get("shippingEstimate"))
        raw_estimate_status = str(estimate.get("status") or "").strip().lower().replace("-", "_").replace(" ", "_")
        raw_status_token = str(raw_status or "").strip().lower().replace("-", "_").replace(" ", "_")
        if raw_status_token == "unknown" or raw_estimate_status == "unknown":
            estimate.pop("status", None)
            order["shippingEstimate"] = estimate
        return None
    estimate = _ensure_dict(order.get("shippingEstimate"))
    estimate["status"] = normalized
    if normalized == "delivered":
        if delivered_at:
            estimate["deliveredAt"] = delivered_at
        _apply_ups_delivery_estimate(order, clear=True)
    else:
        estimate.pop("deliveredAt", None)
        order["upsDeliveredAt"] = None
    order["shippingEstimate"] = estimate
    return normalized


def _resolve_known_delivery_date_value(
    *,
    delivered_at: Optional[str] = None,
    estimated_arrival_date: Optional[str] = None,
    delivery_date_guaranteed: Optional[str] = None,
    expected_shipment_window: Optional[str] = None,
) -> Optional[str]:
    return (
        _normalize_ups_expected_shipment_window(expected_shipment_window)
        or _normalize_ups_estimated_delivery_value(delivery_date_guaranteed)
        or _normalize_ups_estimated_delivery_value(estimated_arrival_date)
        or _normalize_delivery_date(delivered_at)
    )


def _extract_tracking_number_for_ups_refresh(*orders: Optional[Dict]) -> Optional[str]:
    for order in orders:
        if not isinstance(order, dict):
            continue
        candidates = [
            order.get("trackingNumber"),
            order.get("tracking_number"),
        ]
        estimate = _ensure_dict(order.get("shippingEstimate"))
        candidates.extend(
            [
                estimate.get("trackingNumber"),
                estimate.get("tracking_number"),
            ]
        )
        integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        shipstation = _ensure_dict(integrations.get("shipStation") or integrations.get("shipstation"))
        candidates.extend(
            [
                shipstation.get("trackingNumber"),
                shipstation.get("tracking_number"),
            ]
        )
        for candidate in candidates:
            text = str(candidate or "").strip()
            if text:
                return text
    return None


def _is_ups_order_for_refresh(*orders: Optional[Dict]) -> bool:
    tracking_number = _extract_tracking_number_for_ups_refresh(*orders)
    if ups_tracking.looks_like_ups_tracking_number(tracking_number):
        return True

    for order in orders:
        if not isinstance(order, dict):
            continue
        candidates = [
            order.get("shippingCarrier"),
            order.get("shipping_carrier"),
        ]
        estimate = _ensure_dict(order.get("shippingEstimate"))
        candidates.extend(
            [
                estimate.get("carrierId"),
                estimate.get("carrier_id"),
            ]
        )
        integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        shipstation = _ensure_dict(integrations.get("shipStation") or integrations.get("shipstation"))
        candidates.extend(
            [
                shipstation.get("carrierCode"),
                shipstation.get("carrier_code"),
            ]
        )
        for candidate in candidates:
            token = str(candidate or "").strip().lower().replace("-", "_").replace(" ", "_")
            if token == "ups" or token.startswith("ups_"):
                return True
    return False


def _resolve_peppro_order_id_for_ups_refresh(order: Dict, local_order: Optional[Dict]) -> Optional[str]:
    candidates: List[Any] = []
    if isinstance(local_order, dict):
        candidates.append(local_order.get("id"))

    if isinstance(order, dict):
        candidates.append(order.get("id"))
        candidates.append(order.get("pepproOrderId"))
        integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        woo_details = _ensure_dict(integrations.get("wooCommerce") or integrations.get("woocommerce"))
        candidates.extend(
            [
                woo_details.get("pepproOrderId"),
                woo_details.get("peppro_order_id"),
            ]
        )

    for candidate in candidates:
        text = str(candidate or "").strip()
        if text:
            return text
    return None


def _iter_order_identifier_candidates_for_ups_refresh(*orders: Optional[Dict]) -> List[str]:
    seen: set[str] = set()
    result: List[str] = []

    def add_candidate(value: Any) -> None:
        text = str(value or "").strip()
        if not text:
            return
        variants = [text]
        base = text[1:] if text.startswith("#") else text
        if base:
            variants.append(base)
            variants.append(f"#{base}")
        normalized_woo = _normalize_woo_order_id(text)
        if normalized_woo:
            variants.append(normalized_woo)
            variants.append(f"#{normalized_woo}")
        for variant in variants:
            cleaned = str(variant or "").strip()
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                result.append(cleaned)

    for order in orders:
        if not isinstance(order, dict):
            continue
        integrations = _ensure_dict(order.get("integrationDetails") or order.get("integrations"))
        woo_details = _ensure_dict(integrations.get("wooCommerce") or integrations.get("woocommerce"))
        response = _ensure_dict(woo_details.get("response"))
        payload = _ensure_dict(woo_details.get("payload"))
        for candidate in (
            order.get("id"),
            order.get("pepproOrderId"),
            order.get("wooOrderId"),
            order.get("woo_order_id"),
            order.get("wooOrderNumber"),
            order.get("woo_order_number"),
            order.get("number"),
            woo_details.get("pepproOrderId"),
            woo_details.get("peppro_order_id"),
            woo_details.get("id"),
            woo_details.get("orderId"),
            woo_details.get("orderNumber"),
            response.get("id"),
            response.get("number"),
            payload.get("id"),
            payload.get("number"),
        ):
            add_candidate(candidate)
    return result


def _resolve_local_order_for_ups_refresh(order: Dict, local_order: Optional[Dict]) -> Optional[Dict]:
    if isinstance(local_order, dict) and str(local_order.get("id") or "").strip():
        return local_order
    for candidate in _iter_order_identifier_candidates_for_ups_refresh(local_order, order):
        try:
            resolved = order_repository.find_by_order_identifier(candidate)
        except Exception:
            resolved = None
        if isinstance(resolved, dict):
            return resolved
    return local_order


def _refresh_authoritative_ups_status_for_order_view(order: Dict, *, local_order: Optional[Dict] = None) -> Optional[Dict]:
    if not isinstance(order, dict):
        return local_order

    local_order = _resolve_local_order_for_ups_refresh(order, local_order)
    tracking_number = _extract_tracking_number_for_ups_refresh(order, local_order)
    if not tracking_number or not _is_ups_order_for_refresh(order, local_order):
        return local_order

    try:
        info = ups_tracking.fetch_tracking_status(tracking_number)
    except Exception:
        logger.warning(
            "UPS live status refresh failed",
            exc_info=True,
            extra={
                "trackingNumber": tracking_number,
                "orderId": (
                    (local_order or {}).get("id")
                    or _resolve_peppro_order_id_for_ups_refresh(order, local_order)
                    or order.get("id")
                ),
            },
        )
        return local_order

    if not isinstance(info, dict):
        return local_order

    normalized = _normalize_ups_tracking_status(info.get("trackingStatus") or info.get("trackingStatusRaw"))
    if not normalized:
        return local_order

    live_tracking_number = str(info.get("trackingNumber") or tracking_number).strip() or tracking_number
    delivered_at = _normalize_delivery_date(info.get("deliveredAt"))
    estimated_arrival_date = _normalize_ups_estimated_delivery_value(
        info.get("estimatedArrivalDate") or info.get("estimated_arrival_date")
    )
    delivery_date_guaranteed = _normalize_ups_estimated_delivery_value(
        info.get("deliveryDateGuaranteed") or info.get("delivery_date_guaranteed")
    )
    expected_shipment_window = _normalize_ups_expected_shipment_window(
        info.get("expectedShipmentWindow") or info.get("expected_shipment_window")
    )
    delivery_date = _resolve_known_delivery_date_value(
        delivered_at=delivered_at,
        estimated_arrival_date=estimated_arrival_date,
        delivery_date_guaranteed=delivery_date_guaranteed,
        expected_shipment_window=expected_shipment_window,
    )
    current_status = (
        _normalize_ups_tracking_status(order.get("upsTrackingStatus") if order.get("upsTrackingStatus") is not None else order.get("ups_tracking_status"))
        or _normalize_ups_tracking_status(
            (local_order or {}).get("upsTrackingStatus")
            if isinstance(local_order, dict) and (local_order or {}).get("upsTrackingStatus") is not None
            else (local_order or {}).get("ups_tracking_status") if isinstance(local_order, dict) else None
        )
    )
    current_delivered_at = _extract_ups_delivered_at(order, local_order)
    current_persisted_delivery_date = _extract_persisted_delivery_date(order, local_order)
    current_estimated_arrival_date = _extract_ups_estimated_arrival_date(order, local_order)
    current_delivery_date_guaranteed = _extract_ups_delivery_date_guaranteed(order, local_order)
    current_expected_shipment_window = _extract_ups_expected_shipment_window(order, local_order)

    refreshed_local_order = local_order
    peppro_order_id = _resolve_peppro_order_id_for_ups_refresh(order, local_order)
    should_persist = current_status != normalized or (
        delivery_date and current_persisted_delivery_date != delivery_date
    ) or (
        normalized == "delivered" and delivered_at and current_delivered_at != delivered_at
    ) or (
        normalized != "delivered" and (
            (estimated_arrival_date and current_estimated_arrival_date != estimated_arrival_date)
            or (delivery_date_guaranteed and current_delivery_date_guaranteed != delivery_date_guaranteed)
            or (expected_shipment_window and current_expected_shipment_window != expected_shipment_window)
        )
    )
    if peppro_order_id and should_persist:
        try:
            persisted = order_repository.update_ups_tracking_status(
                peppro_order_id,
                ups_tracking_status=normalized,
                delivered_at=delivered_at,
                estimated_arrival_date=estimated_arrival_date,
                delivery_date_guaranteed=delivery_date_guaranteed,
                expected_shipment_window=expected_shipment_window,
            )
            if isinstance(persisted, dict):
                refreshed_local_order = persisted
        except Exception:
            logger.warning(
                "Failed to persist refreshed UPS tracking status",
                exc_info=True,
                extra={"orderId": peppro_order_id, "trackingNumber": live_tracking_number, "upsTrackingStatus": normalized},
            )

    for target in (order, local_order, refreshed_local_order):
        if not isinstance(target, dict):
            continue
        target["trackingNumber"] = live_tracking_number
        target["upsTrackingStatus"] = normalized
        target["deliveryDate"] = delivery_date
        target["upsDeliveredAt"] = delivered_at if normalized == "delivered" else None
        _apply_ups_delivery_estimate(
            target,
            estimated_arrival_date=estimated_arrival_date,
            delivery_date_guaranteed=delivery_date_guaranteed,
            expected_shipment_window=expected_shipment_window,
            clear=normalized == "delivered",
        )
        _apply_authoritative_ups_tracking_status(target)

    return refreshed_local_order


def _validate_items(items: Optional[List[Dict]]) -> bool:
    return bool(
        isinstance(items, list)
        and items
        and all(isinstance(item, dict) and isinstance(item.get("quantity"), (int, float)) for item in items)
    )


def _sum_cart_quantity(items: Optional[List[Dict]]) -> int:
    if not isinstance(items, list):
        return 0
    total = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            qty = int(float(item.get("quantity") or 0))
        except Exception:
            qty = 0
        if qty > 0:
            total += qty
    return total


def _normalize_address_field(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    cleaned = str(value).strip()
    return cleaned or None


def _split_person_name(value: object) -> tuple[str, str]:
    text = str(value or "").strip()
    if not text:
        return "", ""
    parts = [part for part in re.split(r"\s+", text) if part]
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return parts[0], " ".join(parts[1:])


def _apply_facility_pickup_recipient_name(address: object, recipient_name: object) -> object:
    if not isinstance(address, dict):
        return address
    normalized_name = _normalize_address_field(recipient_name)
    if not normalized_name or _is_facility_pickup_recipient_placeholder(normalized_name):
        return address
    first_name, last_name = _split_person_name(normalized_name)
    return {
        **address,
        "name": normalized_name,
        "fullName": normalized_name,
        "recipientName": normalized_name,
        "recipient_name": normalized_name,
        "orderRecipientName": normalized_name,
        "order_recipient_name": normalized_name,
        "pickupRecipientName": normalized_name,
        "pickup_recipient_name": normalized_name,
        "firstName": first_name,
        "lastName": last_name,
        "first_name": first_name,
        "last_name": last_name,
    }


def _build_facility_pickup_shipping_address(
    user: Optional[Dict],
    shipping_address: Optional[Dict],
    recipient_name: object = None,
) -> Dict[str, Optional[str]]:
    shipping_address = shipping_address if isinstance(shipping_address, dict) else {}
    address_name = _normalize_address_field(
        shipping_address.get("recipientName")
        or shipping_address.get("recipient_name")
        or shipping_address.get("orderRecipientName")
        or shipping_address.get("order_recipient_name")
        or shipping_address.get("pickupRecipientName")
        or shipping_address.get("pickup_recipient_name")
        or shipping_address.get("fullName")
        or shipping_address.get("name")
    )
    submitted_name = _normalize_address_field(recipient_name)
    if submitted_name and _is_facility_pickup_recipient_placeholder(submitted_name):
        submitted_name = None
    if address_name and _is_facility_pickup_recipient_placeholder(address_name):
        address_name = None
    actor_name = _normalize_address_field((user or {}).get("name") if isinstance(user, dict) else None)
    if (
        submitted_name
        and address_name
        and actor_name
        and submitted_name.lower() == actor_name.lower()
        and address_name.lower() != submitted_name.lower()
    ):
        submitted_name = address_name
    resolved_name = (
        submitted_name
        or address_name
        or actor_name
        or FACILITY_PICKUP_LOCATION.get("name")
    )
    return _apply_facility_pickup_recipient_name({
        **FACILITY_PICKUP_LOCATION,
        "name": resolved_name,
    }, resolved_name)


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
    facility_pickup: bool = False,
    payment_method: Optional[str] = None,
    discount_code: Optional[str] = None,
) -> Dict:
    if not _validate_items(items):
        err = ValueError("Invalid items payload")
        setattr(err, "status", 400)
        raise err

    shipping_address = shipping_address or {}
    user = user_repository.find_by_id(user_id) if user_id else None
    facility_pickup_requested = bool(facility_pickup) and _is_facility_pickup_request(
        shipping_estimate=shipping_estimate,
        shipping_address=shipping_address,
    )
    is_facility_pickup = facility_pickup_requested and _can_user_use_facility_pickup_for_checkout(user)
    is_hand_delivery = bool(facility_pickup) and not facility_pickup_requested and _can_user_use_hand_delivery_for_checkout(user)
    bypass_shipping = is_facility_pickup or is_hand_delivery
    if is_facility_pickup:
        shipping_address = _build_facility_pickup_shipping_address(user, shipping_address)
    try:
        shipping_total_value = float(shipping_total or 0)
    except Exception:
        shipping_total_value = 0.0
    shipping_total_value = 0.0 if bypass_shipping else max(0.0, shipping_total_value)
    shipping_timing = {
        "averageBusinessDays": None,
        "roundedBusinessDays": 0 if bypass_shipping else 1,
        "sampleSize": 0,
        "usedHistoricalAverage": False,
    }
    if not bypass_shipping:
        try:
            shipping_timing = _get_historical_ship_time_average()
        except Exception:
            logger.warning("Failed to compute historical ship-time average", exc_info=True)

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

    normalized_discount_code = (discount_code or "").strip().upper() or None
    if test_override:
        normalized_discount_code = None

    cart_quantity = _sum_cart_quantity(items)
    discount_code_amount = 0.0
    items_total_effective = float(items_total)
    if normalized_discount_code:
        applied = discount_code_service.apply_discount_to_subtotal(
            user_id=user_id,
            user_role=role,
            code=normalized_discount_code,
            items_subtotal=float(items_total),
            cart_quantity=cart_quantity,
        )
        discount_code_amount = float(applied.get("discountAmount") or 0.0)
        items_total_effective = max(0.0, float(items_total) - max(0.0, discount_code_amount))
        normalized_discount_code = str(applied.get("code") or normalized_discount_code).strip().upper() or normalized_discount_code

    if _is_tax_exempt_for_checkout(user):
        original_grand_total = max(0.0, items_total_effective + shipping_total_value)
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
                "shippingTiming": shipping_timing,
            }
        return {
            "success": True,
            "totals": {
                "itemsTotal": round(items_total_effective, 2),
                "shippingTotal": round(shipping_total_value, 2),
                "taxTotal": 0.0,
                "grandTotal": round(original_grand_total, 2),
                "currency": "USD",
                "source": "tax_exempt",
                "testPaymentOverrideApplied": False,
                "originalItemsTotal": round(items_total, 2),
                "discountCode": normalized_discount_code,
                "discountCodeAmount": round(max(0.0, discount_code_amount), 2),
            },
            "shippingTiming": shipping_timing,
        }

    address = shipping_address or {}
    country = str(address.get("country") or "US").strip().upper()
    state = _normalize_address_field(address.get("state")) or ""
    postal = _normalize_address_field(address.get("postalCode") or address.get("postcode") or address.get("zip")) or ""
    if not bypass_shipping and country == "US" and (not state or not postal):
        err = ValueError("Shipping address must include state and postal code")
        setattr(err, "status", 400)
        raise err

    tax_total = 0.0
    source = "flat_zero"
    tax_total, source, _state_profile = _calculate_checkout_tax(
        items_subtotal=float(items_total_effective),
        shipping_total=float(shipping_total_value),
        shipping_address=address,
    )
    grand_total = max(0.0, items_total_effective + shipping_total_value + tax_total)

    totals = {
        "itemsTotal": round(items_total_effective, 2),
        "shippingTotal": round(shipping_total_value, 2),
        "taxTotal": round(tax_total, 2),
        "grandTotal": round(grand_total, 2),
        "currency": "USD",
        "source": source,
        "originalItemsTotal": round(items_total, 2),
        "discountCode": normalized_discount_code,
        "discountCodeAmount": round(max(0.0, discount_code_amount), 2),
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

    if (os.environ.get("STRIPE_TAX_DEBUG") or "").strip().lower() in ("1", "true", "yes", "on"):
        logger.info("[TaxEstimate] Result %s", totals)

    return {"success": True, "totals": totals, "shippingTiming": shipping_timing}


def _resolve_sales_rep_context(doctor: Dict) -> Dict[str, Optional[str]]:
    rep_id = str(doctor.get("salesRepId") or doctor.get("sales_rep_id") or "").strip()
    if not rep_id:
        return {}

    rep = sales_rep_repository.find_by_id(rep_id)
    if not rep:
        rep_user = user_repository.find_by_id(rep_id)
        if rep_user and _is_sales_rep_role(rep_user.get("role")):
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
    discount_code: Optional[str] = None,
    payment_method: Optional[str] = None,
    pricing_mode: Optional[str] = None,
    tax_total: Optional[float] = None,
    shipping_total: Optional[float] = None,
    shipping_address: Optional[Dict] = None,
    facility_pickup_recipient_name: Optional[str] = None,
    facility_pickup: bool = False,
    shipping_rate: Optional[Dict] = None,
    expected_shipment_window: Optional[str] = None,
    physician_certified: bool = False,
    as_delegate_label: Optional[str] = None,
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
    checkout_profile_user = user_repository.find_by_id(user_id) if tax_exempt else user
    order_exemption_snapshot = _resolve_order_exemption_snapshot(checkout_profile_user, tax_exempt)
    sales_rep_ctx = _resolve_sales_rep_context(user)
    raw_payment_method = str(payment_method or "").strip().lower()
    normalized_payment_method = raw_payment_method
    if normalized_payment_method in ("bacs", "bank", "bank_transfer", "direct_bank_transfer", "zelle"):
        normalized_payment_method = "bacs"
    else:
        normalized_payment_method = "stripe"

    now = _now_order_iso()
    shipping_address = shipping_address or {}
    shipping_rate = shipping_rate if isinstance(shipping_rate, dict) else {}
    facility_pickup_requested = bool(facility_pickup) and _is_facility_pickup_request(
        shipping_estimate=shipping_rate,
        shipping_address=shipping_address,
    )
    is_facility_pickup = facility_pickup_requested and _can_user_use_facility_pickup_for_checkout(user)
    is_hand_delivery = bool(facility_pickup) and not facility_pickup_requested and _can_user_use_hand_delivery_for_checkout(user)
    bypass_shipping = is_facility_pickup or is_hand_delivery
    billing_address = None
    if is_facility_pickup:
        address_pickup_recipient_name = _normalize_address_field(
            shipping_address.get("recipientName")
            or shipping_address.get("recipient_name")
            or shipping_address.get("orderRecipientName")
            or shipping_address.get("order_recipient_name")
            or shipping_address.get("pickupRecipientName")
            or shipping_address.get("pickup_recipient_name")
            or shipping_address.get("fullName")
            or shipping_address.get("name")
        )
        submitted_pickup_recipient_name = _normalize_address_field(facility_pickup_recipient_name)
        actor_name = _normalize_address_field(user.get("name") if isinstance(user, dict) else None)
        if (
            submitted_pickup_recipient_name
            and address_pickup_recipient_name
            and actor_name
            and submitted_pickup_recipient_name.lower() == actor_name.lower()
            and address_pickup_recipient_name.lower() != submitted_pickup_recipient_name.lower()
        ):
            submitted_pickup_recipient_name = address_pickup_recipient_name
        resolved_pickup_recipient_name = submitted_pickup_recipient_name or address_pickup_recipient_name
        if (
            not resolved_pickup_recipient_name
            or _is_facility_pickup_recipient_placeholder(resolved_pickup_recipient_name)
        ):
            raise _service_error("Facility pickup recipient name is required", 400)
        logger.info(
            "[checkout] facility pickup service recipient submitted=%r address=%r actor=%r resolved=%r shipping_name=%r",
            submitted_pickup_recipient_name,
            address_pickup_recipient_name,
            actor_name,
            resolved_pickup_recipient_name,
            shipping_address.get("name") if isinstance(shipping_address, dict) else None,
        )
        shipping_address = _build_facility_pickup_shipping_address(
            user,
            shipping_address,
            recipient_name=resolved_pickup_recipient_name,
        )
        billing_address = dict(shipping_address)
        existing_rate = shipping_rate if isinstance(shipping_rate, dict) else {}
        shipping_rate = {
            **existing_rate,
            "carrierId": FACILITY_PICKUP_SERVICE_CODE,
            "serviceType": FACILITY_PICKUP_LABEL,
            "serviceCode": FACILITY_PICKUP_SERVICE_CODE,
            "rate": 0,
        }
        expected_shipment_window = None
    elif is_hand_delivery:
        existing_rate = shipping_rate if isinstance(shipping_rate, dict) else {}
        shipping_rate = {
            **existing_rate,
            "carrierId": HAND_DELIVERY_SERVICE_CODE,
            "serviceType": HAND_DELIVERY_LABEL,
            "serviceCode": HAND_DELIVERY_SERVICE_CODE,
            "rate": 0,
        }
        expected_shipment_window = None
    try:
        shipping_total_value = float(shipping_total or 0)
    except Exception:
        shipping_total_value = 0.0
    shipping_total_value = 0.0 if bypass_shipping else max(0.0, shipping_total_value)
    if tax_exempt:
        tax_total_value = 0.0
    else:
        tax_total_value, _tax_source, _state_profile = _calculate_checkout_tax(
            items_subtotal=float(items_subtotal),
            shipping_total=float(shipping_total_value),
            shipping_address=shipping_address,
        )

    settings = settings_service.get_settings()
    role = _normalize_role(user.get("role"))
    sales_actor_rep_record = (
        _resolve_sales_rep_record_for_user(user) if _is_sales_access_role(role) and role != "admin" else None
    )
    sales_actor_can_use_retail = bool(
        role == "admin"
        or _normalize_bool(
            (sales_actor_rep_record or {}).get("allowedRetail")
            if isinstance(sales_actor_rep_record, dict)
            else False
        )
    )

    normalized_pricing_mode = str(pricing_mode or "").strip().lower()
    if normalized_pricing_mode not in ("retail", "wholesale"):
        normalized_pricing_mode = "wholesale"
    if not _is_sales_access_role(role):
        normalized_pricing_mode = "wholesale"
    elif normalized_pricing_mode == "retail" and not sales_actor_can_use_retail:
        normalized_pricing_mode = "wholesale"

    test_override_enabled = bool(settings.get("testPaymentsOverrideEnabled", False))
    test_override_allowed = role in ("admin", "test_doctor")
    test_override_payment = normalized_payment_method == "bacs"
    test_override = bool(test_override_enabled and test_override_allowed and test_override_payment)

    if not bypass_shipping:
        address_updates = _extract_user_address_fields(shipping_address)
        if any(address_updates.values()):
            updated_user = user_repository.update({**user, **address_updates})
            if updated_user:
                user = updated_user

    normalized_referral = (referral_code or "").strip().upper() or None
    if test_override:
        normalized_referral = None
    referral_effects: Dict = {}
    normalized_discount_code = (discount_code or "").strip().upper() or None
    order_actor_name = (
        _normalize_address_field(user.get("name") if isinstance(user, dict) else None)
        or _normalize_address_field(user.get("email") if isinstance(user, dict) else None)
    )
    order_pickup_recipient_name = (
        _normalize_address_field(
            shipping_address.get("recipientName")
            or shipping_address.get("recipient_name")
            or shipping_address.get("orderRecipientName")
            or shipping_address.get("order_recipient_name")
            or shipping_address.get("pickupRecipientName")
            or shipping_address.get("pickup_recipient_name")
            or shipping_address.get("fullName")
            or shipping_address.get("name")
        )
        if is_facility_pickup and isinstance(shipping_address, dict)
        else None
    )
    order = {
        "id": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
        "userId": user_id,
        "asDelegate": (str(as_delegate_label).strip() if isinstance(as_delegate_label, str) and str(as_delegate_label).strip() else None),
        "items": items,
        "pricingMode": normalized_pricing_mode,
        # `total` is the items subtotal; shipping/tax are tracked separately.
        "total": float(items_subtotal),
        "itemsSubtotal": float(items_subtotal),
        "shippingTotal": float(shipping_total_value),
        "taxTotal": float(tax_total_value),
        "shippingEstimate": shipping_rate or {},
        "shippingAddress": shipping_address or {},
        "billingAddress": billing_address,
        "facilityPickupRecipientName": order_pickup_recipient_name,
        "facility_pickup_recipient_name": order_pickup_recipient_name,
        "pickupRecipientName": order_pickup_recipient_name,
        "pickup_recipient_name": order_pickup_recipient_name,
        "recipientName": order_pickup_recipient_name if is_facility_pickup else None,
        "recipient_name": order_pickup_recipient_name if is_facility_pickup else None,
        "orderRecipientName": order_pickup_recipient_name if is_facility_pickup else None,
        "order_recipient_name": order_pickup_recipient_name if is_facility_pickup else None,
        "customerName": order_actor_name if is_facility_pickup else None,
        "customer_name": order_actor_name if is_facility_pickup else None,
        "doctorName": order_actor_name if is_facility_pickup else None,
        "doctor_name": order_actor_name if is_facility_pickup else None,
        "handDelivery": is_hand_delivery,
        "facilityPickup": is_facility_pickup,
        "facility_pickup": is_facility_pickup,
        "fascility_pickup": is_facility_pickup,
        "fulfillmentMethod": "facility_pickup" if is_facility_pickup else ("hand_delivered" if is_hand_delivery else "shipping"),
        "pickupLocation": FACILITY_PICKUP_LOCATION if is_facility_pickup else None,
        "pickupReadyNotice": FACILITY_PICKUP_NOTICE if is_facility_pickup else None,
        "referralCode": normalized_referral,
        "discountCode": normalized_discount_code,
        "status": "pending",
        "createdAt": now,
        "updatedAt": now,
        "expectedShipmentWindow": (expected_shipment_window or None),
        "physicianCertificationAccepted": bool(physician_certified),
        "paymentMethod": normalized_payment_method,
        "paymentDetails": raw_payment_method if normalized_payment_method == "bacs" else None,
        "doctorSalesRepId": sales_rep_ctx.get("id"),
        "doctorSalesRepName": sales_rep_ctx.get("name"),
        "doctorSalesRepEmail": sales_rep_ctx.get("email"),
        "doctorSalesRepCode": sales_rep_ctx.get("salesCode"),
        **order_exemption_snapshot,
    }

    should_record_discount_code_use = False

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
        discount_code_amount = 0.0
        order["originalItemsSubtotal"] = float(items_subtotal)
        cart_quantity = _sum_cart_quantity(items)
        if normalized_discount_code:
            applied = discount_code_service.apply_discount_to_subtotal(
                user_id=user_id,
                user_role=role,
                code=normalized_discount_code,
                items_subtotal=items_subtotal,
                cart_quantity=cart_quantity,
            )
            discount_code_amount = float(applied.get("discountAmount") or 0.0)
            order["discountCode"] = applied.get("code") or normalized_discount_code
            order["discountCodeValue"] = float(applied.get("discountValue") or 0.0)
            order["discountCodeAmount"] = round(max(0.0, discount_code_amount), 2)
            order["discountCodeSingleUsePerUser"] = bool(applied.get("singleUsePerUser", True))
            if isinstance(applied.get("pricingOverride"), dict):
                order["discountCodePricingOverride"] = applied.get("pricingOverride")

        effective_items_subtotal = max(0.0, float(items_subtotal) - max(0.0, discount_code_amount))
        # Persist the discounted subtotal as the new items subtotal.
        order["total"] = float(effective_items_subtotal)
        order["itemsSubtotal"] = float(effective_items_subtotal)

        # Recompute taxes based on discounted subtotal (where applicable).
        tax_total_value_effective = 0.0
        if tax_exempt:
            tax_total_value_effective = 0.0
        else:
            tax_total_value_effective, _tax_source, _state_profile = _calculate_checkout_tax(
                items_subtotal=float(effective_items_subtotal),
                shipping_total=float(shipping_total_value),
                shipping_address=shipping_address,
            )
        order["taxTotal"] = float(tax_total_value_effective)
        tax_total_value = float(tax_total_value_effective)

        # Auto-apply available referral credits to this order
        available_credit = float(user.get("referralCredits") or 0)
        if available_credit > 0 and effective_items_subtotal > 0:
            applied = min(available_credit, effective_items_subtotal)
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
        order["discountTotal"] = round(
            max(0.0, float(discount_code_amount or 0.0) + float(applied_credit_value or 0.0)),
            2,
        )
        order["grandTotal"] = round(
            max(
                0.0,
                effective_items_subtotal - applied_credit_value
                + shipping_total_value
                + tax_total_value,
            ),
            2,
        )
        should_record_discount_code_use = bool(order.get("discountCode"))

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
    except Exception as exc:  # pragma: no cover - network error path
        logger.error("WooCommerce integration failed", exc_info=True, extra={"orderId": order["id"]})
        err = _service_error("Unable to submit order right now. Please try again soon.", 503)
        setattr(err, "error_code", "WOO_ORDER_CREATE_FAILED")
        raise err from exc

    order_repository.insert(order)
    try:
        sales_prospect_repository.mark_doctor_as_nurturing_if_purchased(user_id)
    except Exception:
        pass

    if integrations.get("wooCommerce", {}).get("status") == "success":
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
                f"[checkout] woo linked order_id={order.get('id')} woo_id={order.get('wooOrderId')} woo_number={order.get('wooOrderNumber')} sales_rep_id={order.get('doctorSalesRepId')} facility_pickup={order.get('facilityPickup')} recipient={order.get('facilityPickupRecipientName')} shipping_name={(order.get('shippingAddress') or {}).get('name') if isinstance(order.get('shippingAddress'), dict) else None} billing_name={(order.get('billingAddress') or {}).get('name') if isinstance(order.get('billingAddress'), dict) else None}",
                flush=True,
            )
        except Exception:
            pass

        if should_record_discount_code_use:
            try:
                cart_quantity = _sum_cart_quantity(order.get("items"))
                discount_code_repository.reserve_use_once(
                    code=str(order.get("discountCode") or ""),
                    user_id=user_id,
                    user_name=str(user.get("name") or "").strip() or None,
                    order_id=str(order.get("wooOrderNumber") or order.get("wooOrderId") or "").strip() or None,
                    enforce_single_use=bool(order.get("discountCodeSingleUsePerUser", True)),
                    items_subtotal=float(order.get("originalItemsSubtotal") or 0.0),
                    quantity=cart_quantity,
                )
            except Exception:
                logger.error("Failed to record discount code usage", exc_info=True, extra={"orderId": order.get("id")})

        # Only deduct referral credit after Woo accepted the order.
        if order.get("appliedReferralCredit"):
            try:
                referral_service.apply_referral_credit(user_id, float(order["appliedReferralCredit"]), order["id"])
            except Exception:
                logger.error("Failed to apply referral credit", exc_info=True, extra={"orderId": order["id"]})

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
            local_order["updatedAt"] = _now_order_iso()
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

    # Enforce strict cancellation rules: only pending or on-hold.
    # Prefer WooCommerce status (source of truth); fall back to local overlay status when Woo is unavailable.
    def _normalize_status(value: object) -> str:
        return str(value or "").strip().lower().replace("_", "-")

    cancellable_statuses = {"pending", "on-hold"}
    woo_status = _normalize_status(woo_order.get("status") if isinstance(woo_order, dict) else None)
    local_status = _normalize_status(local_order.get("status") if isinstance(local_order, dict) else None)
    effective_status = woo_status or local_status
    if effective_status and effective_status not in cancellable_statuses:
        raise _service_error("This order can no longer be cancelled", 400)

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

    def _is_delegation_draft(order: object) -> bool:
        return isinstance(order, dict) and str(order.get("status") or "").strip().lower() == "delegation_draft"

    local_orders = []

    try:
        # Avoid pulling large payload columns; only load fields needed to overlay UI.
        local_orders = order_repository.list_user_overlay_fields(user_id) or []
        local_orders = [order for order in local_orders if not _is_delegation_draft(order)]
    except Exception:
        local_orders = []

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
                "asDelegate": (
                    local.get("asDelegate")
                    if local.get("asDelegate") is not None
                    else local.get("as_delegate")
                ),
                "as_delegate": (
                    local.get("as_delegate")
                    if local.get("as_delegate") is not None
                    else local.get("asDelegate")
                ),
                "number": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "status": local.get("status") or "pending",
                # For UI display, expose `grandTotal` so the order card "Total" is correct.
                # Keep `total` for backward compatibility, but prefer `grandTotal` when present.
                "total": float(local.get("grandTotal") or local.get("total") or 0),
                "grandTotal": float(local.get("grandTotal") or 0),
                "itemsSubtotal": float(local.get("itemsSubtotal") or local.get("total") or 0),
                "originalItemsSubtotal": float(local.get("originalItemsSubtotal") or 0),
                "taxTotal": float(local.get("taxTotal") or 0),
                "appliedReferralCredit": float(local.get("appliedReferralCredit") or 0),
                "discountCode": local.get("discountCode") or None,
                "discountCodeAmount": float(local.get("discountCodeAmount") or 0),
                "shippingTotal": float(local.get("shippingTotal") or 0),
                "currency": local.get("currency") or "USD",
                "notes": local.get("notes") if local.get("notes") is not None else None,
                "createdAt": local.get("createdAt") or None,
                "updatedAt": local.get("updatedAt") or None,
                "shippingAddress": local.get("shippingAddress") or None,
                "billingAddress": local.get("billingAddress") or None,
                "shippingEstimate": local.get("shippingEstimate") or None,
                "expectedShipmentWindow": local.get("expectedShipmentWindow") or None,
                "shippingCarrier": local.get("shippingCarrier") or None,
                "shippingService": local.get("shippingService") or None,
                "trackingNumber": local.get("trackingNumber") or None,
                "upsTrackingStatus": local.get("upsTrackingStatus") or None,
                "deliveryDate": local.get("deliveryDate") or None,
                "upsDeliveredAt": local.get("upsDeliveredAt") or None,
                "paymentMethod": local.get("paymentMethod") or None,
                "paymentDetails": local.get("paymentDetails") or local.get("paymentMethod") or None,
                "integrationDetails": local.get("integrationDetails") or None,
                "lineItems": local.get("items") or [],
                "source": "peppro",
            }
        )

    if force and local_summaries:
        t0 = time.perf_counter()
        for local_summary in local_summaries:
            _enrich_with_shipstation(local_summary)
        _perf_log(
            f"ship_station.enrich_orders userId={user_id} count={len(local_summaries)}",
            duration_ms=(time.perf_counter() - t0) * 1000,
            threshold_ms=250.0,
        )

    try:
        sample = local_summaries[0] if local_summaries else {}
        logger.info(
            "[Orders] User response snapshot userId=%s localCount=%s sampleId=%s sampleTracking=%s shipStationStatus=%s",
            user_id,
            len(local_summaries),
            sample.get("id") or sample.get("number") or sample.get("wooOrderNumber"),
            sample.get("trackingNumber")
            or _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("trackingNumber"),
            _ensure_dict(sample.get("integrationDetails") or {}).get("shipStation", {}).get("status"),
        )
    except Exception:
        pass

    return {
        "local": local_summaries,
        "woo": [],
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "wooError": None,
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

        delegate_label = (
            local_order.get("asDelegate")
            if local_order.get("asDelegate") is not None
            else local_order.get("as_delegate")
        )
        if delegate_label is not None:
            order["asDelegate"] = delegate_label
            order["as_delegate"] = delegate_label

        local_tracking_number = _normalize_optional_text(local_order.get("trackingNumber"))
        if local_tracking_number is not None:
            order["trackingNumber"] = local_tracking_number
        if local_order.get("upsTrackingStatus") is not None:
            order["upsTrackingStatus"] = local_order.get("upsTrackingStatus")
        if local_order.get("deliveryDate") is not None:
            order["deliveryDate"] = local_order.get("deliveryDate")
        if local_order.get("upsDeliveredAt") is not None:
            order["upsDeliveredAt"] = local_order.get("upsDeliveredAt")

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

        # Merge local totals/discount metadata so the UI doesn't fall back to summing
        # raw line items (which may be pre-discount).
        for key in (
            "itemsSubtotal",
            "originalItemsSubtotal",
            "taxTotal",
            "grandTotal",
            "appliedReferralCredit",
            "discountCode",
            "discountCodeAmount",
        ):
            if local_order.get(key) is not None:
                order[key] = local_order.get(key)

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
        _apply_authoritative_ups_tracking_status(order)

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
    actor_role = _normalize_role(actor.get("role"))
    if actor_role not in ("admin", "sales_rep", "sales_partner", "rep"):
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

    updated = {**local_order, "notes": text, "updatedAt": _now_order_iso()}
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
    actor_role = _normalize_role(actor.get("role"))
    if actor_role not in ("admin", "sales_rep", "sales_partner", "rep"):
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

    updated["updatedAt"] = _now_order_iso()
    saved = order_repository.update(updated) or updated
    return {"order": saved}


def get_orders_for_sales_rep(
    sales_rep_id: Optional[str],
    include_doctors: bool = False,
    force: bool = False,
    include_all_doctors: bool = False,
    include_house_contacts: bool = False,
    local_only: bool = False,
):
    normalized_sales_rep_id = str(sales_rep_id or "").strip()
    def _normalize_lead_type(value: object) -> str:
        return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")

    scope_key = "all" if include_all_doctors else "mine"
    logger.info(
        "[SalesRep] Fetch start salesRepId=%s scope=%s includeDoctors=%s",
        normalized_sales_rep_id or "ALL",
        scope_key,
        include_doctors,
    )
    cache_key = f"{normalized_sales_rep_id or 'ALL'}::{scope_key}::{'withDoctors' if include_doctors else 'ordersOnly'}::sqlOnly"
    now = time.time()
    if not force and _SALES_REP_ORDERS_TTL_SECONDS > 0:
        with _sales_rep_orders_cache_lock:
            cached = _sales_rep_orders_cache.get(cache_key)
            if cached and float(cached.get("expiresAt") or 0) > now:
                logger.info(
                    "[SalesRep] Cache hit salesRepId=%s ttlSeconds=%s",
                    normalized_sales_rep_id or "ALL",
                    _SALES_REP_ORDERS_TTL_SECONDS,
                )
                return cached.get("value")
    use_local_sql_path = bool(local_only)
    use_admin_local_fast_path = bool(
        use_local_sql_path and include_all_doctors and not normalized_sales_rep_id
    )
    users = (
        user_repository.list_sales_tracking_users_for_admin()
        if use_local_sql_path
        else user_repository.get_all()
    )
    user_by_id = {str(u.get("id")): u for u in users if isinstance(u, dict) and u.get("id") is not None}
    rep_records = {str(rep.get("id")): rep for rep in sales_rep_repository.get_all() if rep.get("id")}
    allowed_rep_ids = (
        _compute_allowed_sales_rep_ids(normalized_sales_rep_id, users, rep_records)
        if normalized_sales_rep_id
        else set()
    )
    include_sales_rep_customers = include_all_doctors and not allowed_rep_ids

    doctors = []
    for user in users:
        role = _normalize_role(user.get("role"))
        is_doctor = role in ("doctor", "test_doctor")
        is_sales_rep_customer = include_sales_rep_customers and role in ("sales_rep", "sales_partner", "rep")
        lead_type = _normalize_lead_type(user.get("leadType") or user.get("lead_type"))
        is_house_contact_user = include_house_contacts and lead_type in (
            "contact_form",
            "house",
            "house_contact",
        )
        doctor_sales_rep = str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
        if is_house_contact_user:
            doctors.append(user)
            continue
        if not is_doctor and not is_sales_rep_customer:
            continue
        if include_all_doctors:
            if allowed_rep_ids and doctor_sales_rep not in allowed_rep_ids:
                continue
        else:
            if doctor_sales_rep not in allowed_rep_ids:
                continue
        doctors.append(user)

    # Ensure doctors have a stable lead type stored for commission tracking.
    if not use_local_sql_path:
        try:
            doctor_only = [d for d in doctors if (d.get("role") or "").lower() in ("doctor", "test_doctor")]
            backfilled = referral_service.backfill_lead_types_for_doctors(doctor_only)
            if isinstance(backfilled, list) and backfilled:
                backfilled_by_id = {str(d.get("id")): d for d in backfilled if isinstance(d, dict) and d.get("id") is not None}
                merged: List[Dict] = []
                for entry in doctors:
                    entry_id = str(entry.get("id")) if isinstance(entry, dict) else ""
                    merged.append(backfilled_by_id.get(entry_id) or entry)
                doctors = merged
        except Exception:
            pass

    doctor_lookup = {
        str(doc.get("id")): {
            "id": doc.get("id"),
            "name": doc.get("name") or doc.get("email") or "Doctor",
            "email": doc.get("email"),
            "phone": doc.get("phone"),
            "profileImageUrl": doc.get("profileImageUrl"),
            "salesRepId": str(doc.get("salesRepId") or doc.get("sales_rep_id") or "").strip() or None,
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

    if use_local_sql_path and include_house_contacts:
        try:
            seen_house_ids = set(doctor_lookup.keys())
            for house_user in _list_house_lead_users_for_sales_tracking():
                house_id = str(house_user.get("id") or "").strip()
                if not house_id:
                    continue
                existing = doctor_lookup.get(house_id) or {}
                merged = {
                    "id": house_id,
                    "name": existing.get("name") or house_user.get("name") or house_user.get("email") or "House / Contact Form",
                    "email": existing.get("email") or house_user.get("email"),
                    "phone": existing.get("phone") or house_user.get("phone"),
                    "profileImageUrl": existing.get("profileImageUrl") or house_user.get("profileImageUrl"),
                    "salesRepId": existing.get("salesRepId") or house_user.get("salesRepId"),
                    "leadType": existing.get("leadType") or house_user.get("leadType") or "house",
                    "leadTypeSource": existing.get("leadTypeSource") or house_user.get("leadTypeSource") or "users.lead_type",
                    "leadTypeLockedAt": existing.get("leadTypeLockedAt") or house_user.get("leadTypeLockedAt"),
                    "address1": existing.get("address1") or house_user.get("officeAddressLine1"),
                    "address2": existing.get("address2") or house_user.get("officeAddressLine2"),
                    "city": existing.get("city") or house_user.get("officeCity"),
                    "state": existing.get("state") or house_user.get("officeState"),
                    "postalCode": existing.get("postalCode") or house_user.get("officePostalCode"),
                    "country": existing.get("country") or house_user.get("officeCountry"),
                }
                doctor_lookup[house_id] = merged
                user_by_id.setdefault(house_id, house_user)
                if house_id not in seen_house_ids:
                    doctors.append(house_user)
                    seen_house_ids.add(house_id)
        except Exception:
            logger.warning("[SalesRep] Failed to merge house users into admin fast path", exc_info=True)

    # Include contact-form prospects so reps/admins can see lead activity, and so order attribution by
    # billing email can match house leads even when no doctor user exists yet.
    if use_local_sql_path:
        prospects = []
    else:
        try:
            prospects = sales_prospect_repository.get_all()
        except Exception:
            prospects = []

    if isinstance(prospects, list) and prospects:
        house_sales_rep_id = None
        if include_house_contacts:
            try:
                from ..repositories.sales_prospect_repository import HOUSE_SALES_REP_ID

                house_sales_rep_id = str(HOUSE_SALES_REP_ID or "").strip() or None
            except Exception:
                house_sales_rep_id = None
        seen_doctor_ids = set(doctor_lookup.keys())
        for prospect in prospects:
            if not isinstance(prospect, dict):
                continue
            email = _normalize_email(prospect.get("contactEmail"))
            if not email:
                continue

            # Determine a stable id for the lead.
            contact_form_id = str(prospect.get("contactFormId") or "").strip()
            prospect_id = str(prospect.get("id") or "").strip()
            doctor_id = str(prospect.get("doctorId") or "").strip()
            if doctor_id:
                lead_id = doctor_id
            elif contact_form_id:
                lead_id = f"contact_form:{contact_form_id}"
            elif prospect_id.startswith("contact_form:"):
                lead_id = prospect_id
            else:
                continue

            prospect_sales_rep_id = str(prospect.get("salesRepId") or prospect.get("sales_rep_id") or "").strip()
            is_house_contact = bool(house_sales_rep_id) and prospect_sales_rep_id == house_sales_rep_id
            if include_all_doctors:
                if allowed_rep_ids and prospect_sales_rep_id not in allowed_rep_ids:
                    continue
            else:
                if not is_house_contact and allowed_rep_ids and prospect_sales_rep_id not in allowed_rep_ids:
                    continue

            existing = doctor_lookup.get(lead_id) or {}
            lead_meta = {
                "id": lead_id,
                "name": prospect.get("contactName") or email or "House / Contact Form",
                "email": email,
                "phone": prospect.get("contactPhone") or None,
                "profileImageUrl": None,
                "salesRepId": prospect_sales_rep_id or None,
                "leadType": "contact_form",
                "leadTypeSource": "contact_form",
                "leadTypeLockedAt": prospect.get("updatedAt") or prospect.get("createdAt") or None,
                "address1": prospect.get("officeAddressLine1"),
                "address2": prospect.get("officeAddressLine2"),
                "city": prospect.get("officeCity"),
                "state": prospect.get("officeState"),
                "postalCode": prospect.get("officePostalCode"),
                "country": prospect.get("officeCountry"),
            }

            if existing:
                doctor_lookup[lead_id] = {
                    **lead_meta,
                    **existing,
                    "id": lead_id,
                    "name": existing.get("name") or lead_meta["name"],
                    "email": existing.get("email") or lead_meta["email"],
                    "profileImageUrl": existing.get("profileImageUrl") or lead_meta["profileImageUrl"],
                }
            else:
                doctor_lookup[lead_id] = lead_meta

            if lead_id not in seen_doctor_ids:
                doctors.append(
                    {
                        "id": lead_id,
                        "name": lead_meta.get("name"),
                        "email": lead_meta.get("email"),
                        "phone": lead_meta.get("phone"),
                        "leadType": lead_meta.get("leadType"),
                        "leadTypeSource": lead_meta.get("leadTypeSource"),
                        "leadTypeLockedAt": lead_meta.get("leadTypeLockedAt"),
                        "salesRepId": lead_meta.get("salesRepId"),
                    }
                )
                seen_doctor_ids.add(lead_id)

    # Overlay sales rep details from `sales_rep` / `sales_reps` table for UI display.
    for doctor_meta in doctor_lookup.values():
        rep_id = str(doctor_meta.get("salesRepId") or "").strip()
        rep = rep_records.get(rep_id) if rep_id else None
        doctor_meta["salesRepName"] = rep.get("name") if isinstance(rep, dict) else None
        doctor_meta["salesRepEmail"] = rep.get("email") if isinstance(rep, dict) else None

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
        if use_local_sql_path:
            local_orders = order_repository.find_sales_tracking_by_user_ids(doctor_ids) if doctor_ids else []
        else:
            local_orders = order_repository.find_by_user_ids(doctor_ids) if doctor_ids else []
    except Exception:
        local_orders = []

    # Merge a recent sales-tracking scan so rep-attributed orders are still included even when the
    # doctor user record is missing or stale. This is especially important for on-hold orders that
    # may be keyed by order metadata before user-to-rep assignment catches up.
    if not use_local_sql_path:
        try:
            fallback_orders = order_repository.list_recent_sales_tracking(750)
        except Exception:
            fallback_orders = []
        if fallback_orders:
            existing_order_ids = {
                str(order.get("id") or "").strip()
                for order in local_orders
                if isinstance(order, dict) and str(order.get("id") or "").strip()
            }
            for fallback_order in fallback_orders:
                if not isinstance(fallback_order, dict):
                    continue
                fallback_order_id = str(fallback_order.get("id") or "").strip()
                if fallback_order_id and fallback_order_id in existing_order_ids:
                    continue
                local_orders.append(fallback_order)
                if fallback_order_id:
                    existing_order_ids.add(fallback_order_id)

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
        local_lead_type = _normalize_lead_type(
            (local_user or {}).get("leadType") or (local_user or {}).get("lead_type")
        )
        local_is_house_contact = include_house_contacts and local_lead_type in (
            "contact_form",
            "house",
            "house_contact",
        )
        if local_role:
            if local_is_house_contact:
                pass
            elif local_role in ("doctor", "test_doctor"):
                pass
            elif include_sales_rep_customers and _is_sales_rep_role(local_role):
                pass
            else:
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
        if allowed_rep_ids:
            if not (
                (rep_from_order and rep_from_order in allowed_rep_ids)
                or (rep_from_user and rep_from_user in allowed_rep_ids)
                or local_is_house_contact
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

    logger.info(
        "[SalesRep] Doctor list computed salesRepId=%s doctorCount=%s sqlOnly=%s doctorEmails=%s",
        normalized_sales_rep_id or "ALL",
        len(doctors),
        True,
        [d.get("email") for d in doctors],
    )
    if local_by_id:
        for local in local_by_id.values():
            local_user_id = str(local.get("userId") or local.get("user_id") or "").strip()
            doctor_meta = doctor_lookup.get(local_user_id) or {}
            key = f"local:{local.get('id')}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            local_tracking_number = _extract_tracking_number_for_ups_refresh(local)
            local_rep_id = _normalize_rep_id(
                local.get("doctorSalesRepId")
                or local.get("salesRepId")
                or local.get("sales_rep_id")
                or local.get("doctor_sales_rep_id")
                or doctor_meta.get("salesRepId")
            )
            local_rep = rep_records.get(local_rep_id) if local_rep_id else None
            summary = {
                "id": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "wooOrderId": local.get("wooOrderId") or None,
                "wooOrderNumber": local.get("wooOrderNumber") or None,
                "number": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "pricingMode": local.get("pricingMode") or local.get("pricing_mode") or "wholesale",
                "pricing_mode": local.get("pricing_mode") or local.get("pricingMode") or "wholesale",
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
                "trackingNumber": local_tracking_number,
                "lineItems": local.get("items") or [],
                "doctorId": doctor_meta.get("id") or local_user_id or None,
                "doctorName": doctor_meta.get("name") or doctor_meta.get("email") or "Doctor",
                "doctorEmail": doctor_meta.get("email") or None,
                "doctorSalesRepId": local_rep_id or None,
                "doctorSalesRepName": (local_rep.get("name") if isinstance(local_rep, dict) else None)
                or doctor_meta.get("salesRepName"),
                "doctorSalesRepEmail": (local_rep.get("email") if isinstance(local_rep, dict) else None)
                or doctor_meta.get("salesRepEmail"),
                "userId": doctor_meta.get("id") or local_user_id or None,
                "source": "peppro",
            }
            if force:
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
        normalized_sales_rep_id or "ALL",
        len(doctors),
        len(summaries),
        [o.get("id") or o.get("number") for o in summaries[:5]],
    )

    try:
        sample = summaries[0] if summaries else {}
        logger.info(
            "[SalesRep] Response snapshot salesRepId=%s orderCount=%s sampleId=%s sampleTracking=%s shipStationStatus=%s",
            normalized_sales_rep_id or "ALL",
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


def get_on_hold_orders_for_sales_rep(
    sales_rep_id: Optional[str],
    *,
    include_all_doctors: bool = False,
    include_house_contacts: bool = False,
    limit: int = 500,
) -> Dict[str, object]:
    normalized_sales_rep_id = str(sales_rep_id or "").strip()
    try:
        effective_limit = int(limit)
    except Exception:
        effective_limit = 500
    effective_limit = max(1, min(effective_limit, 5000))
    scan_limit = max(effective_limit * 4, 1500)
    scan_limit = min(scan_limit, 10000)

    users = user_repository.get_all()
    user_by_id = {
        str(user.get("id")): user
        for user in users
        if isinstance(user, dict) and user.get("id") is not None
    }
    rep_records = {str(rep.get("id")): rep for rep in sales_rep_repository.get_all() if rep.get("id")}
    allowed_rep_ids = (
        _compute_allowed_sales_rep_ids(normalized_sales_rep_id, users, rep_records)
        if normalized_sales_rep_id
        else set()
    )

    def _normalize_status(value: object) -> str:
        return str(value or "").strip().lower().replace("_", "-")

    def _normalize_rep_id(value: object) -> str:
        return str(value or "").strip()

    def _normalize_lead_type(value: object) -> str:
        return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")

    def _as_dict(value: object) -> Dict:
        return value if isinstance(value, dict) else {}

    def _first_text(*values: object) -> Optional[str]:
        for value in values:
            text = str(value or "").strip()
            if text:
                return text
        return None
        return None

    def _combined_name(first_name: object, last_name: object) -> Optional[str]:
        first = str(first_name or "").strip()
        last = str(last_name or "").strip()
        full = f"{first} {last}".strip()
        return full or None

    local_orders = order_repository.list_recent_sales_tracking(scan_limit) or []
    summaries: List[Dict] = []
    for local in local_orders:
        if not isinstance(local, dict):
            continue
        if _normalize_status(local.get("status")) not in ("on-hold", "onhold"):
            continue

        local_user_id = str(local.get("userId") or local.get("user_id") or "").strip()
        doctor = user_by_id.get(local_user_id) or {}
        doctor_lead_type = _normalize_lead_type(
            doctor.get("leadType") or doctor.get("lead_type"),
        )
        doctor_is_house_contact = include_house_contacts and doctor_lead_type in (
            "contact_form",
            "house",
            "house_contact",
        )
        rep_from_order = _normalize_rep_id(
            local.get("doctorSalesRepId")
            or local.get("salesRepId")
            or local.get("sales_rep_id")
            or local.get("doctor_sales_rep_id")
        )
        rep_from_user = _normalize_rep_id(
            doctor.get("salesRepId") or doctor.get("sales_rep_id"),
        )

        if include_all_doctors:
            if allowed_rep_ids and not (
                (rep_from_order and rep_from_order in allowed_rep_ids)
                or (rep_from_user and rep_from_user in allowed_rep_ids)
                or doctor_is_house_contact
            ):
                continue
        elif allowed_rep_ids and not (
            (rep_from_order and rep_from_order in allowed_rep_ids)
            or (rep_from_user and rep_from_user in allowed_rep_ids)
            or doctor_is_house_contact
        ):
            continue

        shipping = _as_dict(local.get("shippingAddress") or local.get("shipping_address"))
        billing = _as_dict(local.get("billingAddress") or local.get("billing_address"))
        customer = _as_dict(local.get("customer"))
        shipping_name = _combined_name(
            shipping.get("firstName") or shipping.get("first_name"),
            shipping.get("lastName") or shipping.get("last_name"),
        ) or _first_text(shipping.get("name"), shipping.get("company"))
        billing_name = _combined_name(
            billing.get("firstName") or billing.get("first_name"),
            billing.get("lastName") or billing.get("last_name"),
        ) or _first_text(billing.get("name"), billing.get("company"))
        is_facility_pickup = bool(
            local.get("facilityPickup")
            or local.get("facility_pickup")
            or local.get("fascility_pickup")
            or str(local.get("fulfillmentMethod") or local.get("fulfillment_method") or "").strip().lower()
            in ("facility_pickup", "fascility_pickup")
        )
        facility_pickup_recipient_name = _first_text(
            shipping.get("recipientName"),
            shipping.get("recipient_name"),
            shipping.get("orderRecipientName"),
            shipping.get("order_recipient_name"),
            shipping.get("pickupRecipientName"),
            shipping.get("pickup_recipient_name"),
            shipping.get("fullName"),
            shipping.get("name"),
            billing.get("recipientName"),
            billing.get("recipient_name"),
            billing.get("orderRecipientName"),
            billing.get("order_recipient_name"),
            billing.get("pickupRecipientName"),
            billing.get("pickup_recipient_name"),
            billing.get("fullName"),
            billing.get("name"),
            local.get("facilityPickupRecipientName"),
            local.get("facility_pickup_recipient_name"),
            local.get("pickupRecipientName"),
            local.get("pickup_recipient_name"),
            local.get("recipientName"),
            local.get("recipient_name"),
            local.get("orderRecipientName"),
            local.get("order_recipient_name"),
            shipping_name,
            billing_name,
        )
        doctor_email = _first_text(
            doctor.get("email"),
            local.get("doctorEmail"),
            local.get("doctor_email"),
            local.get("email"),
            customer.get("email"),
            billing.get("email"),
            shipping.get("email"),
        )
        doctor_name = _first_text(
            doctor.get("name"),
            local.get("doctorName"),
            local.get("doctor_name"),
            customer.get("name"),
            shipping_name,
            billing_name,
            doctor_email,
        ) or "Unknown doctor"
        rep_id = rep_from_order or rep_from_user or None
        rep_record = rep_records.get(rep_id) if rep_id else None
        summaries.append(
            {
                "id": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "wooOrderId": local.get("wooOrderId") or local.get("woo_order_id") or None,
                "wooOrderNumber": local.get("wooOrderNumber") or local.get("woo_order_number") or None,
                "number": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "status": local.get("status") or "on-hold",
                "total": float(local.get("grandTotal") or local.get("total") or 0),
                "grandTotal": float(local.get("grandTotal") or local.get("total") or 0),
                "taxTotal": float(local.get("taxTotal") or 0),
                "shippingTotal": float(local.get("shippingTotal") or 0),
                "currency": local.get("currency") or "USD",
                "createdAt": local.get("createdAt") or local.get("dateCreated") or local.get("date_created") or None,
                "updatedAt": local.get("updatedAt") or None,
                "doctorId": doctor.get("id") or local_user_id or None,
                "doctorName": doctor_name,
                "facilityPickupRecipientName": facility_pickup_recipient_name if is_facility_pickup else None,
                "facility_pickup_recipient_name": facility_pickup_recipient_name if is_facility_pickup else None,
                "pickupRecipientName": facility_pickup_recipient_name if is_facility_pickup else None,
                "pickup_recipient_name": facility_pickup_recipient_name if is_facility_pickup else None,
                "recipientName": facility_pickup_recipient_name if is_facility_pickup else None,
                "recipient_name": facility_pickup_recipient_name if is_facility_pickup else None,
                "orderRecipientName": facility_pickup_recipient_name if is_facility_pickup else None,
                "order_recipient_name": facility_pickup_recipient_name if is_facility_pickup else None,
                "customerName": doctor_name if is_facility_pickup else None,
                "customer_name": doctor_name if is_facility_pickup else None,
                "doctorEmail": doctor_email,
                "doctorSalesRepId": rep_id,
                "doctorSalesRepName": rep_record.get("name") if isinstance(rep_record, dict) else None,
                "doctorSalesRepEmail": rep_record.get("email") if isinstance(rep_record, dict) else None,
                "userId": doctor.get("id") or local_user_id or None,
                "lineItems": local.get("items") or [],
                "source": "peppro",
            }
        )

    summaries.sort(
        key=lambda order: str(order.get("createdAt") or order.get("updatedAt") or ""),
        reverse=True,
    )
    return {"orders": summaries[:effective_limit]}


def get_sales_modal_detail(*, actor: Dict, target_user_id: str) -> Dict[str, object]:
    actor_role = _normalize_role((actor or {}).get("role"))
    if not _is_sales_access_role(actor_role):
        raise _service_error("SALES_REP_ACCESS_REQUIRED", 403)

    normalized_target_user_id = str(target_user_id or "").strip()
    if not normalized_target_user_id:
        raise _service_error("USER_ID_REQUIRED", 400)

    users = user_repository.list_sales_modal_lookup_users()
    user_by_id = {
        str(user.get("id")): user
        for user in users
        if isinstance(user, dict) and user.get("id") is not None
    }
    rep_records = {
        str(rep.get("id")): rep
        for rep in sales_rep_repository.get_all()
        if isinstance(rep, dict) and rep.get("id") is not None
    }

    target_user = user_by_id.get(normalized_target_user_id)
    if not isinstance(target_user, dict):
        target_user = next(
            (
                user
                for user in users
                if isinstance(user, dict)
                and str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
                == normalized_target_user_id
            ),
            None,
        )
    if not isinstance(target_user, dict):
        raise _service_error("USER_NOT_FOUND", 404)

    def _is_sales_actor_role(value: object) -> bool:
        return _normalize_role(value) in ("admin", "sales_rep", "sales_partner", "rep", "sales_lead", "saleslead")

    def _resolve_sales_rep_id(user: Dict) -> Optional[str]:
        candidates = [
            user.get("salesRepId"),
            user.get("sales_rep_id"),
            user.get("ownerSalesRepId"),
            user.get("owner_sales_rep_id"),
        ]
        for candidate in candidates:
            normalized = str(candidate or "").strip()
            if normalized:
                return normalized
        user_id = str(user.get("id") or "").strip()
        if user_id:
            allowed = _compute_allowed_sales_rep_ids(user_id, users, rep_records)
            if allowed:
                preferred = next((value for value in allowed if value in rep_records), None)
                return preferred or next(iter(allowed))
        return None

    def _resolve_order_subtotal(order: Dict) -> float:
        candidates = [
            order.get("itemsSubtotal"),
            order.get("items_subtotal"),
            order.get("grandTotal"),
            order.get("grand_total"),
            order.get("total"),
        ]
        for candidate in candidates:
            try:
                value = float(candidate or 0)
            except Exception:
                value = 0.0
            if value > 0:
                return value
        return 0.0

    def _should_count_revenue(status: object) -> bool:
        normalized = str(status or "").strip().lower().replace("_", "-")
        return normalized not in ("cancelled", "canceled", "trash", "refunded", "failed")

    def _order_sort_key(order: Dict) -> str:
        return str(order.get("createdAt") or order.get("updatedAt") or "")

    def _order_identity_key(order: Dict) -> str:
        for candidate in (
            order.get("wooOrderNumber"),
            order.get("woo_order_number"),
            order.get("number"),
            order.get("wooOrderId"),
            order.get("woo_order_id"),
            order.get("id"),
        ):
            normalized = str(candidate or "").strip()
            if normalized:
                return normalized
        return ""

    actor_user_id = str((actor or {}).get("id") or "").strip()
    actor_allowed_rep_ids = (
        _compute_allowed_sales_rep_ids(actor_user_id, users, rep_records)
        if actor_role != "admin" and actor_user_id
        else set()
    )
    target_role = _normalize_role(target_user.get("role"))
    target_is_sales_actor = _is_sales_actor_role(target_role)
    target_sales_rep_id = _resolve_sales_rep_id(target_user)
    target_allowed_rep_ids = (
        _compute_allowed_sales_rep_ids(normalized_target_user_id, users, rep_records)
        if target_is_sales_actor
        else ({target_sales_rep_id} if target_sales_rep_id else set())
    )
    target_sales_rep_record = _resolve_sales_rep_record_for_user(target_user, rep_records)
    if not target_sales_rep_record and target_allowed_rep_ids:
        target_sales_rep_record = next(
            (rep_records.get(rep_id) for rep_id in target_allowed_rep_ids if rep_id in rep_records),
            None,
        )

    summary_only = _is_basic_sales_rep_viewer_role(actor_role) and (
        target_role == "admin" or _is_sales_lead_role(target_role)
    )

    if actor_role != "admin":
        if target_is_sales_actor:
            if (
                normalized_target_user_id != actor_user_id
                and not summary_only
                and actor_allowed_rep_ids.isdisjoint(target_allowed_rep_ids)
            ):
                raise _service_error("USER_NOT_FOUND", 404)
        else:
            if not actor_allowed_rep_ids:
                raise _service_error("USER_NOT_FOUND", 404)
            doctor_rep_id = str(
                target_user.get("salesRepId") or target_user.get("sales_rep_id") or ""
            ).strip()
            if not doctor_rep_id or doctor_rep_id not in actor_allowed_rep_ids:
                raise _service_error("USER_NOT_FOUND", 404)

    if summary_only:
        address_parts = [
            target_user.get("officeAddressLine1"),
            target_user.get("officeAddressLine2"),
            ", ".join(
                [
                    value
                    for value in (
                        target_user.get("officeCity"),
                        target_user.get("officeState"),
                        target_user.get("officePostalCode"),
                    )
                    if str(value or "").strip()
                ]
            ),
            target_user.get("officeCountry"),
        ]
        address = "\n".join(
            [str(part).strip() for part in address_parts if str(part or "").strip()]
        ) or None

        return {
            "user": {
                "id": target_user.get("id"),
                "name": target_user.get("name") or target_user.get("email") or "User",
                "email": target_user.get("email"),
                "phone": _normalize_optional_text(target_user.get("phone"))
                or _normalize_optional_text((target_sales_rep_record or {}).get("phone")),
                "role": target_user.get("role"),
                "profileImageUrl": None,
                "greaterArea": None,
                "studyFocus": None,
                "bio": None,
                "resellerPermitFilePath": None,
                "resellerPermitFileName": None,
                "resellerPermitUploadedAt": None,
                "salesRepId": target_sales_rep_id,
                "isPartner": _normalize_bool(
                    target_sales_rep_record.get("isPartner")
                    if isinstance(target_sales_rep_record, dict) and "isPartner" in target_sales_rep_record
                    else (target_sales_rep_record or {}).get("is_partner")
                )
                if isinstance(target_sales_rep_record, dict)
                else None,
                "allowedRetail": _normalize_bool(
                    target_sales_rep_record.get("allowedRetail")
                    if isinstance(target_sales_rep_record, dict) and "allowedRetail" in target_sales_rep_record
                    else (target_sales_rep_record or {}).get("allowed_retail")
                )
                if isinstance(target_sales_rep_record, dict)
                else None,
                "officeAddressLine1": target_user.get("officeAddressLine1"),
                "officeAddressLine2": target_user.get("officeAddressLine2"),
                "officeCity": target_user.get("officeCity"),
                "officeState": target_user.get("officeState"),
                "officePostalCode": target_user.get("officePostalCode"),
                "officeCountry": target_user.get("officeCountry"),
            },
            "ownerSalesRepId": target_sales_rep_id,
            "isSalesProfile": target_is_sales_actor,
            "summaryOnly": True,
            "orders": [],
            "personalOrders": [],
            "salesOrders": [],
            "personalOrdersLoaded": True,
            "salesOrdersLoaded": True,
            "personalRevenue": None,
            "salesRevenue": None,
            "salesWholesaleRevenue": None,
            "salesRetailRevenue": None,
            "orderQuantity": None,
            "salesOrderCount": None,
            "totalOrderValue": None,
            "lastOrderDate": None,
            "address": address,
        }

    personal_orders = order_repository.list_user_overlay_fields(normalized_target_user_id)
    personal_orders.sort(key=_order_sort_key, reverse=True)

    sales_orders: List[Dict] = []
    if target_is_sales_actor and target_allowed_rep_ids:
        assigned_doctor_ids = [
            str(user.get("id"))
            for user in users
            if isinstance(user, dict)
            and user.get("id") is not None
            and _normalize_role(user.get("role")) in ("doctor", "test_doctor")
            and str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip() in target_allowed_rep_ids
        ]
        if assigned_doctor_ids:
            sales_orders = order_repository.find_sales_tracking_by_user_ids(assigned_doctor_ids)
            sales_orders.sort(key=_order_sort_key, reverse=True)

    personal_order_keys = {
        _order_identity_key(order)
        for order in personal_orders
        if _order_identity_key(order)
    }
    filtered_sales_orders = [
        order
        for order in sales_orders
        if _order_identity_key(order) not in personal_order_keys
    ]

    combined_by_key: Dict[str, Dict] = {}
    for order in [*personal_orders, *filtered_sales_orders]:
        key = _order_identity_key(order)
        if not key or key in combined_by_key:
            continue
        combined_by_key[key] = order
    combined_orders = sorted(combined_by_key.values(), key=_order_sort_key, reverse=True)

    personal_revenue = sum(
        _resolve_order_subtotal(order)
        for order in personal_orders
        if _should_count_revenue(order.get("status"))
    )
    sales_wholesale_revenue = 0.0
    sales_retail_revenue = 0.0
    for order in filtered_sales_orders:
        if not _should_count_revenue(order.get("status")):
            continue
        subtotal = _resolve_order_subtotal(order)
        pricing_mode = str(order.get("pricingMode") or order.get("pricing_mode") or "").strip().lower()
        if pricing_mode == "wholesale":
            sales_wholesale_revenue += subtotal
        else:
            sales_retail_revenue += subtotal
    sales_revenue = sales_wholesale_revenue + sales_retail_revenue
    total_order_value = sum(
        _resolve_order_subtotal(order)
        for order in combined_orders
        if _should_count_revenue(order.get("status"))
    )
    order_quantity = sum(1 for order in combined_orders if _should_count_revenue(order.get("status")))
    sales_order_count = sum(
        1 for order in filtered_sales_orders if _should_count_revenue(order.get("status"))
    )

    address_parts = [
        target_user.get("officeAddressLine1"),
        target_user.get("officeAddressLine2"),
        ", ".join(
            [
                value
                for value in (
                    target_user.get("officeCity"),
                    target_user.get("officeState"),
                    target_user.get("officePostalCode"),
                )
                if str(value or "").strip()
            ]
        ),
        target_user.get("officeCountry"),
    ]
    address = "\n".join(
        [str(part).strip() for part in address_parts if str(part or "").strip()]
    ) or None
    last_order_date = next(
        (
            order.get("createdAt") or order.get("updatedAt")
            for order in combined_orders
            if isinstance(order, dict)
        ),
        None,
    )

    return {
        "user": {
            "id": target_user.get("id"),
            "name": target_user.get("name") or target_user.get("email") or "User",
            "email": target_user.get("email"),
            "phone": _normalize_optional_text(target_user.get("phone"))
            or _normalize_optional_text((target_sales_rep_record or {}).get("phone")),
            "role": target_user.get("role"),
            "profileImageUrl": user_media_service.resolve_admin_user_profile_image_url(
                target_user.get("id"),
                target_user.get("profileImageUrl"),
            ),
            "greaterArea": target_user.get("greaterArea"),
            "studyFocus": target_user.get("studyFocus"),
            "bio": target_user.get("bio"),
            "resellerPermitFilePath": (
                target_user.get("resellerPermitFilePath")
                or target_user.get("reseller_permit_file_path")
            ),
            "resellerPermitFileName": (
                target_user.get("resellerPermitFileName")
                or target_user.get("reseller_permit_file_name")
            ),
            "resellerPermitUploadedAt": (
                target_user.get("resellerPermitUploadedAt")
                or target_user.get("reseller_permit_uploaded_at")
            ),
            "supplementalProfileLoaded": True,
            "salesRepId": target_sales_rep_id,
            "isPartner": _normalize_bool(
                target_sales_rep_record.get("isPartner")
                if isinstance(target_sales_rep_record, dict) and "isPartner" in target_sales_rep_record
                else (target_sales_rep_record or {}).get("is_partner")
            )
            if isinstance(target_sales_rep_record, dict)
            else None,
            "allowedRetail": _normalize_bool(
                target_sales_rep_record.get("allowedRetail")
                if isinstance(target_sales_rep_record, dict) and "allowedRetail" in target_sales_rep_record
                else (target_sales_rep_record or {}).get("allowed_retail")
            )
            if isinstance(target_sales_rep_record, dict)
            else None,
            "officeAddressLine1": target_user.get("officeAddressLine1"),
            "officeAddressLine2": target_user.get("officeAddressLine2"),
            "officeCity": target_user.get("officeCity"),
            "officeState": target_user.get("officeState"),
            "officePostalCode": target_user.get("officePostalCode"),
            "officeCountry": target_user.get("officeCountry"),
        },
        "ownerSalesRepId": target_sales_rep_id,
        "isSalesProfile": target_is_sales_actor,
        "orders": combined_orders,
        "personalOrders": personal_orders,
        "salesOrders": filtered_sales_orders,
        "personalOrdersLoaded": True,
        "salesOrdersLoaded": True,
        "personalRevenue": personal_revenue if personal_orders else None,
        "salesRevenue": sales_revenue if target_is_sales_actor else None,
        "salesWholesaleRevenue": sales_wholesale_revenue if target_is_sales_actor else None,
        "salesRetailRevenue": sales_retail_revenue if target_is_sales_actor else None,
        "orderQuantity": order_quantity,
        "salesOrderCount": sales_order_count if target_is_sales_actor else None,
        "totalOrderValue": total_order_value,
        "lastOrderDate": last_order_date,
        "address": address,
    }


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

    candidates: List[str] = []

    def add_candidate(value: Any) -> None:
        text = str(value or "").strip()
        if text and text not in candidates:
            candidates.append(text)

    add_candidate(order_id)
    if isinstance(shipstation_info, dict):
        add_candidate(shipstation_info.get("orderNumber"))
        add_candidate(shipstation_info.get("orderId"))

    existing = None
    resolved_order_id = str(order_id).strip()
    try:
        existing = order_repository.find_by_id(resolved_order_id)
    except Exception:
        existing = None
    if not existing:
        for candidate in candidates:
            try:
                existing = (
                    order_repository.find_by_order_identifier(candidate)
                    or _find_order_by_woo_id(candidate)
                    or None
                )
            except Exception:
                existing = None
            if isinstance(existing, dict):
                resolved_order_id = str(existing.get("id") or resolved_order_id).strip() or resolved_order_id
                break
    if not existing:
        return

    merged = dict(existing)
    if shipping_estimate:
        current_est = _ensure_dict(merged.get("shippingEstimate"))
        current_est.update(shipping_estimate)
        merged["shippingEstimate"] = current_est
    normalized_tracking = _normalize_optional_text(tracking)
    existing_tracking = _normalize_optional_text(merged.get("trackingNumber"))
    if normalized_tracking and not existing_tracking:
        merged["trackingNumber"] = normalized_tracking
    ship_date = None
    if isinstance(shipstation_info, dict):
        ship_date = shipstation_info.get("shipDate")
    if ship_date:
        merged["shippedAt"] = ship_date

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
            extra={"orderId": resolved_order_id or order_id},
        )

    # Best-effort local JSON update for testing
    try:
        store = storage.order_store
        if store:
            orders = list(store.read())
            updated = False
            for idx, entry in enumerate(orders):
                if str(entry.get("id")) == str(resolved_order_id or order_id):
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
            extra={"orderId": resolved_order_id or order_id},
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
    derived_shipping_status = _normalize_shipstation_delivery_status(info)
    authoritative_ups_status = _apply_authoritative_ups_tracking_status(order)
    if ship_status == "shipped" or derived_shipping_status:
        estimate = _ensure_dict(order.get("shippingEstimate"))
        if not authoritative_ups_status:
            estimate["status"] = derived_shipping_status or "shipped"
        if info.get("shipDate"):
            estimate["shipDate"] = info["shipDate"]
        order["shippingEstimate"] = estimate
    if info.get("trackingNumber"):
        order["trackingNumber"] = info["trackingNumber"]

    peppro_order_id = _extract_peppro_order_id_from_integrations(
        order.get("integrationDetails") or order.get("integrations"),
        fallback=order.get("id"),
    )
    _persist_shipping_update(
        peppro_order_id,
        order.get("shippingEstimate"),
        order.get("trackingNumber"),
        info,
    )


def _normalize_shipstation_delivery_status(shipstation_info: Dict) -> Optional[str]:
    """
    Best-effort mapping from ShipStation shipment/order status fields to a PepPro-friendly token.

    ShipStation frequently reports orderStatus='shipped' even after delivery; the shipments payload
    may include additional delivery/tracking status strings. We normalize these into:
      - delivered
      - out_for_delivery
      - in_transit
      - shipped
      - awaiting_shipment
    """
    if not isinstance(shipstation_info, dict):
        return None

    def norm(value) -> str:
        text = str(value or "").strip().lower()
        text = text.replace("-", "_").replace(" ", "_")
        while "__" in text:
            text = text.replace("__", "_")
        return text

    candidates = [
        shipstation_info.get("trackingStatus"),
        shipstation_info.get("tracking_status"),
        shipstation_info.get("deliveryStatus"),
        shipstation_info.get("delivery_status"),
        shipstation_info.get("shipmentStatus"),
        shipstation_info.get("shipment_status"),
        shipstation_info.get("status"),
    ]
    shipments = shipstation_info.get("shipments") or []
    if isinstance(shipments, list):
        for entry in shipments:
            if not isinstance(entry, dict):
                continue
            if entry.get("voided") is True:
                continue
            candidates.extend(
                [
                    entry.get("trackingStatus"),
                    entry.get("tracking_status"),
                    entry.get("deliveryStatus"),
                    entry.get("delivery_status"),
                    entry.get("shipmentStatus"),
                    entry.get("shipment_status"),
                    entry.get("status"),
                ]
            )

    for candidate in candidates:
        token = norm(candidate)
        if not token:
            continue
        if "delivered" in token:
            return "delivered"
        if "out_for_delivery" in token or "outfordelivery" in token:
            return "out_for_delivery"
        if "in_transit" in token or "intransit" in token:
            return "in_transit"
        if "shipped" in token:
            return "shipped"
        if "awaiting_shipment" in token or token == "awaiting":
            return "awaiting_shipment"
    return None


def _build_sales_rep_order_detail_from_local(local_order: Dict) -> Dict:
    shipping_address = _ensure_dict(local_order.get("shippingAddress") or local_order.get("shipping_address"))
    billing_address = _ensure_dict(local_order.get("billingAddress") or local_order.get("billing_address"))
    is_facility_pickup = bool(
        local_order.get("facilityPickup")
        or local_order.get("facility_pickup")
        or local_order.get("fascility_pickup")
        or str(local_order.get("fulfillmentMethod") or local_order.get("fulfillment_method") or "").strip().lower()
        in ("facility_pickup", "fascility_pickup")
    )
    facility_pickup_recipient_name = None
    if is_facility_pickup:
        facility_pickup_recipient_name = _normalize_optional_text(
            shipping_address.get("recipientName")
            or shipping_address.get("recipient_name")
            or shipping_address.get("orderRecipientName")
            or shipping_address.get("order_recipient_name")
            or shipping_address.get("pickupRecipientName")
            or shipping_address.get("pickup_recipient_name")
            or billing_address.get("recipientName")
            or billing_address.get("recipient_name")
            or billing_address.get("orderRecipientName")
            or billing_address.get("order_recipient_name")
            or billing_address.get("pickupRecipientName")
            or billing_address.get("pickup_recipient_name")
            or local_order.get("facilityPickupRecipientName")
            or local_order.get("facility_pickup_recipient_name")
            or local_order.get("pickupRecipientName")
            or local_order.get("pickup_recipient_name")
            or local_order.get("recipientName")
            or local_order.get("recipient_name")
            or local_order.get("orderRecipientName")
            or local_order.get("order_recipient_name")
            or shipping_address.get("fullName")
            or billing_address.get("fullName")
        )
    if facility_pickup_recipient_name:
        if shipping_address:
            shipping_address = _apply_facility_pickup_recipient_name(shipping_address, facility_pickup_recipient_name)
        if billing_address:
            billing_address = _apply_facility_pickup_recipient_name(billing_address, facility_pickup_recipient_name)
    integrations = _ensure_dict(local_order.get("integrationDetails") or local_order.get("integrations"))
    shipstation = _ensure_dict(integrations.get("shipStation") or integrations.get("shipstation"))

    local_id = _normalize_optional_text(local_order.get("id"))
    woo_order_id = _normalize_optional_text(local_order.get("wooOrderId") or local_order.get("woo_order_id"))
    woo_order_number = _normalize_optional_text(
        local_order.get("wooOrderNumber") or local_order.get("woo_order_number")
    )
    order_number = woo_order_number or woo_order_id or local_id
    payment_details = (
        _normalize_optional_text(local_order.get("paymentDetails"))
        or _normalize_optional_text(local_order.get("paymentMethod"))
        or None
    )
    billing_email = (
        _normalize_optional_text(billing_address.get("email"))
        or _normalize_optional_text(shipping_address.get("email"))
        or _normalize_optional_text(local_order.get("doctorEmail") or local_order.get("doctor_email"))
        or None
    )

    def _as_float(value: object) -> float:
        try:
            return float(value or 0)
        except Exception:
            return 0.0

    mapped = {
        "id": woo_order_id or local_id or order_number,
        "pepproOrderId": local_id,
        "number": order_number,
        "wooOrderId": woo_order_id,
        "wooOrderNumber": woo_order_number,
        "status": _normalize_optional_text(local_order.get("status")) or "pending",
        "currency": _normalize_optional_text(local_order.get("currency")) or "USD",
        "total": _as_float(local_order.get("grandTotal") or local_order.get("total")),
        "grandTotal": _as_float(local_order.get("grandTotal") or local_order.get("total")),
        "taxTotal": _as_float(local_order.get("taxTotal")),
        "shippingTotal": _as_float(local_order.get("shippingTotal")),
        "itemsSubtotal": local_order.get("itemsSubtotal"),
        "originalItemsSubtotal": local_order.get("originalItemsSubtotal"),
        "discountCode": local_order.get("discountCode"),
        "discountCodeAmount": local_order.get("discountCodeAmount"),
        "appliedReferralCredit": local_order.get("appliedReferralCredit"),
        "paymentMethod": payment_details,
        "paymentDetails": payment_details,
        "shippingAddress": shipping_address or None,
        "billingAddress": billing_address or (shipping_address or None),
        "facilityPickupRecipientName": facility_pickup_recipient_name,
        "facility_pickup_recipient_name": facility_pickup_recipient_name,
        "pickupRecipientName": facility_pickup_recipient_name,
        "pickup_recipient_name": facility_pickup_recipient_name,
        "recipientName": facility_pickup_recipient_name,
        "recipient_name": facility_pickup_recipient_name,
        "orderRecipientName": facility_pickup_recipient_name,
        "order_recipient_name": facility_pickup_recipient_name,
        "customerName": local_order.get("customerName") or local_order.get("customer_name") or None,
        "customer_name": local_order.get("customer_name") or local_order.get("customerName") or None,
        "billingEmail": billing_email,
        "shippingEstimate": local_order.get("shippingEstimate") or None,
        "trackingNumber": _normalize_optional_text(
            local_order.get("trackingNumber") or shipstation.get("trackingNumber")
        ),
        "upsTrackingStatus": _normalize_optional_text(local_order.get("upsTrackingStatus")),
        "deliveryDate": _normalize_optional_text(local_order.get("deliveryDate")),
        "upsDeliveredAt": _normalize_optional_text(local_order.get("upsDeliveredAt")),
        "shippingCarrier": _normalize_optional_text(local_order.get("shippingCarrier")),
        "shippingService": _normalize_optional_text(local_order.get("shippingService")),
        "expectedShipmentWindow": _normalize_optional_text(local_order.get("expectedShipmentWindow")),
        "notes": local_order.get("notes"),
        "lineItems": local_order.get("items") or local_order.get("lineItems") or [],
        "integrationDetails": integrations or None,
        "createdAt": local_order.get("createdAt"),
        "updatedAt": local_order.get("updatedAt"),
        "doctorId": local_order.get("userId") or local_order.get("user_id") or None,
        "doctorName": local_order.get("doctorName") or local_order.get("doctor_name") or None,
        "doctorSalesRepId": (
            local_order.get("doctorSalesRepId")
            or local_order.get("salesRepId")
            or local_order.get("sales_rep_id")
            or local_order.get("doctor_sales_rep_id")
            or None
        ),
        "asDelegate": (
            local_order.get("asDelegate")
            if local_order.get("asDelegate") is not None
            else local_order.get("as_delegate")
        ),
        "as_delegate": (
            local_order.get("as_delegate")
            if local_order.get("as_delegate") is not None
            else local_order.get("asDelegate")
        ),
    }
    _apply_authoritative_ups_tracking_status(mapped)
    return mapped


def get_sales_rep_order_detail(
    order_id: str,
    sales_rep_id: str,
    token_role: Optional[str] = None,
    doctor_id_hint: Optional[str] = None,
    doctor_email_hint: Optional[str] = None,
) -> Optional[Dict]:
    """
    Fetch a single Woo order detail and ensure it belongs to a doctor tied to this sales rep.
    """
    if not order_id:
        return None

    def _has_populated_address(value: object) -> bool:
        if not isinstance(value, dict):
            return False
        for key in ("name", "addressLine1", "addressLine2", "city", "state", "postalCode", "country", "phone", "email"):
            text = str(value.get(key) or "").strip()
            if text:
                return True
        return False

    def _is_unusable_email(value: object) -> bool:
        normalized = _normalize_email(str(value or ""))
        return (not normalized) or normalized == "[encrypted]" or normalized.endswith("@peppro.example")

    def _pick_doctor(local_order: Optional[Dict]) -> Optional[Dict]:
        billing_email = (woo_order.get("billing") or {}).get("email") or mapped.get("billingEmail")
        if not _is_unusable_email(billing_email):
            doctor_by_billing = user_repository.find_by_email(billing_email)
            if doctor_by_billing:
                return doctor_by_billing

        normalized_hint_id = str(doctor_id_hint or "").strip()
        if normalized_hint_id:
            hinted = user_repository.find_by_id(normalized_hint_id)
            if hinted:
                return hinted

        normalized_hint_email = _normalize_email(doctor_email_hint)
        if normalized_hint_email and "@" in normalized_hint_email:
            hinted = user_repository.find_by_email(normalized_hint_email)
            if hinted:
                return hinted

        local_user_id = str(
            (local_order or {}).get("userId")
            or (local_order or {}).get("user_id")
            or ""
        ).strip()
        if local_user_id:
            return user_repository.find_by_id(local_user_id)
        return None

    local_order = None
    try:
        local_order = (
            order_repository.find_by_order_identifier(str(order_id))
            or _find_order_by_woo_id(str(order_id))
            or order_repository.find_by_id(str(order_id))
        )
    except Exception:
        local_order = None

    woo_order: Dict[str, Any] = {}
    use_local_detail_only = isinstance(local_order, dict) and bool(local_order)
    if use_local_detail_only:
        mapped = _build_sales_rep_order_detail_from_local(local_order)
    else:
        if not woo_commerce.is_configured():
            return None
        try:
            candidates: List[str] = []
            for raw_candidate in (
                (local_order or {}).get("wooOrderId"),
                (local_order or {}).get("woo_order_id"),
                (local_order or {}).get("wooOrderNumber"),
                (local_order or {}).get("woo_order_number"),
                order_id,
            ):
                for candidate in _normalize_order_identifier(str(raw_candidate or "")):
                    if candidate not in candidates:
                        candidates.append(candidate)
            logger.debug(
                "[SalesRep] Order detail lookup start",
                extra={"orderId": order_id, "salesRepId": sales_rep_id, "candidates": candidates},
            )
            for candidate in candidates:
                woo_order = woo_commerce.fetch_order(candidate)
                if woo_order:
                    break
            if not woo_order:
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

    resolved_doctor = _pick_doctor(local_order)
    normalized_token_role = (token_role or "").strip().lower()
    is_admin_request = normalized_token_role in (
        "admin",
        "sales_lead",
        "saleslead",
        "sales-lead",
    )
    if resolved_doctor:
        if not is_admin_request:
            users = user_repository.get_all()
            rep_records = {str(rep.get("id")): rep for rep in sales_rep_repository.get_all() if rep.get("id")}
            allowed_rep_ids = _compute_allowed_sales_rep_ids(sales_rep_id, users, rep_records)

            doctor_sales_rep = str(
                resolved_doctor.get("salesRepId") or resolved_doctor.get("sales_rep_id") or ""
            )
            if doctor_sales_rep and doctor_sales_rep not in allowed_rep_ids:
                raise _service_error("Order not found", 404)
    elif not is_admin_request:
        if not local_order:
            raise _service_error("Order not found", 404)
        users = user_repository.get_all()
        rep_records = {str(rep.get("id")): rep for rep in sales_rep_repository.get_all() if rep.get("id")}
        allowed_rep_ids = _compute_allowed_sales_rep_ids(sales_rep_id, users, rep_records)
        order_rep_candidates = {
            str(local_order.get("doctorSalesRepId") or "").strip(),
            str(local_order.get("salesRepId") or "").strip(),
            str(local_order.get("sales_rep_id") or "").strip(),
            str(local_order.get("doctor_sales_rep_id") or "").strip(),
        }
        order_rep_candidates.discard("")
        if not order_rep_candidates or order_rep_candidates.isdisjoint(allowed_rep_ids):
            raise _service_error("Order not found", 404)

    # Enrich with ShipStation status/tracking when available, even for local-only detail views.
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
        integrations = _ensure_dict(mapped.get("integrationDetails") or mapped.get("integrations"))
        integrations["shipStation"] = shipstation_info
        mapped["integrationDetails"] = integrations
        ship_status = (shipstation_info.get("status") or "").lower()
        derived_shipping_status = _normalize_shipstation_delivery_status(shipstation_info)
        authoritative_ups_status = _apply_authoritative_ups_tracking_status(mapped) or (
            _apply_authoritative_ups_tracking_status(local_order) if isinstance(local_order, dict) else None
        )
        carrier_code = shipstation_info.get("carrierCode")
        service_code = shipstation_info.get("serviceCode")
        if ship_status == "shipped" or derived_shipping_status:
            if ship_status == "shipped" and not mapped.get("status"):
                mapped["status"] = "shipped"
            mapped.setdefault("shippingEstimate", {})
            if not authoritative_ups_status:
                mapped["shippingEstimate"]["status"] = derived_shipping_status or "shipped"
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
        peppro_order_id = _extract_peppro_order_id_from_integrations(
            mapped.get("integrationDetails") or mapped.get("integrations"),
            fallback=mapped.get("id"),
        )
        _persist_shipping_update(
            peppro_order_id,
            mapped.get("shippingEstimate"),
            mapped.get("trackingNumber"),
            shipstation_info,
        )

    # Pull local PepPro order fields for fallback detail hydration and display-only metadata.
    # This keeps the detail modal usable when Woo returns sparse billing/shipping data or when
    # the order was authored before the current Woo payload shape.
    try:
        integrations = _ensure_dict(mapped.get("integrationDetails") or mapped.get("integrations"))
        woo_details = _extract_woo_details(integrations)
        peppro_order_id = _extract_peppro_order_id_from_integrations(integrations)
        if peppro_order_id and not local_order:
            local_order = order_repository.find_by_id(str(peppro_order_id))
        if not local_order:
            local_order = (
                order_repository.find_by_order_identifier(
                    str(mapped.get("wooOrderId") or mapped.get("id") or mapped.get("wooOrderNumber") or "")
                )
                or _find_order_by_woo_id(
                    str(mapped.get("wooOrderId") or mapped.get("id") or mapped.get("wooOrderNumber") or "")
                )
                or None
            )
        if local_order:
            local_shipping = _ensure_dict(local_order.get("shippingAddress") or local_order.get("shipping_address"))
            local_billing = _ensure_dict(local_order.get("billingAddress") or local_order.get("billing_address"))
            local_is_facility_pickup = bool(
                local_order.get("facilityPickup")
                or local_order.get("facility_pickup")
                or local_order.get("fascility_pickup")
                or str(local_order.get("fulfillmentMethod") or local_order.get("fulfillment_method") or "").strip().lower()
                in ("facility_pickup", "fascility_pickup")
            )
            local_facility_pickup_recipient_name = None
            if local_is_facility_pickup:
                local_facility_pickup_recipient_name = _normalize_optional_text(
                    local_shipping.get("recipientName")
                    or local_shipping.get("recipient_name")
                    or local_shipping.get("orderRecipientName")
                    or local_shipping.get("order_recipient_name")
                    or local_shipping.get("pickupRecipientName")
                    or local_shipping.get("pickup_recipient_name")
                    or local_shipping.get("fullName")
                    or local_shipping.get("name")
                    or local_billing.get("recipientName")
                    or local_billing.get("recipient_name")
                    or local_billing.get("orderRecipientName")
                    or local_billing.get("order_recipient_name")
                    or local_billing.get("pickupRecipientName")
                    or local_billing.get("pickup_recipient_name")
                    or local_billing.get("fullName")
                    or local_billing.get("name")
                    or local_order.get("facilityPickupRecipientName")
                    or local_order.get("facility_pickup_recipient_name")
                    or local_order.get("pickupRecipientName")
                    or local_order.get("pickup_recipient_name")
                    or local_order.get("recipientName")
                    or local_order.get("recipient_name")
                    or local_order.get("orderRecipientName")
                    or local_order.get("order_recipient_name")
                )
            if local_facility_pickup_recipient_name:
                if local_shipping:
                    local_shipping = _apply_facility_pickup_recipient_name(
                        local_shipping,
                        local_facility_pickup_recipient_name,
                    )
                if local_billing:
                    local_billing = _apply_facility_pickup_recipient_name(
                        local_billing,
                        local_facility_pickup_recipient_name,
                    )
                mapped["facilityPickupRecipientName"] = local_facility_pickup_recipient_name
                mapped["facility_pickup_recipient_name"] = local_facility_pickup_recipient_name
                mapped["pickupRecipientName"] = local_facility_pickup_recipient_name
                mapped["pickup_recipient_name"] = local_facility_pickup_recipient_name
                mapped["recipientName"] = local_facility_pickup_recipient_name
                mapped["recipient_name"] = local_facility_pickup_recipient_name
                mapped["orderRecipientName"] = local_facility_pickup_recipient_name
                mapped["order_recipient_name"] = local_facility_pickup_recipient_name
                if _has_populated_address(mapped.get("shippingAddress")):
                    mapped["shippingAddress"] = _apply_facility_pickup_recipient_name(
                        _ensure_dict(mapped.get("shippingAddress")),
                        local_facility_pickup_recipient_name,
                    )
                if _has_populated_address(mapped.get("billingAddress")):
                    mapped["billingAddress"] = _apply_facility_pickup_recipient_name(
                        _ensure_dict(mapped.get("billingAddress")),
                        local_facility_pickup_recipient_name,
                    )
            local_payment = (
                local_order.get("paymentDetails")
                or local_order.get("paymentMethod")
                or None
            )

            if local_order.get("notes") is not None:
                mapped["notes"] = local_order.get("notes")
            delegate_label = (
                local_order.get("asDelegate")
                if local_order.get("asDelegate") is not None
                else local_order.get("as_delegate")
            )
            if delegate_label is not None:
                mapped["asDelegate"] = delegate_label
                mapped["as_delegate"] = delegate_label
            local_tracking_number = _normalize_optional_text(local_order.get("trackingNumber"))
            if local_tracking_number is not None:
                mapped["trackingNumber"] = local_tracking_number
            if local_order.get("shippingEstimate"):
                mapped["shippingEstimate"] = local_order.get("shippingEstimate")
            if local_order.get("upsTrackingStatus") is not None:
                mapped["upsTrackingStatus"] = local_order.get("upsTrackingStatus")
            if local_order.get("deliveryDate") is not None:
                mapped["deliveryDate"] = local_order.get("deliveryDate")
            if local_order.get("upsDeliveredAt") is not None:
                mapped["upsDeliveredAt"] = local_order.get("upsDeliveredAt")
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
            if not _has_populated_address(mapped.get("shippingAddress")) and _has_populated_address(local_shipping):
                mapped["shippingAddress"] = local_shipping
            if not _has_populated_address(mapped.get("billingAddress")):
                if _has_populated_address(local_billing):
                    mapped["billingAddress"] = local_billing
                elif _has_populated_address(local_shipping):
                    mapped["billingAddress"] = local_shipping
            if (not mapped.get("paymentMethod")) and local_payment:
                mapped["paymentMethod"] = local_payment
            if (not mapped.get("paymentDetails")) and local_payment:
                mapped["paymentDetails"] = local_payment
            if _is_unusable_email(mapped.get("billingEmail")):
                fallback_email = (
                    local_billing.get("email")
                    or local_shipping.get("email")
                    or (resolved_doctor or {}).get("email")
                    or None
                )
                if fallback_email:
                    mapped["billingEmail"] = fallback_email
            _apply_authoritative_ups_tracking_status(mapped)
    except Exception:
        pass

    if isinstance(mapped.get("lineItems"), list) and mapped.get("lineItems"):
        persist_order_id = None
        if use_local_detail_only and isinstance(local_order, dict):
            persist_order_id = _normalize_optional_text(local_order.get("id"))
        mapped["lineItems"] = _hydrate_line_items_with_images(
            mapped.get("lineItems"),
            persist_order_id=persist_order_id,
        )
        if persist_order_id and isinstance(local_order, dict):
            local_order["items"] = list(mapped["lineItems"])

    local_order = _refresh_authoritative_ups_status_for_order_view(mapped, local_order=local_order)

    mapped_is_facility_pickup = bool(
        mapped.get("facilityPickup")
        or mapped.get("facility_pickup")
        or mapped.get("fascility_pickup")
        or str(mapped.get("fulfillmentMethod") or mapped.get("fulfillment_method") or "").strip().lower()
        in ("facility_pickup", "fascility_pickup")
    )
    mapped_shipping = _ensure_dict(mapped.get("shippingAddress") or mapped.get("shipping_address"))
    mapped_billing = _ensure_dict(mapped.get("billingAddress") or mapped.get("billing_address"))
    mapped_facility_pickup_recipient_name = None
    if mapped_is_facility_pickup:
        mapped_facility_pickup_recipient_name = _normalize_optional_text(
            mapped_shipping.get("recipientName")
            or mapped_shipping.get("recipient_name")
            or mapped_shipping.get("orderRecipientName")
            or mapped_shipping.get("order_recipient_name")
            or mapped_shipping.get("pickupRecipientName")
            or mapped_shipping.get("pickup_recipient_name")
            or mapped_shipping.get("fullName")
            or mapped_shipping.get("name")
            or mapped_billing.get("recipientName")
            or mapped_billing.get("recipient_name")
            or mapped_billing.get("orderRecipientName")
            or mapped_billing.get("order_recipient_name")
            or mapped_billing.get("pickupRecipientName")
            or mapped_billing.get("pickup_recipient_name")
            or mapped_billing.get("fullName")
            or mapped_billing.get("name")
            or mapped.get("facilityPickupRecipientName")
            or mapped.get("facility_pickup_recipient_name")
            or mapped.get("pickupRecipientName")
            or mapped.get("pickup_recipient_name")
            or mapped.get("recipientName")
            or mapped.get("recipient_name")
            or mapped.get("orderRecipientName")
            or mapped.get("order_recipient_name")
        )
    if mapped_facility_pickup_recipient_name:
        mapped["facilityPickupRecipientName"] = mapped_facility_pickup_recipient_name
        mapped["facility_pickup_recipient_name"] = mapped_facility_pickup_recipient_name
        mapped["pickupRecipientName"] = mapped_facility_pickup_recipient_name
        mapped["pickup_recipient_name"] = mapped_facility_pickup_recipient_name
        mapped["recipientName"] = mapped_facility_pickup_recipient_name
        mapped["recipient_name"] = mapped_facility_pickup_recipient_name
        mapped["orderRecipientName"] = mapped_facility_pickup_recipient_name
        mapped["order_recipient_name"] = mapped_facility_pickup_recipient_name

    if resolved_doctor:
        mapped["doctorId"] = resolved_doctor.get("id")
        mapped["doctorName"] = resolved_doctor.get("name") or mapped.get("billingEmail")
        mapped["doctorEmail"] = resolved_doctor.get("email")
        mapped["doctorSalesRepId"] = resolved_doctor.get("salesRepId")
    elif local_order:
        fallback_shipping = _ensure_dict(local_order.get("shippingAddress") or local_order.get("shipping_address"))
        fallback_billing = _ensure_dict(local_order.get("billingAddress") or local_order.get("billing_address"))
        fallback_name = (
            fallback_shipping.get("name")
            or fallback_billing.get("name")
            or mapped.get("billingEmail")
            or None
        )
        mapped["doctorId"] = local_order.get("userId") or local_order.get("user_id") or None
        mapped["doctorName"] = mapped.get("doctorName") or fallback_name
        mapped["doctorEmail"] = (
            fallback_billing.get("email")
            or fallback_shipping.get("email")
            or mapped.get("billingEmail")
            or None
        )
        mapped["doctorSalesRepId"] = (
            local_order.get("doctorSalesRepId")
            or local_order.get("salesRepId")
            or local_order.get("sales_rep_id")
            or local_order.get("doctor_sales_rep_id")
            or None
        )
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
    force: bool = False,
    debug: bool = False,
):
    global _sales_by_rep_summary_inflight

    start_dt, end_dt, period_meta = _resolve_report_period_bounds(period_start, period_end)
    period_cache_key = f"{period_meta['periodStart']}::{period_meta['periodEnd']}"
    report_tz = _get_report_timezone()
    period_start_local_date = start_dt.astimezone(report_tz).date()
    period_end_local_date = end_dt.astimezone(report_tz).date()
    now_local = datetime.now(report_tz)
    current_year_start_local = datetime(now_local.year, 1, 1, 0, 0, 0, 0, tzinfo=report_tz)
    current_year_start_dt = current_year_start_local.astimezone(timezone.utc)
    current_year_end_date = date(now_local.year, 12, 31)

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

    def _local_date_key(value: datetime) -> str:
        return value.astimezone(report_tz).date().isoformat()

    def _build_cumulative_series(
        daily_totals: Optional[Dict[str, float]] = None,
        daily_orders: Optional[Dict[str, int]] = None,
        *,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> List[Dict[str, Any]]:
        totals = daily_totals or {}
        orders = daily_orders or {}
        series: List[Dict[str, Any]] = []
        running_total = 0.0
        range_start = start_date or period_start_local_date
        range_end = end_date or period_end_local_date
        current_date = range_start
        while current_date <= range_end:
            key = current_date.isoformat()
            daily_revenue = round(float(totals.get(key) or 0.0), 2)
            running_total = round(running_total + daily_revenue, 2)
            series.append(
                {
                    "date": key,
                    "dailyRevenue": daily_revenue,
                    "cumulativeRevenue": running_total,
                    "orderCount": int(orders.get(key) or 0),
                }
            )
            current_date += timedelta(days=1)
        return series

    def _build_year_projection(revenue_to_date: float = 0.0, order_count: int = 0) -> Dict[str, Any]:
        year_start_date = current_year_start_local.date()
        as_of_date = now_local.date()
        total_days_in_year = (date(now_local.year + 1, 1, 1) - year_start_date).days
        days_elapsed = max(1, (as_of_date - year_start_date).days + 1)
        average_daily_revenue = float(revenue_to_date) / days_elapsed if days_elapsed > 0 else 0.0
        projected_year_end_revenue = average_daily_revenue * total_days_in_year
        return {
            "year": int(now_local.year),
            "yearStart": year_start_date.isoformat(),
            "asOfDate": as_of_date.isoformat(),
            "yearEnd": current_year_end_date.isoformat(),
            "daysElapsed": int(days_elapsed),
            "totalDaysInYear": int(total_days_in_year),
            "orderCount": int(order_count),
            "revenueToDate": round(float(revenue_to_date), 2),
            "averageDailyRevenue": round(float(average_daily_revenue), 2),
            "projectedYearEndRevenue": round(float(projected_year_end_revenue), 2),
            "timeZone": getattr(report_tz, "key", None) or str(report_tz),
        }

    def _compute_summary() -> Dict[str, Any]:
        users = user_repository.get_all()
        rep_like_roles = {"sales_rep", "sales_partner", "rep", "admin", "sales_lead", "saleslead"}
        reps = [u for u in users if _normalize_role(u.get("role")) in rep_like_roles]
        rep_records_list = sales_rep_repository.get_all()
        rep_records = {str(rep.get("id")): rep for rep in rep_records_list if rep.get("id")}
        user_lookup = {str(u.get("id")): u for u in users if u.get("id")}
        rep_lookup_by_id: Dict[str, Dict] = {}
        for u in users:
            if _normalize_role(u.get("role")) not in rep_like_roles:
                continue
            user_id = str(u.get("id") or "").strip()
            if not user_id:
                continue
            rep_lookup_by_id[user_id] = {
                "id": user_id,
                "name": u.get("name") or u.get("email") or "Sales Rep",
                "email": u.get("email"),
                "role": _normalize_role(u.get("role")) or "sales_rep",
            }
        for rep in rep_records_list:
            rep_id = str(rep.get("id") or "").strip()
            if not rep_id:
                continue
            rep_role = _resolve_rep_record_role(rep)
            if rep_role and rep_role not in ("sales_rep", "sales_partner"):
                continue
            rep_lookup_by_id.setdefault(
                rep_id,
                {
                    "id": rep_id,
                    "name": rep.get("name") or rep.get("email") or "Sales Rep",
                    "email": rep.get("email"),
                    "role": rep_role or "sales_rep",
                },
            )

        def _norm_email(value: object) -> str:
            return str(value or "").strip().lower()

        users_by_email: Dict[str, Dict] = {}
        for u in users:
            email = _norm_email(u.get("email"))
            if email:
                users_by_email[email] = u

        rep_user_id_by_rep_id: Dict[str, str] = {}

        # Allow resolving a rep by their `users.sales_rep_id` external key (common in MySQL deployments).
        for u in users:
            if _normalize_role(u.get("role")) not in rep_like_roles:
                continue
            user_id = str(u.get("id") or "").strip()
            if user_id:
                rep_user_id_by_rep_id[user_id] = user_id
            rep_alias = str(u.get("salesRepId") or u.get("sales_rep_id") or "").strip()
            if rep_alias:
                if rep_alias not in user_lookup:
                    user_lookup[rep_alias] = u
                if user_id:
                    rep_user_id_by_rep_id[rep_alias] = user_id

        # Canonical rep id is `sales_reps.id`.
        # We treat `users.id`, `users.sales_rep_id` (external key), and `sales_reps.legacy_user_id`
        # as aliases that should resolve to `sales_reps.id` for reporting.
        rep_id_by_email: Dict[str, str] = {}
        rep_record_by_email: Dict[str, Dict] = {}
        for rep_record in rep_records_list:
            rep_id = str(rep_record.get("id") or "").strip()
            if not rep_id:
                continue
            rep_email = _norm_email(rep_record.get("email"))
            if rep_email:
                rep_id_by_email.setdefault(rep_email, rep_id)
                rep_record_by_email.setdefault(rep_email, rep_record)
            legacy_id_raw = rep_record.get("legacyUserId") or rep_record.get("legacy_user_id")
            legacy_id = str(legacy_id_raw or "").strip()
            if legacy_id:
                rep_user_id_by_rep_id[rep_id] = legacy_id
            elif rep_email and rep_email in users_by_email:
                linked_user_id = str((users_by_email[rep_email] or {}).get("id") or "").strip()
                if linked_user_id:
                    rep_user_id_by_rep_id[rep_id] = linked_user_id

        def _norm_sales_code(value: object) -> str:
            raw = str(value or "").strip()
            if not raw:
                return ""
            return re.sub(r"[^A-Za-z0-9]", "", raw).upper()

        rep_id_by_sales_code: Dict[str, str] = {}
        rep_id_by_initials: Dict[str, str] = {}
        for rep_record in rep_records_list:
            rep_id = str(rep_record.get("id") or "").strip()
            if not rep_id:
                continue
            rep_code = _norm_sales_code(rep_record.get("salesCode") or rep_record.get("sales_code"))
            if rep_code:
                rep_id_by_sales_code.setdefault(rep_code, rep_id)
            rep_initials = str(rep_record.get("initials") or "").strip().upper()
            if rep_initials:
                rep_id_by_initials.setdefault(rep_initials, rep_id)

        alias_to_rep_id: Dict[str, str] = {}
        for rep_record in rep_records_list:
            rep_id = str(rep_record.get("id") or "").strip()
            if not rep_id:
                continue
            alias_to_rep_id[rep_id] = rep_id
            legacy_id_raw = rep_record.get("legacyUserId") or rep_record.get("legacy_user_id")
            legacy_id = str(legacy_id_raw or "").strip()
            if legacy_id:
                alias_to_rep_id[legacy_id] = rep_id
        for u in users:
            if _normalize_role(u.get("role")) not in rep_like_roles:
                continue
            email = _norm_email(u.get("email"))
            if not email:
                continue
            canonical_rep_id = rep_id_by_email.get(email)
            if not canonical_rep_id:
                continue
            user_id = str(u.get("id") or "").strip()
            if user_id:
                alias_to_rep_id[user_id] = canonical_rep_id
                rep_user_id_by_rep_id[canonical_rep_id] = user_id
            rep_alias = str(u.get("salesRepId") or u.get("sales_rep_id") or "").strip()
            if rep_alias:
                alias_to_rep_id[rep_alias] = canonical_rep_id
                if user_id:
                    rep_user_id_by_rep_id[rep_alias] = user_id

        # Keep alias and canonical rep ids synchronized back to a real user id whenever one is known.
        for alias, canonical_rep_id in list(alias_to_rep_id.items()):
            alias_key = str(alias or "").strip()
            canonical_key = str(canonical_rep_id or "").strip()
            if not alias_key or not canonical_key:
                continue
            linked_user_id = rep_user_id_by_rep_id.get(alias_key) or rep_user_id_by_rep_id.get(canonical_key)
            if not linked_user_id:
                continue
            rep_user_id_by_rep_id.setdefault(alias_key, linked_user_id)
            rep_user_id_by_rep_id.setdefault(canonical_key, linked_user_id)

        # Prospect-backed mapping for doctors that don't have `salesRepId` persisted yet.
        prospect_rep_by_doctor: Dict[str, str] = {}
        prospect_rep_updated_ms: Dict[str, int] = {}
        prospect_rep_by_email: Dict[str, str] = {}
        prospect_rep_email_updated_ms: Dict[str, int] = {}
        try:
            prospects = sales_prospect_repository.get_all()
        except Exception:
            prospects = []
        for prospect in prospects or []:
            if not isinstance(prospect, dict):
                continue
            doctor_id = str(prospect.get("doctorId") or prospect.get("doctor_id") or "").strip()
            rep_id_raw = str(prospect.get("salesRepId") or prospect.get("sales_rep_id") or "").strip()
            contact_email = _norm_email(prospect.get("contactEmail") or prospect.get("contact_email"))
            if not rep_id_raw:
                continue
            rep_id_norm = alias_to_rep_id.get(rep_id_raw, rep_id_raw)
            if str(rep_id_norm or "").strip().lower() == "house":
                rep_id_norm = "__house__"
            updated_at = prospect.get("updatedAt") or prospect.get("updated_at") or prospect.get("createdAt") or prospect.get("created_at")
            updated_dt = _parse_datetime_utc(updated_at)
            updated_ms = int(updated_dt.timestamp() * 1000) if updated_dt else 0
            if doctor_id:
                prev_ms = prospect_rep_updated_ms.get(doctor_id, -1)
                if updated_ms >= prev_ms:
                    prospect_rep_by_doctor[doctor_id] = str(rep_id_norm)
                    prospect_rep_updated_ms[doctor_id] = updated_ms
            if contact_email:
                prev_ms = prospect_rep_email_updated_ms.get(contact_email, -1)
                if updated_ms >= prev_ms:
                    prospect_rep_by_email[contact_email] = str(rep_id_norm)
                    prospect_rep_email_updated_ms[contact_email] = updated_ms

        # Used as a fallback when older Woo orders are missing meta.
        doctors_by_email = {}
        for u in users:
            if (u.get("role") or "").lower() not in (
                "doctor",
                "test_doctor",
                "sales_lead",
                "saleslead",
                "sales-lead",
            ):
                continue
            email = (u.get("email") or "").strip().lower()
            if email:
                doctors_by_email[email] = u

        # Ensure doctors have a stable lead type stored for commission tracking.
        try:
            doctors_list = referral_service.backfill_lead_types_for_doctors(list(doctors_by_email.values()))
            doctors_by_email = {
                str(d.get("email") or "").strip().lower(): d
                for d in doctors_list
                if str(d.get("email") or "").strip()
            }
        except Exception:
            pass

        # Any order placed by an email present in the MySQL `contact_forms` table should be
        # treated as a house/contact-form order and split across admins.
        contact_form_emails = _load_contact_form_emails_from_mysql()

        valid_rep_ids: set[str] = set()
        for rep in reps:
            rep_id_raw = str(rep.get("id") or "").strip()
            if not rep_id_raw:
                continue
            valid_rep_ids.add(alias_to_rep_id.get(rep_id_raw, rep_id_raw))
        for rep in rep_records_list:
            rep_id = rep.get("id")
            if rep_id:
                valid_rep_ids.add(alias_to_rep_id.get(str(rep_id), str(rep_id)))
        for rep_id in (prospect_rep_by_doctor.values() if isinstance(prospect_rep_by_doctor, dict) else []):
            if rep_id:
                valid_rep_ids.add(alias_to_rep_id.get(str(rep_id), str(rep_id)))
        for rep_id in (prospect_rep_by_email.values() if isinstance(prospect_rep_by_email, dict) else []):
            if rep_id:
                valid_rep_ids.add(alias_to_rep_id.get(str(rep_id), str(rep_id)))

        tracked_orders: List[Dict[str, object]] = []
        debug_samples: List[Dict[str, object]] = []
        rep_email_hint_by_rep_id: Dict[str, str] = {}
        debug_counts: Dict[str, int] = {}
        if debug:
            debug_counts = {
                "metaRepId": 0,
                "metaRepCode": 0,
                "metaRepEmail": 0,
                "prospectEmail": 0,
                "billingEmailIsRep": 0,
                "userSalesRepId": 0,
                "prospectDoctorId": 0,
                "userIsRep": 0,
                "doctorSalesRepId": 0,
                "fallbackHouse": 0,
            }
        counted_rep = 0
        counted_house = 0
        skipped_unattributed = 0
        skipped_status = 0
        skipped_refunded = 0
        skipped_outside_period = 0
        orders_seen = 0
        tracking_window_start_dt = start_dt if start_dt <= current_year_start_dt else current_year_start_dt
        tracking_window_end_dt = now_local.astimezone(timezone.utc)

        logger.info(
            "[SalesByRep] Begin aggregation",
            extra={
                "validRepCount": len(valid_rep_ids),
                "userReps": len(reps),
                "repoReps": len(rep_records_list),
                "queryStart": tracking_window_start_dt.isoformat(),
                "queryEnd": tracking_window_end_dt.isoformat(),
                "source": "local_orders_sql",
            },
        )

        def _normalize_rep_id(value: object) -> str:
            if value is None:
                return ""
            return str(value).strip()

        def _resolve_order_email(order: Dict[str, object]) -> str:
            for key in (
                "doctorEmail",
                "doctor_email",
                "billingEmail",
                "billing_email",
                "customerEmail",
                "customer_email",
            ):
                candidate = order.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip().lower()
            for address_key in (
                "billingAddress",
                "billing",
                "billing_address",
                "shippingAddress",
                "shipping",
                "shipping_address",
            ):
                address = order.get(address_key)
                if isinstance(address, str):
                    try:
                        address = json.loads(address)
                    except Exception:
                        address = None
                if isinstance(address, dict):
                    email = address.get("email")
                    if isinstance(email, str) and email.strip():
                        return email.strip().lower()
            return ""

        def _resolve_rep_from_email_hint(email_hint: str) -> str:
            if not email_hint:
                return ""
            resolved = rep_id_by_email.get(email_hint) or ""
            if resolved:
                return alias_to_rep_id.get(resolved, resolved)
            return ""

        def _resolve_rep_from_code_hint(code_hint: str) -> str:
            code = _norm_sales_code(code_hint)
            if not code:
                return ""
            resolved = rep_id_by_sales_code.get(code) or ""
            if resolved:
                return alias_to_rep_id.get(resolved, resolved)
            return ""

        def _resolve_rep_from_initials_hint(initials_hint: str) -> str:
            initials = str(initials_hint or "").strip().upper()
            if not initials:
                return ""
            resolved = rep_id_by_initials.get(initials) or ""
            if resolved:
                return alias_to_rep_id.get(resolved, resolved)
            return ""

        def _resolve_items_list(order: Dict[str, object]) -> List[Dict[str, object]]:
            raw = order.get("items")
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except Exception:
                    raw = None
            if isinstance(raw, list):
                return [item for item in raw if isinstance(item, dict)]
            line_items = order.get("lineItems") or order.get("line_items")
            if isinstance(line_items, list):
                return [item for item in line_items if isinstance(item, dict)]
            return []

        def _resolve_items_subtotal(order: Dict[str, object], items: List[Dict[str, object]]) -> float:
            total_from_items = 0.0
            for item in items:
                qty = _safe_float(item.get("quantity") or item.get("qty") or 0)
                if qty <= 0:
                    continue
                line_total = _safe_float(
                    item.get("subtotal")
                    or item.get("line_total")
                    or item.get("priceTotal")
                    or item.get("price_total")
                    or item.get("total")
                )
                if line_total <= 0:
                    line_total = _safe_float(item.get("price")) * qty
                total_from_items += max(0.0, line_total)
            if total_from_items > 0:
                return total_from_items
            subtotal = _safe_float(
                order.get("itemsSubtotal")
                or order.get("items_subtotal")
                or order.get("itemsTotal")
                or order.get("items_total")
            )
            if subtotal > 0:
                return subtotal
            return 0.0

        local_orders = order_repository.list_for_commission(tracking_window_start_dt, tracking_window_end_dt)
        orders_loaded = len(local_orders)
        for local_order in local_orders:
            if not isinstance(local_order, dict):
                continue
            status = str(local_order.get("status") or "").strip().lower()
            if status not in ("processing", "completed"):
                skipped_status += 1
                if status == "refunded":
                    skipped_refunded += 1
                continue

            created_at = _parse_datetime_utc(local_order.get("createdAt") or local_order.get("created_at"))
            if not created_at:
                skipped_outside_period += 1
                continue
            if created_at < tracking_window_start_dt or created_at > tracking_window_end_dt:
                skipped_outside_period += 1
                continue

            in_report_period = start_dt <= created_at <= end_dt
            in_ytd_period = current_year_start_dt <= created_at <= tracking_window_end_dt
            if not in_report_period and not in_ytd_period:
                skipped_outside_period += 1
                continue

            meta_data = local_order.get("meta_data") or local_order.get("metaData") or local_order.get("meta") or []
            if isinstance(meta_data, str):
                try:
                    meta_data = json.loads(meta_data)
                except Exception:
                    meta_data = []
            if not isinstance(meta_data, list):
                meta_data = []
            if _is_truthy(_meta_value(meta_data, "peppro_refunded")):
                skipped_refunded += 1
                continue

            order_user_id = str(local_order.get("userId") or local_order.get("user_id") or "").strip()
            order_user = user_lookup.get(order_user_id) if order_user_id else None
            order_user_email = _norm_email(order_user.get("email") if isinstance(order_user, dict) else None)
            billing_email = _resolve_order_email(local_order)
            attribution_email = billing_email or order_user_email
            force_house_contact_form = bool(attribution_email and attribution_email in contact_form_emails)

            integrations = local_order.get("integrations") or local_order.get("integrationDetails") or {}
            if isinstance(integrations, str):
                try:
                    integrations = json.loads(integrations)
                except Exception:
                    integrations = {}
            if not isinstance(integrations, dict):
                integrations = {}

            rep_id = _normalize_rep_id(
                local_order.get("doctorSalesRepId")
                or local_order.get("salesRepId")
                or local_order.get("sales_rep_id")
                or local_order.get("doctor_sales_rep_id")
            )
            if not rep_id:
                rep_id = _normalize_rep_id(
                    integrations.get("salesRepId")
                    or integrations.get("sales_rep_id")
                    or integrations.get("doctorSalesRepId")
                    or integrations.get("doctor_sales_rep_id")
                )
            rep_email_hint = _norm_email(
                local_order.get("salesRepEmail")
                or local_order.get("sales_rep_email")
                or local_order.get("doctorSalesRepEmail")
                or local_order.get("doctor_sales_rep_email")
                or integrations.get("salesRepEmail")
                or integrations.get("sales_rep_email")
                or integrations.get("doctorSalesRepEmail")
                or integrations.get("doctor_sales_rep_email")
            )
            rep_code_hint = str(
                local_order.get("salesRepCode")
                or local_order.get("sales_rep_code")
                or local_order.get("doctorSalesRepCode")
                or local_order.get("doctor_sales_rep_code")
                or integrations.get("salesRepCode")
                or integrations.get("sales_rep_code")
                or integrations.get("doctorSalesRepCode")
                or integrations.get("doctor_sales_rep_code")
                or ""
            ).strip()
            rep_initials_hint = str(
                local_order.get("salesRepInitials")
                or local_order.get("sales_rep_initials")
                or local_order.get("doctorSalesRepInitials")
                or local_order.get("doctor_sales_rep_initials")
                or integrations.get("salesRepInitials")
                or integrations.get("sales_rep_initials")
                or integrations.get("doctorSalesRepInitials")
                or integrations.get("doctor_sales_rep_initials")
                or ""
            ).strip()

            meta_rep_id = _normalize_rep_id(
                _meta_value(meta_data, "peppro_sales_rep_id")
                or _meta_value(meta_data, "sales_rep_id")
                or _meta_value(meta_data, "salesRepId")
                or _meta_value(meta_data, "doctor_sales_rep_id")
                or _meta_value(meta_data, "doctorSalesRepId")
            )
            meta_rep_email = _norm_email(
                _meta_value(meta_data, "peppro_sales_rep_email")
                or _meta_value(meta_data, "sales_rep_email")
                or _meta_value(meta_data, "salesRepEmail")
                or _meta_value(meta_data, "doctor_sales_rep_email")
                or _meta_value(meta_data, "doctorSalesRepEmail")
            )
            meta_rep_code = str(
                _meta_value(meta_data, "peppro_sales_rep_code")
                or _meta_value(meta_data, "sales_rep_code")
                or _meta_value(meta_data, "salesRepCode")
                or _meta_value(meta_data, "doctor_sales_rep_code")
                or _meta_value(meta_data, "doctorSalesRepCode")
                or ""
            ).strip()
            meta_rep_initials = str(
                _meta_value(meta_data, "sales_rep_initials")
                or _meta_value(meta_data, "salesRepInitials")
                or _meta_value(meta_data, "doctor_sales_rep_initials")
                or _meta_value(meta_data, "doctorSalesRepInitials")
                or ""
            ).strip()

            if not rep_id and meta_rep_id:
                rep_id = meta_rep_id
                if debug:
                    debug_counts["metaRepId"] += 1
            if not rep_email_hint and meta_rep_email:
                rep_email_hint = meta_rep_email
            if not rep_code_hint and meta_rep_code:
                rep_code_hint = meta_rep_code
            if not rep_initials_hint and meta_rep_initials:
                rep_initials_hint = meta_rep_initials

            rep_id_raw = rep_id
            if rep_id:
                rep_id_candidate = rep_id_raw
                if rep_email_hint:
                    canonical_by_email = rep_id_by_email.get(rep_email_hint) or ""
                    if canonical_by_email:
                        rep_id_candidate = str(canonical_by_email).strip()
                rep_id = alias_to_rep_id.get(rep_id_candidate, rep_id_candidate)
                if rep_email_hint:
                    rep_email_hint_by_rep_id[rep_id_raw] = rep_email_hint
                    rep_email_hint_by_rep_id[rep_id] = rep_email_hint

            if not rep_id and rep_email_hint:
                rep_id = _resolve_rep_from_email_hint(rep_email_hint)
                if rep_id and debug and rep_email_hint == meta_rep_email:
                    debug_counts["metaRepEmail"] += 1
            if not rep_id and rep_code_hint:
                rep_id = _resolve_rep_from_code_hint(rep_code_hint)
                if rep_id and debug:
                    debug_counts["metaRepCode"] += 1
            if not rep_id and rep_initials_hint:
                rep_id = _resolve_rep_from_initials_hint(rep_initials_hint)

            if not rep_id and attribution_email:
                rep_id = str(prospect_rep_by_email.get(attribution_email, "") or "").strip()
                if rep_id:
                    rep_id = alias_to_rep_id.get(rep_id, rep_id)
                    if debug:
                        debug_counts["prospectEmail"] += 1

            if not rep_id and attribution_email:
                rep_id = _resolve_rep_from_email_hint(attribution_email)
                if rep_id and debug:
                    debug_counts["billingEmailIsRep"] += 1

            if not rep_id and (attribution_email or order_user_id):
                user_match = users_by_email.get(attribution_email) if attribution_email else None
                if not user_match and order_user_id:
                    user_match = user_lookup.get(order_user_id)
                if user_match:
                    rep_id = _normalize_rep_id(user_match.get("salesRepId") or user_match.get("sales_rep_id"))
                    if rep_id and debug:
                        debug_counts["userSalesRepId"] += 1
                    if not rep_id and user_match.get("id"):
                        rep_id = str(prospect_rep_by_doctor.get(str(user_match.get("id")), "") or "").strip()
                        if rep_id and debug:
                            debug_counts["prospectDoctorId"] += 1
                    if not rep_id and _normalize_role(user_match.get("role")) in rep_like_roles:
                        rep_id = str(user_match.get("id") or "").strip()
                        if rep_id and debug:
                            debug_counts["userIsRep"] += 1
                    if rep_id:
                        rep_id = alias_to_rep_id.get(rep_id, rep_id)

            if not rep_id:
                doctor = doctors_by_email.get(attribution_email) if attribution_email else None
                if doctor is None and isinstance(order_user, dict) and _normalize_role(order_user.get("role")) in (
                    "doctor",
                    "test_doctor",
                ):
                    doctor = order_user
                rep_id = (
                    _normalize_rep_id((doctor or {}).get("salesRepId") or (doctor or {}).get("sales_rep_id"))
                    if doctor
                    else ""
                )
                if rep_id and debug:
                    debug_counts["doctorSalesRepId"] += 1
                if not rep_id and doctor and doctor.get("id"):
                    rep_id = str(prospect_rep_by_doctor.get(str(doctor.get("id")), "") or "").strip()
                    if rep_id and debug:
                        debug_counts["prospectDoctorId"] += 1
                if rep_id:
                    rep_id = alias_to_rep_id.get(rep_id, rep_id)

            if str(rep_id or "").strip().lower() == "house":
                rep_id = "__house__"

            items = _resolve_items_list(local_order)
            subtotal = _resolve_items_subtotal(local_order, items)
            total = _safe_float(
                local_order.get("total")
                or local_order.get("grandTotal")
                or local_order.get("grand_total")
            )
            pricing_mode_hint = (
                local_order.get("pricingMode")
                or local_order.get("pricing_mode")
                or integrations.get("pricingMode")
                or integrations.get("pricing_mode")
                or _meta_value(meta_data, "peppro_pricing_mode")
                or _meta_value(meta_data, "peppro_pricingMode")
                or _meta_value(meta_data, "pricing_mode")
                or _meta_value(meta_data, "pricingMode")
            )

            tracked_rep_id = rep_id
            if tracked_rep_id and tracked_rep_id != "__house__":
                counted_rep += 1
            else:
                if not tracked_rep_id:
                    skipped_unattributed += 1
                    if force_house_contact_form:
                        tracked_rep_id = "__house__"
                if tracked_rep_id != "__house__":
                    tracked_rep_id = "__house__"
                if debug:
                    debug_counts["fallbackHouse"] += 1
                counted_house += 1

            tracked_orders.append(
                {
                    "salesRepId": tracked_rep_id,
                    "itemsSubtotal": subtotal,
                    "total": total,
                    "wooId": local_order.get("wooOrderId"),
                    "wooNumber": local_order.get("wooOrderNumber") or local_order.get("number"),
                    "orderId": local_order.get("id"),
                    "pricingModeHint": pricing_mode_hint,
                    "createdAt": created_at.isoformat(),
                    "includeInReport": in_report_period,
                    "includeInYtd": in_ytd_period,
                }
            )

            if len(debug_samples) < 10:
                debug_samples.append(
                    {
                        "orderId": local_order.get("id"),
                        "wooId": local_order.get("wooOrderId"),
                        "wooNumber": local_order.get("wooOrderNumber") or local_order.get("number"),
                        "status": status,
                        "repId": tracked_rep_id or None,
                        "metaRepId": meta_rep_id or None,
                        "metaRepEmail": meta_rep_email or None,
                        "billingEmail": billing_email or None,
                        "total": total,
                        "itemsSubtotal": subtotal,
                        "pricingModeHint": pricing_mode_hint,
                    }
                )

            orders_seen += 1

        def _resolve_pricing_mode(entry: Dict[str, object]) -> str:
            hint = str(entry.get("pricingModeHint") or "").strip().lower()
            return "retail" if hint == "retail" else "wholesale"

        def _resolve_order_subtotal(entry: Dict[str, object]) -> float:
            subtotal = _safe_float(entry.get("itemsSubtotal"))
            if subtotal > 0:
                return subtotal
            return _safe_float(entry.get("total"))

        rep_totals: Dict[str, Dict[str, float]] = {}
        house_totals = {"totalOrders": 0.0, "totalRevenue": 0.0, "wholesaleRevenue": 0.0, "retailRevenue": 0.0}
        performance_daily_totals: Dict[str, float] = {}
        performance_daily_orders: Dict[str, int] = {}
        ytd_daily_totals: Dict[str, float] = {}
        ytd_daily_orders: Dict[str, int] = {}
        ytd_revenue_total = 0.0
        ytd_order_count = 0

        for entry in tracked_orders:
            rep_id = str(entry.get("salesRepId") or "").strip()
            total = _resolve_order_subtotal(entry)
            pricing_mode = _resolve_pricing_mode(entry)
            created_at = _parse_datetime_utc(entry.get("createdAt"))
            include_in_report = _is_truthy(entry.get("includeInReport"))
            include_in_ytd = _is_truthy(entry.get("includeInYtd"))
            local_date_key = _local_date_key(created_at) if created_at else None

            if include_in_report:
                if rep_id == "__house__":
                    house_totals["totalOrders"] += 1.0
                    house_totals["totalRevenue"] += total
                    if pricing_mode == "retail":
                        house_totals["retailRevenue"] += total
                    else:
                        house_totals["wholesaleRevenue"] += total
                else:
                    current = rep_totals.get(
                        rep_id,
                        {
                            "totalOrders": 0.0,
                            "totalRevenue": 0.0,
                            "wholesaleRevenue": 0.0,
                            "retailRevenue": 0.0,
                        },
                    )
                    current["totalOrders"] += 1.0
                    current["totalRevenue"] += total
                    if pricing_mode == "retail":
                        current["retailRevenue"] += total
                    else:
                        current["wholesaleRevenue"] += total
                    rep_totals[rep_id] = current

                if local_date_key:
                    performance_daily_totals[local_date_key] = round(
                        float(performance_daily_totals.get(local_date_key) or 0.0) + total,
                        2,
                    )
                    performance_daily_orders[local_date_key] = int(
                        performance_daily_orders.get(local_date_key) or 0
                    ) + 1

            if include_in_ytd:
                ytd_revenue_total = round(ytd_revenue_total + total, 2)
                ytd_order_count += 1
                if local_date_key:
                    ytd_daily_totals[local_date_key] = round(
                        float(ytd_daily_totals.get(local_date_key) or 0.0) + total,
                        2,
                    )
                    ytd_daily_orders[local_date_key] = int(
                        ytd_daily_orders.get(local_date_key) or 0
                    ) + 1

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
        rep_ids_for_summary = set(valid_rep_ids)
        rep_ids_for_summary.update({rid for rid in rep_totals.keys() if rid and rid != "__house__"})
        for rep_id in sorted(rep_ids_for_summary):
            totals = rep_totals.get(
                rep_id,
                {"totalOrders": 0.0, "totalRevenue": 0.0, "wholesaleRevenue": 0.0, "retailRevenue": 0.0},
            )
            rep = rep_lookup.get(rep_id) or user_lookup.get(rep_id) or {}
            rep_record = rep_records.get(rep_id) or {}

            rep_user_id = (
                rep_user_id_by_rep_id.get(rep_id)
                or rep_user_id_by_rep_id.get(str(rep_record.get("id") or "").strip())
                or ""
            )
            if not rep_user_id:
                rep_email_key = _norm_email(rep_record.get("email")) if isinstance(rep_record, dict) else ""
                if rep_email_key and rep_email_key in users_by_email:
                    rep_user_id = str((users_by_email[rep_email_key] or {}).get("id") or "").strip()
            if not rep_user_id:
                canonical_rep_id = alias_to_rep_id.get(rep_id, rep_id)
                rep_user_id = rep_user_id_by_rep_id.get(canonical_rep_id) or ""
            if not rep_user_id and rep_id in user_lookup:
                rep_user_id = rep_id
            # Prefer the linked user's name if available (sales reps edit their own name there).
            user_rec = user_lookup.get(rep_user_id) or {}
            preferred_name = (user_rec.get("name") or "").strip() if isinstance(user_rec, dict) else ""
            legacy_user = None
            legacy_id_raw = rep_record.get("legacyUserId") or rep_record.get("legacy_user_id")
            if legacy_id_raw:
                legacy_id = str(legacy_id_raw).strip()
                legacy_user = user_lookup.get(legacy_id) if legacy_id else None
            legacy_name = (legacy_user.get("name") or "").strip() if isinstance(legacy_user, dict) else ""
            legacy_email = (legacy_user.get("email") or "").strip() if isinstance(legacy_user, dict) else ""
            hinted_email = rep_email_hint_by_rep_id.get(rep_id) or rep_email_hint_by_rep_id.get(str(rep_record.get("id") or "")) or ""
            hinted_user = users_by_email.get(hinted_email) if hinted_email else None
            hinted_name = (hinted_user.get("name") or "").strip() if isinstance(hinted_user, dict) else ""
            hinted_user_email = (hinted_user.get("email") or "").strip() if isinstance(hinted_user, dict) else ""
            preferred_role = _normalize_role(
                (user_rec.get("role") if isinstance(user_rec, dict) else None)
                or (legacy_user.get("role") if isinstance(legacy_user, dict) else None)
                or (hinted_user.get("role") if isinstance(hinted_user, dict) else None)
                or rep.get("role")
                or rep_record.get("role")
                or "sales_rep"
            ) or "sales_rep"
            summary.append(
                {
                    "salesRepId": rep_id,
                    "salesRepUserId": rep_user_id or None,
                    "salesRepName": preferred_name
                    or legacy_name
                    or hinted_name
                    or rep.get("name")
                    or rep_record.get("name")
                    or (f"Sales Rep {rep_id}" if rep_id else "Sales Rep"),
                    # Keep Sales by Rep email strict: only use the sales_rep table value.
                    "salesRepEmail": (
                        str(rep_record.get("email") or "").strip() or None
                    ),
                    "salesRepPhone": rep.get("phone") or rep_record.get("phone"),
                    "role": preferred_role,
                    "isPartner": _normalize_bool(
                        rep_record.get("isPartner")
                        if isinstance(rep_record, dict) and "isPartner" in rep_record
                        else rep_record.get("is_partner")
                    )
                    if isinstance(rep_record, dict)
                    else _normalize_bool(
                        rep.get("isPartner") if isinstance(rep, dict) and "isPartner" in rep else rep.get("is_partner")
                    ),
                    "allowedRetail": _normalize_bool(
                        rep_record.get("allowedRetail")
                        if isinstance(rep_record, dict) and "allowedRetail" in rep_record
                        else rep_record.get("allowed_retail")
                    )
                    if isinstance(rep_record, dict)
                    else _normalize_bool(
                        rep.get("allowedRetail")
                        if isinstance(rep, dict) and "allowedRetail" in rep
                        else rep.get("allowed_retail")
                    ),
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
                    "salesRepName": "House / Unassigned",
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
        performance_series = _build_cumulative_series(
            daily_totals=performance_daily_totals,
            daily_orders=performance_daily_orders,
        )
        year_performance_series = _build_cumulative_series(
            daily_totals=ytd_daily_totals,
            daily_orders=ytd_daily_orders,
            start_date=current_year_start_local.date(),
            end_date=now_local.date(),
        )
        year_projection = _build_year_projection(
            revenue_to_date=ytd_revenue_total,
            order_count=ytd_order_count,
        )
        logger.info(
            "[SalesByRep] Summary computed",
            extra={
                "rows": len(summary),
                "ordersLoaded": orders_loaded,
                "ordersSeen": orders_seen,
                "queryStart": tracking_window_start_dt.isoformat(),
                "queryEnd": tracking_window_end_dt.isoformat(),
                "source": "local_orders_sql",
                "countedRep": counted_rep,
                "countedHouse": counted_house,
                "skippedUnattributed": skipped_unattributed,
                "skippedStatus": skipped_status,
                "skippedRefunded": skipped_refunded,
                "skippedOutsidePeriod": skipped_outside_period,
                "performancePoints": len(performance_series),
                "yearPerformancePoints": len(year_performance_series),
                "yearProjectionRevenue": year_projection.get("projectedYearEndRevenue"),
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
        payload: Dict[str, Any] = {
            "orders": summary,
            "totals": totals_all,
            "performanceSeries": performance_series,
            "yearPerformanceSeries": year_performance_series,
            "yearProjection": year_projection,
            **period_meta,
        }
        if debug:
            payload["debug"] = {"counts": debug_counts, "samples": debug_samples}
        return payload

    now_ms = int(time.time() * 1000)
    cached = None
    inflight_event = None
    with _sales_by_rep_summary_lock:
        cached = _sales_by_rep_summary_cache.get("data")
        expires_at = int(_sales_by_rep_summary_cache.get("expiresAtMs") or 0)
        cache_key = _sales_by_rep_summary_cache.get("key")
        if not force and isinstance(cached, dict) and expires_at > now_ms and cache_key == period_cache_key:
            if exclude_sales_rep_id:
                exclude_id = str(exclude_sales_rep_id)
                rows = cached.get("orders") if isinstance(cached.get("orders"), list) else []
                filtered = [
                    row
                    for row in rows
                    if str((row or {}).get("salesRepId")) != exclude_id
                    and str((row or {}).get("salesRepUserId") or "") != exclude_id
                ]
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
                    filtered = [
                        row
                        for row in rows
                        if str((row or {}).get("salesRepId")) != exclude_id
                        and str((row or {}).get("salesRepUserId") or "") != exclude_id
                    ]
                    return {**cached, "orders": filtered, "stale": True}
                return {**cached, "stale": True}
        # If the leader could not populate cache in time, do not stampede the upstream.
        return {
            "orders": [],
            "totals": {"totalOrders": 0, "totalRevenue": 0.0, "wholesaleRevenue": 0.0, "retailRevenue": 0.0},
            "performanceSeries": _build_cumulative_series(),
            "yearPerformanceSeries": _build_cumulative_series(
                start_date=current_year_start_local.date(),
                end_date=now_local.date(),
            ),
            "yearProjection": _build_year_projection(),
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
            filtered = [
                row
                for row in rows
                if str((row or {}).get("salesRepId")) != exclude_id
                and str((row or {}).get("salesRepUserId") or "") != exclude_id
            ]
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
                    filtered = [
                        row
                        for row in rows
                        if str((row or {}).get("salesRepId")) != exclude_id
                        and str((row or {}).get("salesRepUserId") or "") != exclude_id
                    ]
                    return {**cached, "orders": filtered, "stale": True, "error": "Sales summary is temporarily unavailable."}
                return {**cached, "stale": True, "error": "Sales summary is temporarily unavailable."}
        # No cached data yet; return an empty/stale response instead of a 500.
        return {
            "orders": [],
            "totals": {"totalOrders": 0, "totalRevenue": 0.0},
            "performanceSeries": _build_cumulative_series(),
            "yearPerformanceSeries": _build_cumulative_series(
                start_date=current_year_start_local.date(),
                end_date=now_local.date(),
            ),
            "yearProjection": _build_year_projection(),
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
        bucket: Dict[str, Dict[str, float]] = {}
        order_lines: List[Dict[str, object]] = []
        order_count = 0
        tax_total_all = 0.0

        local_orders = order_repository.list_for_tax_reporting(start_dt, end_dt)
        for local_order in local_orders:
            if not isinstance(local_order, dict):
                continue

            status = str(local_order.get("status") or "").strip().lower()
            if status not in ("processing", "completed"):
                continue

            created_at = _parse_datetime_utc(local_order.get("createdAt"))
            if not created_at:
                continue
            if created_at > end_dt or created_at < start_dt:
                continue

            shipping = local_order.get("shippingAddress") or {}
            billing = local_order.get("billingAddress") or {}
            state_code, state_name = tax_tracking_service.canonicalize_state(
                (shipping or {}).get("state") or (billing or {}).get("state") or "UNKNOWN"
            )

            tax_total = _safe_float(local_order.get("taxTotal"))
            order_count += 1
            tax_total_all += tax_total
            current = bucket.get(state_code) or {"taxTotal": 0.0, "orderCount": 0.0, "stateName": state_name}
            current["taxTotal"] = float(current.get("taxTotal") or 0.0) + float(tax_total or 0.0)
            current["orderCount"] = float(current.get("orderCount") or 0.0) + 1.0
            current["stateName"] = state_name
            bucket[state_code] = current
            order_lines.append(
                {
                    "orderNumber": local_order.get("wooOrderNumber") or local_order.get("wooOrderId") or local_order.get("id"),
                    "wooId": local_order.get("wooOrderId") or local_order.get("id"),
                    "state": state_code,
                    "stateCode": state_code,
                    "stateName": state_name,
                    "status": status,
                    "createdAt": created_at.isoformat(),
                    "taxTotal": round(float(tax_total or 0.0), 2),
                    "taxSource": "local:taxTotal",
                }
            )

        rows = [
            {
                "state": state,
                "stateCode": state,
                "stateName": values.get("stateName") or state,
                "taxTotal": round(float(values.get("taxTotal") or 0.0), 2),
                "orderCount": int(values.get("orderCount") or 0),
            }
            for state, values in bucket.items()
        ]
        rows.sort(key=lambda r: float(r.get("taxTotal") or 0.0), reverse=True)
        # Show math lines for verification: orderNumber -> taxTotal.
        order_lines.sort(key=lambda o: str(o.get("orderNumber") or ""))
        tax_tracking = tax_tracking_service.get_tax_tracking_snapshot()
        result = {
            "rows": rows,
            "totals": {"orderCount": order_count, "taxTotal": round(tax_total_all, 2)},
            "orderTaxes": order_lines,
            "taxTracking": tax_tracking,
            **period_meta,
        }

        now_ms = int(time.time() * 1000)
        with _admin_taxes_by_state_lock:
            _admin_taxes_by_state_cache["data"] = result
            _admin_taxes_by_state_cache["key"] = period_cache_key
            _admin_taxes_by_state_cache["expiresAtMs"] = now_ms + (_ADMIN_TAXES_BY_STATE_TTL_SECONDS * 1000)
        return result
    except Exception as exc:
        # Serve stale cached data if available; otherwise return a stable payload instead of a 503.
        with _admin_taxes_by_state_lock:
            cached = _admin_taxes_by_state_cache.get("data")
            cache_key = _admin_taxes_by_state_cache.get("key")
            if isinstance(cached, dict) and cache_key == period_cache_key:
                logger.warning(
                    "[AdminTaxesByState] Using cached report after failure",
                    exc_info=True,
                    extra={"error": str(exc)},
                )
                return {**cached, "stale": True, "error": "Taxes-by-state report is temporarily unavailable."}
        return {
            "rows": [],
            "totals": {"orderCount": 0, "taxTotal": 0.0},
            **period_meta,
            "stale": True,
            "error": "Taxes-by-state report is temporarily unavailable.",
        }
    finally:
        with _admin_taxes_by_state_lock:
            if _admin_taxes_by_state_inflight is not None:
                try:
                    _admin_taxes_by_state_inflight.set()
                except Exception:
                    pass
            _admin_taxes_by_state_inflight = None


def get_products_and_commission_for_admin(*, period_start: Optional[str] = None, period_end: Optional[str] = None, debug: bool = False) -> Dict:
    """
    For the given period:
      - Count quantity sold per product/sku
      - Compute commissions:
          wholesale: 10% of order item subtotal
          retail: 20% of order item subtotal
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
        rep_like_roles = {"sales_rep", "sales_partner", "rep", "sales_lead", "saleslead"}
        admins = [u for u in users if _normalize_role(u.get("role")) == "admin"]
        reps = [u for u in users if _normalize_role(u.get("role")) in rep_like_roles]
        rep_records_list = sales_rep_repository.get_all()
        report_tz = _get_report_timezone()

        def _norm_email(value: object) -> str:
            return str(value or "").strip().lower()

        rep_lookup_by_id: Dict[str, Dict[str, object]] = {}
        for u in users:
            role = _normalize_role(u.get("role"))
            if role not in rep_like_roles and role != "admin":
                continue
            user_id = str(u.get("id") or "").strip()
            if not user_id:
                continue
            rep_lookup_by_id[user_id] = {
                "id": user_id,
                "name": u.get("name") or u.get("email") or ("Admin" if role == "admin" else "Sales Rep"),
                "email": u.get("email") or None,
                "role": role or ("admin" if role == "admin" else "sales_rep"),
            }
            rep_alias = str(u.get("salesRepId") or u.get("sales_rep_id") or "").strip()
            if rep_alias and rep_alias not in rep_lookup_by_id:
                rep_lookup_by_id[rep_alias] = rep_lookup_by_id[user_id]
        for rep in rep_records_list:
            rep_id = str(rep.get("id") or "").strip()
            if not rep_id:
                continue
            rep_role = _resolve_rep_record_role(rep)
            if rep_role and rep_role not in ("sales_rep", "sales_partner"):
                continue
            rep_lookup_by_id.setdefault(
                rep_id,
                {
                    "id": rep_id,
                    "name": rep.get("name") or rep.get("email") or "Sales Rep",
                    "email": rep.get("email") or None,
                    "role": rep_role or "sales_rep",
                },
            )
            legacy_id = rep.get("legacyUserId") or rep.get("legacy_user_id")
            if legacy_id:
                legacy_str = str(legacy_id).strip()
                if legacy_str and legacy_str not in rep_lookup_by_id:
                    rep_lookup_by_id[legacy_str] = rep_lookup_by_id[rep_id]

        user_rep_id_by_email: Dict[str, str] = {}
        admin_id_by_email: Dict[str, str] = {}
        for rep in reps:
            rep_id = rep.get("id")
            email = _norm_email(rep.get("email"))
            if rep_id and email:
                user_rep_id_by_email[email] = str(rep_id)

        admin_emails = {_norm_email(a.get("email")) for a in admins if _norm_email(a.get("email"))}
        for admin in admins:
            admin_email = _norm_email(admin.get("email"))
            admin_id = admin.get("id")
            if admin_email and admin_id:
                admin_id_by_email[admin_email] = str(admin_id)

        alias_to_rep_id: Dict[str, str] = {}
        for rep in reps:
            rep_id = rep.get("id")
            if rep_id:
                rep_id_str = str(rep_id)
                alias_to_rep_id[rep_id_str] = rep_id_str
            rep_alias = str(rep.get("salesRepId") or rep.get("sales_rep_id") or "").strip()
            if rep_alias and rep_id:
                alias_to_rep_id[rep_alias] = str(rep_id).strip()

        for admin in admins:
            admin_id = admin.get("id")
            if not admin_id:
                continue
            admin_alias = str(admin.get("salesRepId") or admin.get("sales_rep_id") or "").strip()
            if admin_alias:
                alias_to_rep_id[admin_alias] = str(admin_id)

        for rep in rep_records_list:
            rep_id = rep.get("id")
            if not rep_id:
                continue
            rep_id_str = str(rep_id)
            rep_email = _norm_email(rep.get("email"))
            canonical = admin_id_by_email.get(rep_email) or user_rep_id_by_email.get(rep_email) or rep_id_str
            alias_to_rep_id[rep_id_str] = canonical
            legacy_id = rep.get("legacyUserId") or rep.get("legacy_user_id")
            if legacy_id:
                alias_to_rep_id[str(legacy_id)] = canonical

        def _norm_sales_code(value: object) -> str:
            raw = str(value or "").strip()
            if not raw:
                return ""
            return re.sub(r"[^A-Za-z0-9]", "", raw).upper()

        rep_canonical_by_email: Dict[str, str] = {}
        rep_canonical_by_sales_code: Dict[str, str] = {}
        rep_canonical_by_initials: Dict[str, str] = {}
        for rep in rep_records_list:
            rep_id = str(rep.get("id") or "").strip()
            if not rep_id:
                continue
            canonical = alias_to_rep_id.get(rep_id, rep_id)
            rep_email = _norm_email(rep.get("email"))
            if rep_email:
                rep_canonical_by_email.setdefault(rep_email, canonical)
            rep_code = _norm_sales_code(rep.get("salesCode") or rep.get("sales_code"))
            if rep_code:
                rep_canonical_by_sales_code.setdefault(rep_code, canonical)
            rep_initials = str(rep.get("initials") or "").strip().upper()
            if rep_initials:
                rep_canonical_by_initials.setdefault(rep_initials, canonical)

        doctors_by_email = {}
        for u in users:
            if (u.get("role") or "").lower() not in ("doctor", "test_doctor"):
                continue
            email = (u.get("email") or "").strip().lower()
            if email:
                doctors_by_email[email] = u

        # Any order placed by an email present in the MySQL contact-form submissions table should be
        # treated as a house/contact-form order and split across admins.
        contact_form_emails = _load_contact_form_emails_from_mysql()

        recipient_rows: Dict[str, Dict[str, object]] = {}
        for rep in reps:
            rep_id = rep.get("id")
            if not rep_id:
                continue
            recipient_rows[str(rep_id)] = {
                "id": str(rep_id),
                "name": rep.get("name") or "Sales Rep",
                "role": _normalize_role(rep.get("role")) or "sales_rep",
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
            recipient_rows[canonical] = {
                "id": canonical,
                "name": rep.get("name") or "Sales Rep",
                "role": _resolve_rep_record_role(rep),
                "amount": 0.0,
            }
        for admin in admins:
            admin_id = admin.get("id")
            if not admin_id:
                continue
            recipient_rows[str(admin_id)] = {"id": str(admin_id), "name": admin.get("name") or "Admin", "role": "admin", "amount": 0.0}

        supplier_name = str(os.environ.get("COMMISSION_SUPPLIER_NAME") or "Supplier").strip() or "Supplier"
        supplier_row_id = "__supplier__"
        recipient_rows[supplier_row_id] = {"id": supplier_row_id, "name": supplier_name, "role": "supplier", "amount": 0.0}

        admin_ids = [str(a.get("id")) for a in admins if a.get("id")]
        web_dev_commission_rate = 0.03
        web_dev_commission_monthly_cap = 6000.0
        dev_commission_recipient_ids: List[str] = []
        seen_dev_recipient_ids: set[str] = set()
        for user in users:
            user_id = str(user.get("id") or "").strip()
            if not user_id:
                continue
            if not _is_truthy(user.get("devCommission") or user.get("dev_commission")):
                continue
            if user_id in seen_dev_recipient_ids:
                continue
            seen_dev_recipient_ids.add(user_id)
            dev_commission_recipient_ids.append(user_id)
            if user_id not in recipient_rows:
                role = _normalize_role(user.get("role")) or "user"
                recipient_rows[user_id] = {
                    "id": user_id,
                    "name": user.get("name") or user.get("email") or "User",
                    "role": role,
                    "amount": 0.0,
                }

        orders_seen = 0
        product_totals: Dict[str, Dict[str, object]] = {}
        attributed_orders: List[Dict[str, object]] = []
        skipped_status = 0
        skipped_refunded = 0
        skipped_outside_period = 0
        unresolved_recipient_counts: Dict[str, int] = {}
        unresolved_recipient_examples: List[Dict[str, object]] = []

        def _normalize_rep_id(value: object) -> str:
            if value is None:
                return ""
            return str(value).strip()

        def _resolve_order_email(order: Dict[str, object]) -> str:
            for key in (
                "doctorEmail",
                "doctor_email",
                "billingEmail",
                "billing_email",
                "customerEmail",
                "customer_email",
            ):
                candidate = order.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    return candidate.strip().lower()
            billing = order.get("billingAddress") or order.get("billing") or order.get("billing_address") or None
            if isinstance(billing, str):
                try:
                    billing = json.loads(billing)
                except Exception:
                    billing = None
            if isinstance(billing, dict):
                email = billing.get("email")
                if isinstance(email, str) and email.strip():
                    return email.strip().lower()
            shipping = order.get("shippingAddress") or order.get("shipping") or order.get("shipping_address") or None
            if isinstance(shipping, str):
                try:
                    shipping = json.loads(shipping)
                except Exception:
                    shipping = None
            if isinstance(shipping, dict):
                email = shipping.get("email")
                if isinstance(email, str) and email.strip():
                    return email.strip().lower()
            return ""

        def _resolve_rep_from_email_hint(email_hint: str) -> str:
            if not email_hint:
                return ""
            resolved = user_rep_id_by_email.get(email_hint) or admin_id_by_email.get(email_hint) or rep_canonical_by_email.get(email_hint) or ""
            if resolved:
                return alias_to_rep_id.get(resolved, resolved)
            return ""

        def _resolve_rep_from_code_hint(code_hint: str) -> str:
            code = _norm_sales_code(code_hint)
            if not code:
                return ""
            resolved = rep_canonical_by_sales_code.get(code) or ""
            if resolved:
                return alias_to_rep_id.get(resolved, resolved)
            return ""

        def _resolve_rep_from_initials_hint(initials_hint: str) -> str:
            initials = str(initials_hint or "").strip().upper()
            if not initials:
                return ""
            resolved = rep_canonical_by_initials.get(initials) or ""
            if resolved:
                return alias_to_rep_id.get(resolved, resolved)
            return ""

        def _resolve_pricing_mode(entry: Dict[str, object]) -> str:
            hint = str(entry.get("pricingModeHint") or "").strip().lower()
            return "retail" if hint == "retail" else "wholesale"

        def _resolve_items_list(order: Dict[str, object]) -> List[Dict[str, object]]:
            raw = order.get("items")
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except Exception:
                    raw = None
            if isinstance(raw, list):
                return [item for item in raw if isinstance(item, dict)]
            line_items = order.get("lineItems") or order.get("line_items")
            if isinstance(line_items, list):
                return [item for item in line_items if isinstance(item, dict)]
            return []

        def _resolve_order_tax(order: Dict[str, object]) -> float:
            return _safe_float(
                order.get("taxTotal")
                or order.get("tax_total")
                or order.get("totalTax")
                or order.get("total_tax")
            )

        def _resolve_items_subtotal(order: Dict[str, object], items: List[Dict[str, object]]) -> float:
            # IMPORTANT: commission base must be the sum of line items (subtotal), and must never
            # fall back to the order grand total. Some historical payloads/rows stored
            # `itemsSubtotal` incorrectly (sometimes equal to the order total), so when we have
            # items we always compute from items first.
            total_from_items = 0.0
            for item in items:
                qty = _safe_float(item.get("quantity") or item.get("qty") or 0)
                if qty <= 0:
                    continue
                line_total = _safe_float(
                    item.get("subtotal")
                    or item.get("line_total")
                    or item.get("priceTotal")
                    or item.get("price_total")
                    or item.get("total")
                )
                if line_total <= 0:
                    line_total = _safe_float(item.get("price")) * qty
                total_from_items += max(0.0, line_total)
            if total_from_items > 0:
                return total_from_items
            subtotal = _safe_float(
                order.get("itemsSubtotal")
                or order.get("items_subtotal")
                or order.get("itemsTotal")
                or order.get("items_total")
            )
            if subtotal > 0:
                return subtotal
            return 0.0

        orders = order_repository.list_for_commission(start_dt, end_dt)
        orders_seen = len(orders)

        for local_order in orders:
            if not isinstance(local_order, dict):
                continue
            status = str(local_order.get("status") or "").strip().lower()
            if status in ("cancelled", "canceled", "trash", "refunded", "on-hold", "on_hold", "delegation_draft"):
                skipped_status += 1
                if status == "refunded":
                    skipped_refunded += 1
                continue
            created_at = _parse_datetime_utc(local_order.get("createdAt") or local_order.get("created_at"))
            if not created_at:
                skipped_outside_period += 1
                continue
            if created_at < start_dt or created_at > end_dt:
                skipped_outside_period += 1
                continue

            order_user_id = str(local_order.get("userId") or local_order.get("user_id") or "").strip()
            order_user = next((u for u in users if str(u.get("id") or "") == order_user_id), None)
            order_role = _normalize_role(order_user.get("role") if isinstance(order_user, dict) else None)

            billing_email = _resolve_order_email(local_order)
            doctor = None
            order_user_email = _norm_email(order_user.get("email") if isinstance(order_user, dict) else None)
            attribution_email = billing_email or order_user_email
            if attribution_email:
                doctor = doctors_by_email.get(attribution_email)
            if doctor is None and isinstance(order_user, dict) and order_role in ("doctor", "test_doctor"):
                doctor = order_user

            meta_data = local_order.get("meta_data") or local_order.get("metaData") or local_order.get("meta") or []
            if isinstance(meta_data, str):
                try:
                    meta_data = json.loads(meta_data)
                except Exception:
                    meta_data = []
            if not isinstance(meta_data, list):
                meta_data = []

            force_house_contact_form = bool(attribution_email and attribution_email in contact_form_emails)
            contact_form_origin = force_house_contact_form
            if doctor and not contact_form_origin:
                lead_type = str(doctor.get("leadType") or "").strip().lower()
                if lead_type and ("contact" in lead_type or lead_type == "house"):
                    contact_form_origin = True
            if attribution_email and not contact_form_origin:
                try:
                    prospect = sales_prospect_repository.find_by_contact_email(attribution_email)
                    if prospect:
                        prospect_contact_form_id = str(prospect.get("contactFormId") or "").strip()
                        prospect_identifier = str(prospect.get("id") or "")
                        if prospect_contact_form_id or prospect_identifier.startswith("contact_form:"):
                            contact_form_origin = True
                except Exception:
                    contact_form_origin = False
            if attribution_email and not contact_form_origin and doctor and doctor.get("id"):
                try:
                    doctor_prospect = sales_prospect_repository.find_contact_form_by_doctor_id(str(doctor.get("id")))
                    if doctor_prospect:
                        contact_form_origin = True
                except Exception:
                    contact_form_origin = False

            rep_id = _normalize_rep_id(
                local_order.get("doctorSalesRepId")
                or local_order.get("salesRepId")
                or local_order.get("sales_rep_id")
                or local_order.get("doctor_sales_rep_id")
            )
            integrations = local_order.get("integrations") or local_order.get("integrationDetails") or {}
            if isinstance(integrations, str):
                try:
                    integrations = json.loads(integrations)
                except Exception:
                    integrations = {}
            if not rep_id and isinstance(integrations, dict):
                rep_id = _normalize_rep_id(
                    integrations.get("salesRepId")
                    or integrations.get("sales_rep_id")
                    or integrations.get("doctorSalesRepId")
                    or integrations.get("doctor_sales_rep_id")
                )

            rep_email_hint = _norm_email(
                local_order.get("salesRepEmail")
                or local_order.get("sales_rep_email")
                or local_order.get("doctorSalesRepEmail")
                or local_order.get("doctor_sales_rep_email")
                or (integrations.get("salesRepEmail") if isinstance(integrations, dict) else None)
                or (integrations.get("sales_rep_email") if isinstance(integrations, dict) else None)
            )
            rep_code_hint = str(
                local_order.get("salesRepCode")
                or local_order.get("sales_rep_code")
                or local_order.get("doctorSalesRepCode")
                or local_order.get("doctor_sales_rep_code")
                or (integrations.get("salesRepCode") if isinstance(integrations, dict) else None)
                or (integrations.get("sales_rep_code") if isinstance(integrations, dict) else None)
                or ""
            ).strip()
            rep_initials_hint = str(
                local_order.get("salesRepInitials")
                or local_order.get("sales_rep_initials")
                or local_order.get("doctorSalesRepInitials")
                or local_order.get("doctor_sales_rep_initials")
                or (integrations.get("salesRepInitials") if isinstance(integrations, dict) else None)
                or (integrations.get("sales_rep_initials") if isinstance(integrations, dict) else None)
                or ""
            ).strip()

            meta_rep_id = _normalize_rep_id(
                _meta_value(meta_data, "peppro_sales_rep_id")
                or _meta_value(meta_data, "sales_rep_id")
                or _meta_value(meta_data, "salesRepId")
                or _meta_value(meta_data, "doctor_sales_rep_id")
                or _meta_value(meta_data, "doctorSalesRepId")
            )
            meta_rep_email = _norm_email(
                _meta_value(meta_data, "peppro_sales_rep_email")
                or _meta_value(meta_data, "sales_rep_email")
                or _meta_value(meta_data, "salesRepEmail")
                or _meta_value(meta_data, "doctor_sales_rep_email")
                or _meta_value(meta_data, "doctorSalesRepEmail")
            )
            meta_rep_code = str(
                _meta_value(meta_data, "peppro_sales_rep_code")
                or _meta_value(meta_data, "sales_rep_code")
                or _meta_value(meta_data, "salesRepCode")
                or _meta_value(meta_data, "doctor_sales_rep_code")
                or _meta_value(meta_data, "doctorSalesRepCode")
                or ""
            ).strip()
            meta_rep_initials = str(
                _meta_value(meta_data, "sales_rep_initials")
                or _meta_value(meta_data, "salesRepInitials")
                or _meta_value(meta_data, "doctor_sales_rep_initials")
                or _meta_value(meta_data, "doctorSalesRepInitials")
                or ""
            ).strip()

            if not rep_id and meta_rep_id:
                rep_id = meta_rep_id
            if not rep_email_hint and meta_rep_email:
                rep_email_hint = meta_rep_email
            if not rep_code_hint and meta_rep_code:
                rep_code_hint = meta_rep_code
            if not rep_initials_hint and meta_rep_initials:
                rep_initials_hint = meta_rep_initials

            recipient_source = ""

            recipient_id = ""
            if order_user_id and (order_role in rep_like_roles or order_role == "admin"):
                recipient_id = (
                    alias_to_rep_id.get(order_user_id, order_user_id) if order_role in rep_like_roles else order_user_id
                )
                recipient_source = "order_user"
            elif attribution_email and attribution_email in user_rep_id_by_email:
                recipient_id = user_rep_id_by_email[attribution_email]
                recipient_source = "attribution_email_rep"
            elif attribution_email and attribution_email in admin_id_by_email:
                recipient_id = admin_id_by_email[attribution_email]
                recipient_source = "attribution_email_admin"

            # House commission comes from any order whose attribution email appears in the contact-form
            # submissions table. This is an *additional* admin split and should not prevent a rep/admin
            # from earning their normal commission for the same order.
            house_commission = False
            if contact_form_origin and not recipient_id:
                recipient_id = "__house__"
                house_commission = True
                recipient_source = "house_contact_form"
            if force_house_contact_form:
                house_commission = True
                if not recipient_id:
                    recipient_id = "__house__"
                    recipient_source = "house_contact_form_forced"

            if not recipient_id:
                if rep_id:
                    rep_canonical = alias_to_rep_id.get(rep_id) or rep_id
                    if str(rep_canonical or "").strip().lower() == "house":
                        recipient_id = "__house__"
                        recipient_source = "order_rep_id_house"
                    else:
                        recipient_id = rep_canonical
                        recipient_source = "order_rep_id"
                if recipient_id and recipient_id not in ("__house__", supplier_row_id) and not rep_lookup_by_id.get(str(recipient_id)) and rep_email_hint:
                    email_resolved = _resolve_rep_from_email_hint(rep_email_hint)
                    if email_resolved:
                        recipient_id = email_resolved
                        recipient_source = "rep_email_hint"
                if not recipient_id and rep_email_hint:
                    email_resolved = _resolve_rep_from_email_hint(rep_email_hint)
                    if email_resolved:
                        recipient_id = email_resolved
                        recipient_source = "rep_email_hint"
                if not recipient_id and rep_code_hint:
                    code_resolved = _resolve_rep_from_code_hint(rep_code_hint)
                    if code_resolved:
                        recipient_id = code_resolved
                        recipient_source = "rep_code_hint"
                if not recipient_id and rep_initials_hint:
                    initials_resolved = _resolve_rep_from_initials_hint(rep_initials_hint)
                    if initials_resolved:
                        recipient_id = initials_resolved
                        recipient_source = "rep_initials_hint"
                if not recipient_id and doctor:
                    doctor_rep_id = str(doctor.get("salesRepId") or doctor.get("sales_rep_id") or "").strip()
                    if doctor_rep_id:
                        doctor_rep_canonical = alias_to_rep_id.get(doctor_rep_id) or doctor_rep_id
                        if str(doctor_rep_canonical or "").strip().lower() == "house":
                            recipient_id = "__house__"
                            recipient_source = "doctor_rep_id_house"
                        else:
                            recipient_id = doctor_rep_canonical
                            recipient_source = "doctor_rep_id"

            if recipient_id and recipient_id not in ("__house__", supplier_row_id):
                canonical = alias_to_rep_id.get(recipient_id)
                if canonical:
                    recipient_id = canonical

            if recipient_id and recipient_id not in recipient_rows and recipient_id not in ("__house__", supplier_row_id):
                admin = next((a for a in admins if str(a.get("id")) == str(recipient_id)), None)
                rep = rep_lookup_by_id.get(str(recipient_id))
                if admin:
                    recipient_rows[str(recipient_id)] = {
                        "id": str(recipient_id),
                        "name": admin.get("name") or "Admin",
                        "role": "admin",
                        "amount": 0.0,
                    }
                elif rep:
                    recipient_rows[str(recipient_id)] = {
                        "id": str(recipient_id),
                        "name": rep.get("name") or "Sales Rep",
                        "role": rep.get("role") or "sales_rep",
                        "amount": 0.0,
                    }
                else:
                    recipient_rows[str(recipient_id)] = {
                        "id": str(recipient_id),
                        "name": f"User {recipient_id}",
                        "role": "unknown",
                        "amount": 0.0,
                    }
                    if debug and recipient_id:
                        unresolved_recipient_counts[str(recipient_id)] = int(unresolved_recipient_counts.get(str(recipient_id)) or 0) + 1
                        if len(unresolved_recipient_examples) < 25:
                            unresolved_recipient_examples.append(
                                {
                                    "recipientId": str(recipient_id),
                                    "source": recipient_source or "unknown",
                                    "repId": rep_id or None,
                                    "repEmailHint": rep_email_hint or None,
                                    "repCodeHint": rep_code_hint or None,
                                    "repInitialsHint": rep_initials_hint or None,
                                    "attributionEmail": attribution_email or None,
                                    "orderUserId": order_user_id or None,
                                    "orderUserRole": order_role or None,
                                    "doctorId": str(doctor.get("id")) if isinstance(doctor, dict) and doctor.get("id") else None,
                                    "doctorSalesRepId": str(doctor.get("salesRepId") or doctor.get("sales_rep_id") or "").strip() if isinstance(doctor, dict) else None,
                                    "orderNumber": local_order.get("wooOrderNumber") or local_order.get("wooOrderId") or local_order.get("number") or None,
                                    "orderId": local_order.get("id") or None,
                                }
                            )

            items = _resolve_items_list(local_order)

            for item in items:
                qty = int(_safe_float(item.get("quantity") or item.get("qty") or 0))
                if qty <= 0:
                    continue
                sku = str(item.get("sku") or "").strip()
                product_id = item.get("productId") or item.get("product_id") or item.get("id")
                variation_id = item.get("variationId") or item.get("variation_id") or item.get("variantId") or item.get("variation")
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

            items_subtotal = _resolve_items_subtotal(local_order, items)
            total = _safe_float(local_order.get("total"))
            shipping_total = _safe_float(local_order.get("shippingTotal") or local_order.get("shipping_total"))
            tax_total = _resolve_order_tax(local_order)
            pricing_mode_hint = local_order.get("pricingMode") or local_order.get("pricing_mode")

            attributed_orders.append(
                {
                    "recipientId": recipient_id or "",
                    "houseCommission": bool(house_commission),
                    "itemsSubtotal": items_subtotal,
                    "items": items,
                    "total": total,
                    "shippingTotal": shipping_total,
                    "taxTotal": tax_total,
                    "pricingModeHint": pricing_mode_hint,
                    "orderId": local_order.get("id"),
                    "orderNumber": local_order.get("wooOrderNumber")
                    or local_order.get("wooOrderId")
                    or local_order.get("number"),
                    "createdAt": created_at.isoformat() if created_at else None,
                }
            )

        def _add_commission(recipient_id: str, amount: float) -> None:
            row = recipient_rows.get(recipient_id)
            if not row:
                rep = rep_lookup_by_id.get(str(recipient_id))
                if rep:
                    recipient_rows[recipient_id] = {
                        "id": recipient_id,
                        "name": rep.get("name") or "Sales Rep",
                        "role": rep.get("role") or "sales_rep",
                        "amount": 0.0,
                    }
                else:
                    recipient_rows[recipient_id] = {
                        "id": recipient_id,
                        "name": recipient_id,
                        "role": "unknown",
                        "amount": 0.0,
                    }
                    if debug and recipient_id:
                        unresolved_recipient_counts[str(recipient_id)] = int(unresolved_recipient_counts.get(str(recipient_id)) or 0) + 1
                        if len(unresolved_recipient_examples) < 25:
                            unresolved_recipient_examples.append(
                                {
                                    "recipientId": str(recipient_id),
                                    "source": "commission_add",
                                }
                            )
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
        # For dev commission recipients, track commission base by month (report timezone).
        dev_commission_month_base: Dict[str, float] = {}

        def _ensure_stats(recipient_id: str) -> Dict[str, object]:
            row = per_recipient_stats.get(recipient_id)
            if row is None:
                row = {
                    "retailOrders": 0,
                    "wholesaleOrders": 0,
                    "retailBase": 0.0,
                    "wholesaleBase": 0.0,
                    # House/contact-form split stats (per-recipient share).
                    "houseRetailOrders": 0,
                    "houseWholesaleOrders": 0,
                    "houseRetailBase": 0.0,
                    "houseWholesaleBase": 0.0,
                    "houseRetailCommission": 0.0,
                    "houseWholesaleCommission": 0.0,
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

        def _resolve_order_subtotal(entry: Dict[str, object]) -> float:
            """
            Commission base should be the order subtotal (exclude shipping + tax).
            Prefer local `itemsSubtotal` / item totals when available.
            """
            items = entry.get("items")
            total_from_items = 0.0
            if isinstance(items, list):
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    qty = _safe_float(item.get("quantity") or item.get("qty") or 0)
                    if qty <= 0:
                        continue
                    line_total = _safe_float(
                        item.get("subtotal")
                        or item.get("line_total")
                        or item.get("priceTotal")
                        or item.get("price_total")
                        or item.get("total")
                    )
                    if line_total <= 0:
                        line_total = _safe_float(item.get("price")) * qty
                    total_from_items += max(0.0, line_total)
            if total_from_items > 0:
                return total_from_items
            items_subtotal = _safe_float(entry.get("itemsSubtotal"))
            if items_subtotal > 0:
                return items_subtotal
            return 0.0

        order_breakdown: List[Dict[str, object]] = []

        def _allocate_house_commission(*, total_commission: float) -> Dict[str, float]:
            if not admin_ids:
                return {}
            if float(total_commission or 0.0) <= 0:
                return {}
            return _split_amount(total_commission, admin_ids)

        for entry in attributed_orders:
            recipient_id = str(entry.get("recipientId") or "").strip()
            house_commission = bool(entry.get("houseCommission") or False)
            subtotal_value = _resolve_order_subtotal(entry)
            base = max(0.0, subtotal_value)
            if base <= 0:
                continue
            created_at = _parse_datetime_utc(entry.get("createdAt")) if entry.get("createdAt") else None
            if created_at:
                local_dt = created_at.astimezone(report_tz)
                month_key = f"{local_dt.year:04d}-{local_dt.month:02d}"
                dev_commission_month_base[month_key] = float(dev_commission_month_base.get(month_key) or 0.0) + float(base)

            pricing_mode = _resolve_pricing_mode(entry)
            rate = 0.2 if pricing_mode == "retail" else 0.1

            # Primary commission: rep/admin (normal) OR house/unassigned split.
            primary_commission_total = 0.0
            primary_house_allocations: Dict[str, float] = {}
            if recipient_id == "__house__":
                primary_house_allocations = _allocate_house_commission(total_commission=round(base * rate, 2))
                primary_commission_total = round(sum(primary_house_allocations.values()), 2)
            elif recipient_id:
                primary_commission_total = round(base * rate, 2)

            # Additional house commission: split across admins when the order's attribution email is a contact-form email.
            # Do not double-pay if the primary recipient is already the house bucket.
            house_commission_total = 0.0
            house_allocations: Dict[str, float] = {}
            if house_commission and recipient_id != "__house__":
                house_allocations = _allocate_house_commission(total_commission=round(base * rate, 2))
                house_commission_total = round(sum(house_allocations.values()), 2)

            commission = round(primary_commission_total + house_commission_total, 2)
            supplier_share = round(base - commission, 2)
            totals["ordersCounted"] += 1
            totals["commissionableBase"] = round(float(totals["commissionableBase"]) + base, 2)
            totals["commissionTotal"] = round(float(totals["commissionTotal"]) + commission, 2)
            totals["supplierShare"] = round(float(totals["supplierShare"]) + supplier_share, 2)
            if pricing_mode == "retail":
                totals["retailBase"] = round(float(totals["retailBase"]) + base, 2)
            else:
                totals["wholesaleBase"] = round(float(totals["wholesaleBase"]) + base, 2)

            if recipient_id == "__house__":
                for target_id, amount in primary_house_allocations.items():
                    _add_commission(target_id, amount)
                    if primary_commission_total > 0:
                        base_share = base * (amount / primary_commission_total)
                        stats = _ensure_stats(target_id)
                        if pricing_mode == "retail":
                            stats["houseRetailOrders"] = int(stats.get("houseRetailOrders") or 0) + 1
                            stats["houseRetailBase"] = round(float(stats.get("houseRetailBase") or 0.0) + float(base_share or 0.0), 2)
                            stats["houseRetailCommission"] = round(float(stats.get("houseRetailCommission") or 0.0) + float(amount or 0.0), 2)
                        else:
                            stats["houseWholesaleOrders"] = int(stats.get("houseWholesaleOrders") or 0) + 1
                            stats["houseWholesaleBase"] = round(float(stats.get("houseWholesaleBase") or 0.0) + float(base_share or 0.0), 2)
                            stats["houseWholesaleCommission"] = round(float(stats.get("houseWholesaleCommission") or 0.0) + float(amount or 0.0), 2)
            elif recipient_id:
                _add_commission(recipient_id, primary_commission_total)
                _accumulate_stats(recipient_id, pricing_mode=pricing_mode, base=base)

            for target_id, amount in house_allocations.items():
                _add_commission(target_id, amount)
                if house_commission_total > 0:
                    base_share = base * (amount / house_commission_total)
                    stats = _ensure_stats(target_id)
                    if pricing_mode == "retail":
                        stats["houseRetailOrders"] = int(stats.get("houseRetailOrders") or 0) + 1
                        stats["houseRetailBase"] = round(float(stats.get("houseRetailBase") or 0.0) + float(base_share or 0.0), 2)
                        stats["houseRetailCommission"] = round(float(stats.get("houseRetailCommission") or 0.0) + float(amount or 0.0), 2)
                    else:
                        stats["houseWholesaleOrders"] = int(stats.get("houseWholesaleOrders") or 0) + 1
                        stats["houseWholesaleBase"] = round(float(stats.get("houseWholesaleBase") or 0.0) + float(base_share or 0.0), 2)
                        stats["houseWholesaleCommission"] = round(float(stats.get("houseWholesaleCommission") or 0.0) + float(amount or 0.0), 2)

            _add_commission(supplier_row_id, supplier_share)

            order_breakdown.append(
                {
                    "orderNumber": entry.get("orderNumber") or entry.get("orderId"),
                    "orderId": entry.get("orderId"),
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

        # Web developer commission: any user with dev_commission=1 earns 3% on all sales,
        # capped at $6,000 per month (per recipient).
        dev_bonus_by_month: Dict[str, float] = {}
        dev_bonus_base_by_month: Dict[str, float] = {}
        for month_key, month_base in dev_commission_month_base.items():
            month_base_rounded = round(float(month_base or 0.0), 2)
            raw_bonus = round(month_base_rounded * web_dev_commission_rate, 2)
            capped_bonus = min(raw_bonus, web_dev_commission_monthly_cap)
            dev_bonus_by_month[month_key] = capped_bonus
            dev_bonus_base_by_month[month_key] = month_base_rounded
        bonus_total_per_recipient = round(sum(dev_bonus_by_month.values()), 2)
        for recipient_id in dev_commission_recipient_ids:
            if bonus_total_per_recipient <= 0:
                continue
            _add_commission(recipient_id, bonus_total_per_recipient)
            totals["commissionTotal"] = round(float(totals["commissionTotal"]) + bonus_total_per_recipient, 2)
            stats = _ensure_stats(recipient_id)
            stats["specialAdminBonus"] = bonus_total_per_recipient
            stats["specialAdminBonusRate"] = web_dev_commission_rate
            stats["specialAdminBonusMonthlyCap"] = web_dev_commission_monthly_cap
            stats["specialAdminBonusByMonth"] = {
                month_key: round(float(amount or 0.0), 2)
                for month_key, amount in dev_bonus_by_month.items()
            }
            stats["specialAdminBonusBaseByMonth"] = {
                month_key: round(float(amount or 0.0), 2)
                for month_key, amount in dev_bonus_base_by_month.items()
            }

        products = list(product_totals.values())
        products.sort(key=lambda p: int(p.get("quantity") or 0), reverse=True)

        commissions = list(recipient_rows.values())
        commissions.sort(key=lambda r: float(r.get("amount") or 0.0), reverse=True)

        debug_payload: Dict[str, object] = {
            "ordersSeen": orders_seen,
            "skippedStatus": skipped_status,
            "skippedRefunded": skipped_refunded,
            "skippedOutsidePeriod": skipped_outside_period,
        }
        if debug:
            debug_payload["unresolvedRecipientCounts"] = unresolved_recipient_counts
            debug_payload["unresolvedRecipientExamples"] = unresolved_recipient_examples

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
                    "houseRetailOrders": int(per_recipient_stats.get(str(row.get("id")), {}).get("houseRetailOrders") or 0),
                    "houseWholesaleOrders": int(per_recipient_stats.get(str(row.get("id")), {}).get("houseWholesaleOrders") or 0),
                    "houseRetailBase": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("houseRetailBase") or 0.0), 2),
                    "houseWholesaleBase": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("houseWholesaleBase") or 0.0), 2),
                    "houseRetailCommission": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("houseRetailCommission") or 0.0), 2),
                    "houseWholesaleCommission": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("houseWholesaleCommission") or 0.0), 2),
                    "specialAdminBonus": round(float(per_recipient_stats.get(str(row.get("id")), {}).get("specialAdminBonus") or 0.0), 2),
                    "specialAdminBonusRate": float(per_recipient_stats.get(str(row.get("id")), {}).get("specialAdminBonusRate") or 0.0),
                    "specialAdminBonusMonthlyCap": float(per_recipient_stats.get(str(row.get("id")), {}).get("specialAdminBonusMonthlyCap") or 0.0),
                    "specialAdminBonusByMonth": per_recipient_stats.get(str(row.get("id")), {}).get("specialAdminBonusByMonth") or {},
                    "specialAdminBonusBaseByMonth": per_recipient_stats.get(str(row.get("id")), {}).get("specialAdminBonusBaseByMonth") or {},
                }
                for row in commissions
            ],
            "totals": totals,
            "orderBreakdown": order_breakdown,
            "debug": debug_payload,
            **period_meta,
        }

        now_ms = int(time.time() * 1000)
        with _admin_products_commission_lock:
            _admin_products_commission_cache["data"] = result
            _admin_products_commission_cache["key"] = period_cache_key
            _admin_products_commission_cache["expiresAtMs"] = now_ms + (_ADMIN_PRODUCTS_COMMISSION_TTL_SECONDS * 1000)
        return result
    except Exception as exc:
        with _admin_products_commission_lock:
            cached = _admin_products_commission_cache.get("data")
            cache_key = _admin_products_commission_cache.get("key")
            if isinstance(cached, dict) and cache_key == period_cache_key:
                logger.warning(
                    "[AdminProductsCommission] Using cached report after failure",
                    exc_info=True,
                    extra={"error": str(exc)},
                )
                return {
                    **cached,
                    "stale": True,
                    "error": "Product sales commission report is temporarily unavailable.",
                }
        return {
            "products": [],
            "commissions": [],
            "totals": {},
            **period_meta,
            "stale": True,
            "error": "Product sales commission report is temporarily unavailable.",
        }
    finally:
        with _admin_products_commission_lock:
            if _admin_products_commission_inflight is not None:
                try:
                    _admin_products_commission_inflight.set()
                except Exception:
                    pass
            _admin_products_commission_inflight = None
