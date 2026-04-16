from __future__ import annotations

import csv
import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from ..database import mysql_client
from ..repositories import order_repository

logger = logging.getLogger(__name__)

_TAX_TRACKING_TTL_SECONDS = int(os.environ.get("ADMIN_TAX_TRACKING_TTL_SECONDS", "300").strip() or 300)
_TAX_TRACKING_TTL_SECONDS = max(5, min(_TAX_TRACKING_TTL_SECONDS, 300))
_WARNING_RATIO = 0.9
_RULES_PATH = Path(__file__).resolve().parents[2] / "server" / "config" / "tax-tracking-rules.csv"

_tax_tracking_lock = threading.Lock()
_tax_tracking_cache: Dict[str, Any] = {"data": None, "expiresAtMs": 0}

_STATE_CODE_BY_NAME: Dict[str, str] = {
    "Alabama": "AL",
    "Alaska": "AK",
    "Arizona": "AZ",
    "Arkansas": "AR",
    "California": "CA",
    "Colorado": "CO",
    "Connecticut": "CT",
    "Delaware": "DE",
    "Florida": "FL",
    "Georgia": "GA",
    "Hawaii": "HI",
    "Idaho": "ID",
    "Illinois": "IL",
    "Indiana": "IN",
    "Iowa": "IA",
    "Kansas": "KS",
    "Kentucky": "KY",
    "Louisiana": "LA",
    "Maine": "ME",
    "Maryland": "MD",
    "Massachusetts": "MA",
    "Michigan": "MI",
    "Minnesota": "MN",
    "Mississippi": "MS",
    "Missouri": "MO",
    "Montana": "MT",
    "Nebraska": "NE",
    "Nevada": "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    "Ohio": "OH",
    "Oklahoma": "OK",
    "Oregon": "OR",
    "Pennsylvania": "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    "Tennessee": "TN",
    "Texas": "TX",
    "Utah": "UT",
    "Vermont": "VT",
    "Virginia": "VA",
    "Washington": "WA",
    "West Virginia": "WV",
    "Wisconsin": "WI",
    "Wyoming": "WY",
}
_STATE_NAME_BY_CODE: Dict[str, str] = {code: name for name, code in _STATE_CODE_BY_NAME.items()}
_STATE_CODE_BY_UPPER_NAME: Dict[str, str] = {name.upper(): code for name, code in _STATE_CODE_BY_NAME.items()}


def invalidate_tax_tracking_cache() -> None:
    with _tax_tracking_lock:
        _tax_tracking_cache["data"] = None
        _tax_tracking_cache["expiresAtMs"] = 0


def _get_report_timezone():
    name = (os.environ.get("REPORT_TIMEZONE") or "America/Los_Angeles").strip() or "America/Los_Angeles"
    try:
        return ZoneInfo(name)
    except Exception:
        return timezone.utc


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return float(default)
        return float(value)
    except Exception:
        try:
            return float(str(value).strip() or default)
        except Exception:
            return float(default)


def _safe_optional_int(value: object) -> Optional[int]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(round(float(text)))
    except Exception:
        return None


def _parse_bool(value: object) -> bool:
    if value is True:
        return True
    if value is False or value is None:
        return False
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0
        except Exception:
            return False
    return str(value).strip().lower() in ("1", "true", "yes", "y", "on")


def _normalize_text(value: object) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def canonicalize_state(value: object) -> Tuple[str, str]:
    raw = str(value or "").strip()
    if not raw:
        return "UNKNOWN", "Unknown"
    upper = raw.upper()
    if upper in _STATE_NAME_BY_CODE:
        return upper, _STATE_NAME_BY_CODE[upper]
    normalized_name = " ".join(part.capitalize() for part in raw.split())
    code = _STATE_CODE_BY_NAME.get(normalized_name)
    if code:
        return code, normalized_name
    upper_name_code = _STATE_CODE_BY_UPPER_NAME.get(upper)
    if upper_name_code:
        return upper_name_code, _STATE_NAME_BY_CODE[upper_name_code]
    return upper[:16], normalized_name


@lru_cache(maxsize=1)
def _load_rules() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with _RULES_PATH.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for raw in reader:
            state_name = _normalize_text(raw.get("state"))
            if not state_name:
                continue
            state_code = _STATE_CODE_BY_NAME.get(state_name)
            if not state_code:
                logger.warning("Skipping tax tracking rule with unknown state %r", state_name)
                continue
            rows.append(
                {
                    "stateCode": state_code,
                    "stateName": state_name,
                    "economicNexusRevenueUsd": (
                        round(_safe_float(raw.get("economic_nexus_revenue_usd")), 2)
                        if _normalize_text(raw.get("economic_nexus_revenue_usd")) is not None
                        else None
                    ),
                    "economicNexusTransactions": _safe_optional_int(raw.get("economic_nexus_transactions")),
                    "collectTaxDefault": _parse_bool(raw.get("collect_tax_default")),
                    "researchReagentTaxable": _parse_bool(raw.get("research_reagent_taxable")),
                    "universityExemptionAllowed": _parse_bool(raw.get("university_exemption_allowed")),
                    "resaleCertificateAllowed": _parse_bool(raw.get("resale_certificate_allowed")),
                    "wooTaxClass": _normalize_text(raw.get("woo_tax_class")),
                    "notes": _normalize_text(raw.get("notes")),
                    "avgCombinedTaxRate": (
                        round(_safe_float(raw.get("avg_combined_tax_rate")), 5)
                        if _normalize_text(raw.get("avg_combined_tax_rate")) is not None
                        else None
                    ),
                    "exampleTaxOn100kSales": (
                        round(_safe_float(raw.get("example_tax_on_100k_sales")), 2)
                        if _normalize_text(raw.get("example_tax_on_100k_sales")) is not None
                        else None
                    ),
                    "taxCollectionRequiredAfterNexus": _parse_bool(
                        raw.get("tax_collection_required_after_nexus")
                    ),
                    "bufferedTaxRate": (
                        round(_safe_float(raw.get("buffered_tax_rate")), 5)
                        if _normalize_text(raw.get("buffered_tax_rate")) is not None
                        else None
                    ),
                    "exampleTaxOn100kSalesBuffered": (
                        round(_safe_float(raw.get("example_tax_on_100k_sales_buffered")), 2)
                        if _normalize_text(raw.get("example_tax_on_100k_sales_buffered")) is not None
                        else None
                    ),
                }
            )
    return rows


def _parse_datetime_utc(value: object) -> Optional[datetime]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _current_tracking_year() -> int:
    return datetime.now(_get_report_timezone()).year


def _rolling_twelve_month_bounds() -> Tuple[datetime, datetime, int, str, str]:
    end_dt = datetime.now(timezone.utc)
    start_dt = end_dt - timedelta(days=365)
    return start_dt, end_dt, _current_tracking_year(), start_dt.isoformat(), end_dt.isoformat()


def _fetch_trailing_twelve_month_metrics() -> Tuple[Dict[str, Dict[str, Any]], int, str, str]:
    start_dt, end_dt, tracking_year, period_start, period_end = _rolling_twelve_month_bounds()
    bucket: Dict[str, Dict[str, Any]] = {}
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
        state_code, state_name = canonicalize_state(
            (shipping or {}).get("state") or (billing or {}).get("state") or "UNKNOWN"
        )
        total = round(
            max(
                0.0,
                _safe_float(
                    local_order.get("grandTotal")
                    if local_order.get("grandTotal") is not None
                    else local_order.get("total"),
                    0.0,
                ),
            ),
            2,
        )
        current = bucket.get(state_code) or {
            "stateCode": state_code,
            "stateName": state_name,
            "trailing12MonthRevenueUsd": 0.0,
            "trailing12MonthTransactionCount": 0,
        }
        current["trailing12MonthRevenueUsd"] = round(float(current.get("trailing12MonthRevenueUsd") or 0.0) + total, 2)
        current["trailing12MonthTransactionCount"] = int(current.get("trailing12MonthTransactionCount") or 0) + 1
        bucket[state_code] = current

    return bucket, tracking_year, period_start, period_end


def _normalize_woo_tax_class_for_lookup(value: object) -> Optional[str]:
    normalized = str(value or "").strip().lower()
    if normalized in ("", "standard", "none"):
        return None
    return normalized


def _is_threshold_exceeded(metric: object, threshold: object) -> bool:
    try:
        numeric_metric = float(metric)
        numeric_threshold = float(threshold)
    except Exception:
        return False
    return numeric_threshold > 0 and numeric_metric > numeric_threshold


def _is_threshold_warning(metric: object, threshold: object) -> bool:
    try:
        numeric_metric = float(metric)
        numeric_threshold = float(threshold)
    except Exception:
        return False
    if numeric_threshold <= 0 or _is_threshold_exceeded(numeric_metric, numeric_threshold):
        return False
    return (numeric_metric / numeric_threshold) >= _WARNING_RATIO


def _format_sql_datetime(value: object) -> Optional[datetime]:
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except Exception:
            return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def _sync_rules_to_mysql(rules: List[Dict[str, Any]]) -> None:
    if not mysql_client.is_enabled():
        return
    try:
        for rule in rules:
            mysql_client.execute(
                """
                INSERT INTO tax_tracking (
                    state_code,
                    state_name,
                    economic_nexus_revenue_usd,
                    economic_nexus_transactions,
                    collect_tax_default,
                    research_reagent_taxable,
                    university_exemption_allowed,
                    resale_certificate_allowed,
                    woo_tax_class,
                    notes,
                    avg_combined_tax_rate,
                    example_tax_on_100k_sales,
                    tax_collection_required_after_nexus,
                    buffered_tax_rate,
                    example_tax_on_100k_sales_buffered
                ) VALUES (
                    %(stateCode)s,
                    %(stateName)s,
                    %(economicNexusRevenueUsd)s,
                    %(economicNexusTransactions)s,
                    %(collectTaxDefault)s,
                    %(researchReagentTaxable)s,
                    %(universityExemptionAllowed)s,
                    %(resaleCertificateAllowed)s,
                    %(wooTaxClass)s,
                    %(notes)s,
                    %(avgCombinedTaxRate)s,
                    %(exampleTaxOn100kSales)s,
                    %(taxCollectionRequiredAfterNexus)s,
                    %(bufferedTaxRate)s,
                    %(exampleTaxOn100kSalesBuffered)s
                )
                ON DUPLICATE KEY UPDATE
                    state_name = VALUES(state_name),
                    economic_nexus_revenue_usd = VALUES(economic_nexus_revenue_usd),
                    economic_nexus_transactions = VALUES(economic_nexus_transactions),
                    collect_tax_default = VALUES(collect_tax_default),
                    research_reagent_taxable = VALUES(research_reagent_taxable),
                    university_exemption_allowed = VALUES(university_exemption_allowed),
                    resale_certificate_allowed = VALUES(resale_certificate_allowed),
                    woo_tax_class = VALUES(woo_tax_class),
                    notes = VALUES(notes),
                    avg_combined_tax_rate = VALUES(avg_combined_tax_rate),
                    example_tax_on_100k_sales = VALUES(example_tax_on_100k_sales),
                    tax_collection_required_after_nexus = VALUES(tax_collection_required_after_nexus),
                    buffered_tax_rate = VALUES(buffered_tax_rate),
                    example_tax_on_100k_sales_buffered = VALUES(example_tax_on_100k_sales_buffered)
                """,
                rule,
            )
    except Exception:
        logger.warning("Unable to seed tax_tracking rules into MySQL", exc_info=True)


def _fetch_tax_tracking_manual_state_map() -> Dict[str, Dict[str, bool]]:
    if not mysql_client.is_enabled():
        return {}
    try:
        rows = mysql_client.fetch_all(
            """
            SELECT state_code, tax_nexus_applied
            FROM tax_tracking
            """
        )
        result: Dict[str, Dict[str, bool]] = {}
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            state_code = str(row.get("state_code") or "").strip().upper()
            if not state_code:
                continue
            result[state_code] = {
                "taxNexusApplied": bool(row.get("tax_nexus_applied")),
            }
        return result
    except Exception:
        logger.warning("Unable to load manual tax tracking flags from MySQL", exc_info=True)
        return {}


def _sync_metrics_to_mysql(
    rules: List[Dict[str, Any]],
    metrics_by_state: Dict[str, Dict[str, Any]],
    tracking_year: int,
    period_start: str,
    period_end: str,
) -> None:
    if not mysql_client.is_enabled():
        return
    synced_at = _format_sql_datetime(datetime.now(timezone.utc))
    try:
        mysql_client.execute(
            """
            UPDATE tax_tracking
            SET tracking_year = %(trackingYear)s,
                current_year_revenue_usd = 0,
                current_year_order_count = 0,
                last_synced_at = %(lastSyncedAt)s
            """,
            {"trackingYear": tracking_year, "lastSyncedAt": synced_at},
        )
        for rule in rules:
            state_code = str(rule.get("stateCode") or "")
            metrics = metrics_by_state.get(state_code) or {}
            trailing_revenue = round(_safe_float(metrics.get("trailing12MonthRevenueUsd"), 0.0), 2)
            trailing_transactions = int(metrics.get("trailing12MonthTransactionCount") or 0)
            nexus_triggered = (
                _is_threshold_exceeded(trailing_revenue, rule.get("economicNexusRevenueUsd"))
                or _is_threshold_exceeded(trailing_transactions, rule.get("economicNexusTransactions"))
            )

            mysql_client.execute(
                """
                UPDATE tax_tracking
                SET tracking_year = %(trackingYear)s,
                    current_year_revenue_usd = %(currentYearRevenueUsd)s,
                    current_year_order_count = %(currentYearOrderCount)s,
                    last_synced_at = %(lastSyncedAt)s
                WHERE state_code = %(stateCode)s
                """,
                {
                    "trackingYear": tracking_year,
                    "currentYearRevenueUsd": trailing_revenue,
                    "currentYearOrderCount": trailing_transactions,
                    "lastSyncedAt": synced_at,
                    "stateCode": state_code,
                },
            )

            mysql_client.execute(
                """
                INSERT INTO state_sales_totals (
                    state,
                    state_code,
                    trailing_12mo_revenue,
                    transaction_count,
                    nexus_triggered,
                    window_start_at,
                    window_end_at,
                    last_synced_at
                ) VALUES (
                    %(state)s,
                    %(stateCode)s,
                    %(trailingRevenue)s,
                    %(transactionCount)s,
                    %(nexusTriggered)s,
                    %(windowStartAt)s,
                    %(windowEndAt)s,
                    %(lastSyncedAt)s
                )
                ON DUPLICATE KEY UPDATE
                    state = VALUES(state),
                    trailing_12mo_revenue = VALUES(trailing_12mo_revenue),
                    transaction_count = VALUES(transaction_count),
                    nexus_triggered = VALUES(nexus_triggered),
                    window_start_at = VALUES(window_start_at),
                    window_end_at = VALUES(window_end_at),
                    last_synced_at = VALUES(last_synced_at)
                """,
                {
                    "state": rule.get("stateName"),
                    "stateCode": state_code,
                    "trailingRevenue": trailing_revenue,
                    "transactionCount": trailing_transactions,
                    "nexusTriggered": nexus_triggered,
                    "windowStartAt": _format_sql_datetime(period_start),
                    "windowEndAt": _format_sql_datetime(period_end),
                    "lastSyncedAt": synced_at,
                },
            )
    except Exception:
        logger.warning("Unable to persist tax tracking metrics into MySQL", exc_info=True)


def _build_tracking_rows(
    rules: List[Dict[str, Any]],
    metrics_by_state: Dict[str, Dict[str, Any]],
    manual_state_by_code: Dict[str, Dict[str, Any]],
    tracking_year: int,
    period_start: str,
    period_end: str,
) -> Dict[str, Any]:
    rows: List[Dict[str, Any]] = []
    notifications: List[Dict[str, Any]] = []
    warning_count = 0
    exceeded_count = 0
    should_collect_count = 0

    for rule in rules:
        state_code = str(rule.get("stateCode") or "")
        metrics = metrics_by_state.get(state_code) or {}
        trailing_revenue = round(_safe_float(metrics.get("trailing12MonthRevenueUsd"), 0.0), 2)
        trailing_orders = int(metrics.get("trailing12MonthTransactionCount") or 0)
        revenue_threshold = rule.get("economicNexusRevenueUsd")
        transaction_threshold = rule.get("economicNexusTransactions")
        revenue_ratio = (
            round(trailing_revenue / float(revenue_threshold), 4)
            if isinstance(revenue_threshold, (int, float)) and float(revenue_threshold) > 0
            else None
        )
        transaction_ratio = (
            round(trailing_orders / int(transaction_threshold), 4)
            if isinstance(transaction_threshold, int) and int(transaction_threshold) > 0
            else None
        )
        exceeded_reasons = []
        warning_reasons = []
        if _is_threshold_exceeded(trailing_revenue, revenue_threshold):
            exceeded_reasons.append("revenue")
        elif _is_threshold_warning(trailing_revenue, revenue_threshold):
            warning_reasons.append("revenue")
        if _is_threshold_exceeded(trailing_orders, transaction_threshold):
            exceeded_reasons.append("transactions")
        elif _is_threshold_warning(trailing_orders, transaction_threshold):
            warning_reasons.append("transactions")

        nexus_triggered = bool(exceeded_reasons)
        manual_state = manual_state_by_code.get(state_code) or {}
        warning_level = "none"
        if nexus_triggered:
            warning_level = "exceeded"
            exceeded_count += 1
        elif warning_reasons:
            warning_level = "warning"
            warning_count += 1

        should_collect_tax = (
            bool(rule.get("collectTaxDefault"))
            and bool(rule.get("taxCollectionRequiredAfterNexus"))
            and bool(rule.get("researchReagentTaxable"))
            and nexus_triggered
        )
        if should_collect_tax:
            should_collect_count += 1

        row = {
            "state": state_code,
            "stateCode": state_code,
            "stateName": rule.get("stateName"),
            "economicNexusRevenueUsd": revenue_threshold,
            "economicNexusTransactions": transaction_threshold,
            "collectTaxDefault": bool(rule.get("collectTaxDefault")),
            "researchReagentTaxable": bool(rule.get("researchReagentTaxable")),
            "universityExemptionAllowed": bool(rule.get("universityExemptionAllowed")),
            "resaleCertificateAllowed": bool(rule.get("resaleCertificateAllowed")),
            "wooTaxClass": rule.get("wooTaxClass"),
            "notes": rule.get("notes"),
            "avgCombinedTaxRate": rule.get("avgCombinedTaxRate"),
            "exampleTaxOn100kSales": rule.get("exampleTaxOn100kSales"),
            "taxCollectionRequiredAfterNexus": bool(rule.get("taxCollectionRequiredAfterNexus")),
            "bufferedTaxRate": rule.get("bufferedTaxRate"),
            "exampleTaxOn100kSalesBuffered": rule.get("exampleTaxOn100kSalesBuffered"),
            "taxNexusApplied": bool(manual_state.get("taxNexusApplied")),
            "trackingYear": tracking_year,
            "rollingWindowMonths": 12,
            "periodStart": period_start,
            "periodEnd": period_end,
            "trailing12MonthRevenueUsd": trailing_revenue,
            "trailing12MonthTransactionCount": trailing_orders,
            "transactionCount": trailing_orders,
            "currentYearRevenueUsd": trailing_revenue,
            "currentYearOrderCount": trailing_orders,
            "revenueProgressRatio": revenue_ratio,
            "transactionProgressRatio": transaction_ratio,
            "warningLevel": warning_level,
            "warningReasons": warning_reasons,
            "exceededReasons": exceeded_reasons,
            "nexusTriggered": nexus_triggered,
            "shouldCollectTax": should_collect_tax,
        }
        rows.append(row)
        if warning_level != "none":
            notifications.append(row)

    rows.sort(key=lambda item: str(item.get("stateName") or item.get("stateCode") or ""))
    notifications.sort(
        key=lambda item: (
            0 if item.get("warningLevel") == "exceeded" else 1,
            -max(
                float(item.get("revenueProgressRatio") or 0.0),
                float(item.get("transactionProgressRatio") or 0.0),
            ),
            str(item.get("stateName") or item.get("stateCode") or ""),
        )
    )
    return {
        "trackingYear": tracking_year,
        "rollingWindowMonths": 12,
        "periodStart": period_start,
        "periodEnd": period_end,
        "warningThresholdRatio": _WARNING_RATIO,
        "rows": rows,
        "notifications": notifications,
        "summary": {
            "trackedStateCount": len(rows),
            "warningCount": warning_count,
            "exceededCount": exceeded_count,
            "shouldCollectTaxCount": should_collect_count,
        },
        "lastSyncedAt": datetime.now(timezone.utc).isoformat(),
    }


def _build_fallback_state_tax_profile(state_code: str, state_name: str) -> Dict[str, Any]:
    return {
        "state": state_code,
        "stateCode": state_code,
        "stateName": state_name,
        "economicNexusRevenueUsd": None,
        "economicNexusTransactions": None,
        "collectTaxDefault": False,
        "researchReagentTaxable": True,
        "universityExemptionAllowed": True,
        "resaleCertificateAllowed": True,
        "wooTaxClass": None,
        "notes": None,
        "avgCombinedTaxRate": None,
        "exampleTaxOn100kSales": None,
        "taxCollectionRequiredAfterNexus": False,
        "bufferedTaxRate": None,
        "exampleTaxOn100kSalesBuffered": None,
        "taxNexusApplied": False,
        "trailing12MonthRevenueUsd": 0.0,
        "trailing12MonthTransactionCount": 0,
        "transactionCount": 0,
        "currentYearRevenueUsd": 0.0,
        "currentYearOrderCount": 0,
        "revenueProgressRatio": None,
        "transactionProgressRatio": None,
        "warningLevel": "none",
        "warningReasons": [],
        "exceededReasons": [],
        "nexusTriggered": False,
        "shouldCollectTax": False,
        "taxClassForLookup": None,
    }


def _map_mysql_tax_profile(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return None
    state_code = str(row.get("state_code") or "").strip().upper()
    state_name = (
        str(row.get("state_name") or row.get("state") or "").strip()
        or _STATE_NAME_BY_CODE.get(state_code)
        or state_code
    )
    economic_revenue = row.get("economic_nexus_revenue_usd")
    economic_transactions = row.get("economic_nexus_transactions")
    trailing_revenue = round(_safe_float(row.get("trailing_12mo_revenue"), 0.0), 2)
    trailing_transactions = int(row.get("transaction_count") or 0)
    nexus_triggered = bool(row.get("nexus_triggered"))
    revenue_ratio = (
        round(trailing_revenue / float(economic_revenue), 4)
        if isinstance(economic_revenue, (int, float)) and float(economic_revenue) > 0
        else None
    )
    transaction_ratio = (
        round(trailing_transactions / int(economic_transactions), 4)
        if isinstance(economic_transactions, int) and int(economic_transactions) > 0
        else None
    )
    exceeded_reasons: List[str] = []
    warning_reasons: List[str] = []
    if _is_threshold_exceeded(trailing_revenue, economic_revenue):
        exceeded_reasons.append("revenue")
    elif _is_threshold_warning(trailing_revenue, economic_revenue):
        warning_reasons.append("revenue")
    if _is_threshold_exceeded(trailing_transactions, economic_transactions):
        exceeded_reasons.append("transactions")
    elif _is_threshold_warning(trailing_transactions, economic_transactions):
        warning_reasons.append("transactions")
    return {
        "state": state_code,
        "stateCode": state_code,
        "stateName": state_name,
        "economicNexusRevenueUsd": round(_safe_float(economic_revenue), 2) if economic_revenue is not None else None,
        "economicNexusTransactions": int(economic_transactions) if economic_transactions is not None else None,
        "collectTaxDefault": bool(row.get("collect_tax_default")),
        "researchReagentTaxable": bool(row.get("research_reagent_taxable")),
        "universityExemptionAllowed": bool(row.get("university_exemption_allowed")),
        "resaleCertificateAllowed": bool(row.get("resale_certificate_allowed")),
        "wooTaxClass": _normalize_text(row.get("woo_tax_class")),
        "notes": _normalize_text(row.get("notes")),
        "avgCombinedTaxRate": round(_safe_float(row.get("avg_combined_tax_rate")), 5)
        if row.get("avg_combined_tax_rate") is not None
        else None,
        "exampleTaxOn100kSales": round(_safe_float(row.get("example_tax_on_100k_sales")), 2)
        if row.get("example_tax_on_100k_sales") is not None
        else None,
        "taxCollectionRequiredAfterNexus": bool(row.get("tax_collection_required_after_nexus")),
        "bufferedTaxRate": round(_safe_float(row.get("buffered_tax_rate")), 5)
        if row.get("buffered_tax_rate") is not None
        else None,
        "exampleTaxOn100kSalesBuffered": round(
            _safe_float(row.get("example_tax_on_100k_sales_buffered")), 2
        )
        if row.get("example_tax_on_100k_sales_buffered") is not None
        else None,
        "taxNexusApplied": bool(row.get("tax_nexus_applied")),
        "trailing12MonthRevenueUsd": trailing_revenue,
        "trailing12MonthTransactionCount": trailing_transactions,
        "transactionCount": trailing_transactions,
        "currentYearRevenueUsd": trailing_revenue,
        "currentYearOrderCount": trailing_transactions,
        "revenueProgressRatio": revenue_ratio,
        "transactionProgressRatio": transaction_ratio,
        "warningLevel": "exceeded" if nexus_triggered else ("warning" if warning_reasons else "none"),
        "warningReasons": warning_reasons,
        "exceededReasons": exceeded_reasons,
        "nexusTriggered": nexus_triggered,
        "shouldCollectTax": bool(row.get("collect_tax_default"))
        and bool(row.get("tax_collection_required_after_nexus"))
        and bool(row.get("research_reagent_taxable"))
        and nexus_triggered,
        "taxClassForLookup": _normalize_woo_tax_class_for_lookup(row.get("woo_tax_class")),
        "lastSyncedAt": (
            row.get("last_synced_at").replace(tzinfo=timezone.utc).isoformat()
            if isinstance(row.get("last_synced_at"), datetime)
            else _normalize_text(row.get("last_synced_at"))
        ),
    }


def get_tax_tracking_snapshot(*, force: bool = False) -> Dict[str, Any]:
    now_ms = int(time.time() * 1000)
    with _tax_tracking_lock:
        cached = _tax_tracking_cache.get("data")
        expires_at = int(_tax_tracking_cache.get("expiresAtMs") or 0)
        if not force and isinstance(cached, dict) and expires_at > now_ms:
            return cached

    rules = _load_rules()
    try:
        metrics_by_state, tracking_year, period_start, period_end = _fetch_trailing_twelve_month_metrics()
        _sync_rules_to_mysql(rules)
        _sync_metrics_to_mysql(rules, metrics_by_state, tracking_year, period_start, period_end)
        manual_state_by_code = _fetch_tax_tracking_manual_state_map()
        snapshot = _build_tracking_rows(
            rules,
            metrics_by_state,
            manual_state_by_code,
            tracking_year,
            period_start,
            period_end,
        )
    except Exception:
        logger.warning("Failed to build tax tracking snapshot", exc_info=True)
        with _tax_tracking_lock:
            cached = _tax_tracking_cache.get("data")
            if isinstance(cached, dict):
                return {**cached, "stale": True}
        _start_dt, _end_dt, tracking_year, period_start, period_end = _rolling_twelve_month_bounds()
        snapshot = {
            **_build_tracking_rows(rules, {}, {}, tracking_year, period_start, period_end),
            "stale": True,
        }

    now_ms = int(time.time() * 1000)
    with _tax_tracking_lock:
        _tax_tracking_cache["data"] = snapshot
        _tax_tracking_cache["expiresAtMs"] = now_ms + (_TAX_TRACKING_TTL_SECONDS * 1000)
    return snapshot


def get_state_tax_profile(state: object, *, force: bool = False) -> Dict[str, Any]:
    state_code, state_name = canonicalize_state(state)
    if not state_code or state_code == "UNKNOWN":
        return _build_fallback_state_tax_profile(state_code, state_name)

    if mysql_client.is_enabled():
        try:
            row = mysql_client.fetch_one(
                """
                SELECT
                    tt.state_code,
                    tt.state_name,
                    tt.economic_nexus_revenue_usd,
                    tt.economic_nexus_transactions,
                    tt.collect_tax_default,
                    tt.research_reagent_taxable,
                    tt.university_exemption_allowed,
                    tt.resale_certificate_allowed,
                    tt.woo_tax_class,
                    tt.notes,
                    tt.avg_combined_tax_rate,
                    tt.example_tax_on_100k_sales,
                    tt.tax_collection_required_after_nexus,
                    tt.buffered_tax_rate,
                    tt.example_tax_on_100k_sales_buffered,
                    tt.tax_nexus_applied,
                    st.state,
                    st.trailing_12mo_revenue,
                    st.transaction_count,
                    st.nexus_triggered,
                    st.last_synced_at
                FROM tax_tracking tt
                LEFT JOIN state_sales_totals st
                  ON st.state_code = tt.state_code
                WHERE tt.state_code = %(stateCode)s
                LIMIT 1
                """,
                {"stateCode": state_code},
            )
            mapped = _map_mysql_tax_profile(row)
            if mapped:
                return mapped
        except Exception:
            logger.warning("Failed to load state tax profile from MySQL", exc_info=True)

    snapshot = get_tax_tracking_snapshot(force=force)
    rows = snapshot.get("rows") if isinstance(snapshot, dict) else []
    if isinstance(rows, list):
        for row in rows:
            if not isinstance(row, dict):
                continue
            candidate_code = str(row.get("stateCode") or row.get("state") or "").strip().upper()
            if candidate_code == state_code:
                return {
                    **row,
                    "taxClassForLookup": _normalize_woo_tax_class_for_lookup(row.get("wooTaxClass")),
                }
    return _build_fallback_state_tax_profile(state_code, state_name)


def set_tax_nexus_applied(state: object, tax_nexus_applied: bool) -> Dict[str, Any]:
    state_code, state_name = canonicalize_state(state)
    if not state_code or state_code == "UNKNOWN" or state_code not in _STATE_NAME_BY_CODE:
        raise ValueError("A valid US state is required")
    if not mysql_client.is_enabled():
        raise RuntimeError("MySQL is required to update tax nexus filing status")

    _sync_rules_to_mysql(_load_rules())
    mysql_client.execute(
        """
        INSERT INTO tax_tracking (
            state_code,
            state_name,
            tax_nexus_applied
        )
        VALUES (
            %(stateCode)s,
            %(stateName)s,
            %(taxNexusApplied)s
        )
        ON DUPLICATE KEY UPDATE
            state_name = VALUES(state_name),
            tax_nexus_applied = VALUES(tax_nexus_applied),
            updated_at = CURRENT_TIMESTAMP
        """,
        {
            "stateCode": state_code,
            "stateName": state_name,
            "taxNexusApplied": 1 if tax_nexus_applied else 0,
        },
    )
    invalidate_tax_tracking_cache()
    row = get_state_tax_profile(state_code, force=True)
    return {
        "state": state_code,
        "stateCode": state_code,
        "stateName": state_name,
        "taxNexusApplied": bool(row.get("taxNexusApplied")),
        "row": row,
    }
