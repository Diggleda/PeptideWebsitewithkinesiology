from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..integrations import ups_tracking
from ..repositories import order_repository
from . import background_job_supervisor, shipping_notification_service

logger = logging.getLogger(__name__)
_JOB_NAME = "upsStatusSync"

_THREAD_STARTED = False
_THREAD_LOCK = threading.Lock()
_INITIAL_BACKFILL_STARTED = False

_SYNC_LOCK = threading.Lock()
_IN_FLIGHT = False

_STATE: Dict[str, Any] = {
    "lastStartedAt": None,
    "lastFinishedAt": None,
    "lastResult": None,
    "lastError": None,
}

_LAST_RUN_SETTINGS_KEY = "upsStatusSyncLastRunAt"
_LEASE_SETTINGS_KEY = "upsStatusSyncLease"


def _enabled() -> bool:
    raw = str(os.environ.get("UPS_STATUS_SYNC_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _mode() -> str:
    # "thread" (default): run inside the web process.
    # "external": do not start automatically in the web process; expect a dedicated runner.
    return str(os.environ.get("UPS_STATUS_SYNC_MODE", "thread")).strip().lower() or "thread"


def _interval_seconds() -> int:
    raw_ms = str(os.environ.get("UPS_STATUS_SYNC_INTERVAL_MS", "") or "").strip()
    if raw_ms:
        try:
            ms = int(raw_ms)
        except Exception:
            ms = 300_000
        return max(60, min(int(ms / 1000), 3600))

    raw = str(os.environ.get("UPS_STATUS_SYNC_INTERVAL_SECONDS", "300")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 300
    return max(60, min(value, 3600))


def _lookback_days() -> int:
    raw = str(os.environ.get("UPS_STATUS_SYNC_LOOKBACK_DAYS", "60")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 60
    return max(1, min(value, 180))


def _max_orders() -> int:
    raw = str(os.environ.get("UPS_STATUS_SYNC_MAX_ORDERS", "50")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 50
    return max(1, min(value, 500))


def _lease_seconds() -> int:
    raw = str(os.environ.get("UPS_STATUS_SYNC_LEASE_SECONDS", "300")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 300
    return max(30, min(value, 3600))


def _throttle_ms() -> int:
    raw = str(os.environ.get("UPS_STATUS_SYNC_THROTTLE_MS", "150")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 150
    return max(0, min(value, 2000))


def _max_runtime_seconds() -> int:
    raw = str(os.environ.get("UPS_STATUS_SYNC_MAX_RUNTIME_SECONDS", "45")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 45
    return max(10, min(value, 15 * 60))


def _startup_passes() -> int:
    raw = str(os.environ.get("UPS_STATUS_SYNC_STARTUP_PASSES", "2")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 2
    return max(1, min(value, 10))


def _parse_settings_json_value(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (bytes, bytearray)):
        try:
            raw = raw.decode("utf-8")
        except Exception:
            return None
    if isinstance(raw, str):
        text = raw.strip()
        if not text or text == "null":
            return None
        if (text.startswith('"') and text.endswith('"')) or text.startswith("{") or text.startswith("["):
            try:
                return json.loads(text)
            except Exception:
                return text
        return text
    return raw


def _parse_iso_utc(value: Any) -> Optional[datetime]:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(normalized)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except Exception:
        return None


def _try_acquire_lease(*, lease_seconds: int) -> Optional[str]:
    token = f"{os.getpid()}:{int(time.time() * 1000)}:{secrets.token_urlsafe(8)}"
    try:
        mysql_client.execute(
            """
            INSERT INTO settings (`key`, value_json, updated_at)
            VALUES (%(key)s, %(value)s, NOW())
            ON DUPLICATE KEY UPDATE
              value_json = IF(
                updated_at < DATE_SUB(NOW(), INTERVAL %(lease_seconds)s SECOND),
                VALUES(value_json),
                value_json
              ),
              updated_at = IF(
                updated_at < DATE_SUB(NOW(), INTERVAL %(lease_seconds)s SECOND),
                NOW(),
                updated_at
              )
            """,
            {"key": _LEASE_SETTINGS_KEY, "value": json.dumps(token), "lease_seconds": int(lease_seconds)},
        )
        row = mysql_client.fetch_one(
            "SELECT value_json FROM settings WHERE `key` = %(key)s",
            {"key": _LEASE_SETTINGS_KEY},
        )
        stored = _parse_settings_json_value((row or {}).get("value_json"))
        if stored == token:
            return token
    except Exception:
        return None
    return None


def _release_lease(token: str, *, lease_seconds: int) -> None:
    if not token:
        return
    try:
        mysql_client.execute(
            """
            UPDATE settings
            SET updated_at = DATE_SUB(NOW(), INTERVAL %(lease_seconds)s SECOND)
            WHERE `key` = %(key)s AND value_json = %(value)s
            """,
            {"key": _LEASE_SETTINGS_KEY, "value": json.dumps(token), "lease_seconds": int(lease_seconds)},
        )
    except Exception:
        return


def _get_last_run_at() -> Optional[datetime]:
    try:
        row = mysql_client.fetch_one(
            "SELECT value_json FROM settings WHERE `key` = %(key)s",
            {"key": _LAST_RUN_SETTINGS_KEY},
        )
        raw = _parse_settings_json_value((row or {}).get("value_json"))
        return _parse_iso_utc(raw)
    except Exception:
        return None


def _set_last_run_at(value: datetime) -> None:
    try:
        stamp = value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        mysql_client.execute(
            """
            INSERT INTO settings (`key`, value_json, updated_at)
            VALUES (%(key)s, %(value)s, NOW())
            ON DUPLICATE KEY UPDATE
              value_json = VALUES(value_json),
              updated_at = NOW()
            """,
            {"key": _LAST_RUN_SETTINGS_KEY, "value": json.dumps(stamp)},
        )
    except Exception:
        return


def _normalize_text(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_optional_text(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _normalize_ups_status(value: Any) -> Optional[str]:
    normalized = ups_tracking.normalize_tracking_status(value)
    if not normalized or normalized == "unknown":
        return None
    return normalized


def _parse_order_datetime(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
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
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _extract_estimated_arrival_date(order: Dict[str, Any]) -> Optional[str]:
    estimate = order.get("shippingEstimate")
    if not isinstance(estimate, dict):
        return None
    for candidate in (
        estimate.get("estimatedArrivalDate"),
        estimate.get("estimated_arrival_date"),
        estimate.get("deliveryDateGuaranteed"),
        estimate.get("delivery_date_guaranteed"),
    ):
        normalized = _normalize_optional_text(candidate)
        if normalized:
            return normalized
    return None


def _extract_delivery_date_guaranteed(order: Dict[str, Any]) -> Optional[str]:
    estimate = order.get("shippingEstimate")
    if not isinstance(estimate, dict):
        return None
    for candidate in (
        estimate.get("deliveryDateGuaranteed"),
        estimate.get("delivery_date_guaranteed"),
        estimate.get("estimatedArrivalDate"),
        estimate.get("estimated_arrival_date"),
    ):
        normalized = _normalize_optional_text(candidate)
        if normalized:
            return normalized
    return None


def _extract_expected_shipment_window(order: Dict[str, Any]) -> Optional[str]:
    for candidate in (
        order.get("expectedShipmentWindow"),
        order.get("expected_shipment_window"),
    ):
        normalized = _normalize_optional_text(candidate)
        if normalized:
            return normalized
    return None


def _extract_persisted_delivery_date(order: Dict[str, Any]) -> Optional[str]:
    for candidate in (
        order.get("delivery_date"),
    ):
        normalized = _normalize_optional_text(candidate)
        if normalized:
            return normalized
    return None


def _normalize_timestamp_like_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    text = _normalize_optional_text(value)
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


def _extract_known_delivery_date(order: Dict[str, Any]) -> Optional[str]:
    estimate = order.get("shippingEstimate")
    for candidate in (
        order.get("expectedShipmentWindow"),
        order.get("expected_shipment_window"),
        (estimate.get("deliveryDateGuaranteed") if isinstance(estimate, dict) else None),
        (estimate.get("delivery_date_guaranteed") if isinstance(estimate, dict) else None),
        (estimate.get("estimatedArrivalDate") if isinstance(estimate, dict) else None),
        (estimate.get("estimated_arrival_date") if isinstance(estimate, dict) else None),
        (estimate.get("deliveredAt") if isinstance(estimate, dict) else None),
        (estimate.get("delivered_at") if isinstance(estimate, dict) else None),
        order.get("deliveryDate"),
        order.get("delivery_date"),
        order.get("upsDeliveredAt"),
    ):
        normalized = _normalize_optional_text(candidate)
        if normalized:
            return normalized
    return None


def _extract_known_delivered_at(order: Dict[str, Any]) -> Optional[str]:
    estimate = order.get("shippingEstimate")
    for candidate in (
        (estimate.get("deliveredAt") if isinstance(estimate, dict) else None),
        (estimate.get("delivered_at") if isinstance(estimate, dict) else None),
        order.get("upsDeliveredAt"),
    ):
        normalized = _normalize_optional_text(candidate)
        if normalized:
            return normalized
    delivered_status = _normalize_ups_status(
        order.get("upsTrackingStatus")
        if order.get("upsTrackingStatus") is not None
        else order.get("ups_tracking_status") or (estimate.get("status") if isinstance(estimate, dict) else None)
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


def _resolve_known_delivery_date_value(
    *,
    delivered_at: Optional[str] = None,
    estimated_arrival_date: Optional[str] = None,
    delivery_date_guaranteed: Optional[str] = None,
    expected_shipment_window: Optional[str] = None,
) -> Optional[str]:
    return (
        _normalize_optional_text(expected_shipment_window)
        or _normalize_optional_text(delivery_date_guaranteed)
        or _normalize_optional_text(estimated_arrival_date)
        or _normalize_optional_text(delivered_at)
    )


def _is_hand_delivery_order(order: Dict[str, Any]) -> bool:
    if order.get("handDelivery") is True:
        return True
    candidates = [
        order.get("shippingService"),
        order.get("fulfillmentMethod"),
        order.get("fulfillment_method"),
    ]
    estimate = order.get("shippingEstimate")
    if isinstance(estimate, dict):
        candidates.extend(
            [
                estimate.get("serviceType"),
                estimate.get("serviceCode"),
                estimate.get("carrierId"),
            ]
        )
    normalized = {str(value or "").strip().lower() for value in candidates if str(value or "").strip()}
    return bool(
        {
            "hand delivery",
            "hand delivered",
            "hand_delivery",
            "hand_delivered",
            "hand-delivery",
            "hand-delivered",
            "local hand delivery",
            "local_hand_delivery",
            "local_delivery",
            "facility_pickup",
            "fascility_pickup",
        }
        & normalized
    )


def _is_ups_order(order: Dict[str, Any]) -> bool:
    tracking_number = order.get("trackingNumber") or order.get("tracking_number")
    if ups_tracking.looks_like_ups_tracking_number(tracking_number):
        return True

    candidates = [
        order.get("shippingCarrier"),
        order.get("shipping_carrier"),
    ]
    estimate = order.get("shippingEstimate")
    if isinstance(estimate, dict):
        candidates.extend(
            [
                estimate.get("carrierId"),
                estimate.get("carrier_id"),
            ]
        )
    integrations = order.get("integrationDetails") or order.get("integrations") or {}
    if isinstance(integrations, dict):
        shipstation = integrations.get("shipStation") or integrations.get("shipstation") or {}
        if isinstance(shipstation, dict):
            candidates.append(shipstation.get("carrierCode"))

    normalized = {str(value or "").strip().lower() for value in candidates if str(value or "").strip()}
    return "ups" in normalized


def _is_terminal_local_status(value: Any) -> bool:
    return _normalize_text(value) in ("cancelled", "canceled", "trash", "refunded", "failed")


def _fetch_orders_for_sync(*, lookback_days: int, max_orders: int) -> List[Dict[str, Any]]:
    scan_limit = max(max_orders * 5, 100)
    scan_limit = min(scan_limit, 1000)
    recent_orders = order_repository.list_recent(scan_limit)
    cutoff = datetime.now(timezone.utc) - timedelta(days=lookback_days)

    selected: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for order in recent_orders or []:
        if not isinstance(order, dict):
            continue
        order_id = str(order.get("id") or "").strip()
        if not order_id or order_id in seen:
            continue
        seen.add(order_id)

        created_at = _parse_order_datetime(order.get("createdAt") or order.get("created_at"))
        if created_at and created_at < cutoff:
            continue
        if _is_hand_delivery_order(order):
            continue
        if _is_terminal_local_status(order.get("status")):
            continue
        if (
            _normalize_ups_status(order.get("upsTrackingStatus") or order.get("ups_tracking_status")) == "delivered"
            and _extract_persisted_delivery_date(order)
        ):
            continue
        tracking_number = order.get("trackingNumber") or order.get("tracking_number")
        if not tracking_number or not _is_ups_order(order):
            continue
        selected.append(order)
        if len(selected) >= max_orders:
            break
    return selected


def get_status() -> Dict[str, Any]:
    return {
        **background_job_supervisor.get_job_status(_JOB_NAME),
        **_STATE,
        "inFlight": _IN_FLIGHT,
        "enabled": _enabled(),
        "configured": ups_tracking.is_configured(),
        "intervalSeconds": _interval_seconds(),
        "lookbackDays": _lookback_days(),
        "maxOrders": _max_orders(),
        "leaseSeconds": _lease_seconds(),
        "throttleMs": _throttle_ms(),
        "maxRuntimeSeconds": _max_runtime_seconds(),
    }


def run_sync_once(*, ignore_cooldown: bool = False) -> Dict[str, Any]:
    global _IN_FLIGHT

    if not _enabled():
        result = {"status": "skipped", "reason": "disabled"}
        _STATE["lastResult"] = result
        return result
    if not ups_tracking.is_configured():
        result = {"status": "skipped", "reason": "ups_not_configured"}
        _STATE["lastResult"] = result
        return result

    with _SYNC_LOCK:
        if _IN_FLIGHT:
            result = {"status": "skipped", "reason": "in_flight"}
            _STATE["lastResult"] = result
            return result
        _IN_FLIGHT = True

    _STATE["lastStartedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    _STATE["lastFinishedAt"] = None
    _STATE["lastError"] = None

    started = time.time()
    processed = 0
    updated = 0
    missing = 0
    failed = 0
    stopped_early = False

    try:
        have_mysql = True
        lease_seconds = _lease_seconds()
        lease_token: Optional[str] = None
        try:
            lease_token = _try_acquire_lease(lease_seconds=lease_seconds)
            if not lease_token:
                result = {"status": "skipped", "reason": "lease_busy", "leaseSeconds": lease_seconds}
                _STATE["lastFinishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                _STATE["lastResult"] = result
                return result
        except Exception:
            have_mysql = False

        interval = _interval_seconds()
        if have_mysql and not ignore_cooldown:
            try:
                last_run = _get_last_run_at()
                now = datetime.now(timezone.utc)
                if last_run and (now - last_run).total_seconds() < float(interval):
                    result = {
                        "status": "skipped",
                        "reason": "cooldown",
                        "intervalSeconds": interval,
                        "secondsSinceLastRun": int((now - last_run).total_seconds()),
                    }
                    _STATE["lastFinishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                    _STATE["lastResult"] = result
                    return result
            except Exception:
                pass

        if have_mysql:
            try:
                _set_last_run_at(datetime.now(timezone.utc))
            except Exception:
                pass

        lookback_days = _lookback_days()
        max_orders = _max_orders()
        max_runtime = float(_max_runtime_seconds())
        throttle_ms = int(_throttle_ms())
        orders = _fetch_orders_for_sync(lookback_days=lookback_days, max_orders=max_orders)

        logger.info(
            "[ups-status-sync] starting",
            extra={"lookbackDays": lookback_days, "maxOrders": max_orders, "candidateOrders": len(orders)},
        )

        for order in orders:
            if time.time() - started >= max_runtime:
                stopped_early = True
                break
            if not isinstance(order, dict):
                continue
            order_id = str(order.get("id") or "").strip()
            tracking_number = str(order.get("trackingNumber") or order.get("tracking_number") or "").strip()
            if not order_id or not tracking_number:
                continue

            processed += 1
            try:
                current_status = _normalize_ups_status(order.get("upsTrackingStatus") or order.get("ups_tracking_status"))
                current_persisted_delivery_date = _extract_persisted_delivery_date(order)
                current_known_delivery_date = _extract_known_delivery_date(order)
                if current_status == "delivered" and current_known_delivery_date and current_persisted_delivery_date != current_known_delivery_date:
                    order_repository.update_ups_tracking_status(
                        order_id,
                        ups_tracking_status="delivered",
                        delivered_at=_extract_known_delivered_at(order),
                        estimated_arrival_date=None,
                        delivery_date_guaranteed=None,
                        expected_shipment_window=None,
                    )
                    updated += 1
                    continue

                info = ups_tracking.fetch_tracking_status(tracking_number)
                if not info:
                    missing += 1
                    continue
                next_status = _normalize_ups_status(info.get("trackingStatus") or info.get("trackingStatusRaw"))
                delivered_at = str(info.get("deliveredAt") or "").strip() or None
                estimated_arrival_date = _normalize_optional_text(
                    info.get("estimatedArrivalDate") or info.get("estimated_arrival_date")
                )
                delivery_date_guaranteed = _normalize_optional_text(
                    info.get("deliveryDateGuaranteed") or info.get("delivery_date_guaranteed")
                )
                expected_shipment_window = _normalize_optional_text(
                    info.get("expectedShipmentWindow") or info.get("expected_shipment_window")
                )
                delivery_date = _resolve_known_delivery_date_value(
                    delivered_at=delivered_at,
                    estimated_arrival_date=estimated_arrival_date,
                    delivery_date_guaranteed=delivery_date_guaranteed,
                    expected_shipment_window=expected_shipment_window,
                )
                if not next_status:
                    if info.get("error"):
                        failed += 1
                    else:
                        missing += 1
                    continue
                current_delivered_at = _extract_known_delivered_at(order)
                current_estimated_arrival_date = _extract_estimated_arrival_date(order)
                current_delivery_date_guaranteed = _extract_delivery_date_guaranteed(order)
                current_expected_shipment_window = _extract_expected_shipment_window(order)
                if current_status == next_status and (
                    not delivery_date or current_persisted_delivery_date == delivery_date
                ) and (
                    next_status != "delivered" or not delivered_at or current_delivered_at == delivered_at
                ) and (
                    next_status == "delivered"
                    or (
                        (not estimated_arrival_date or current_estimated_arrival_date == estimated_arrival_date)
                        and (not delivery_date_guaranteed or current_delivery_date_guaranteed == delivery_date_guaranteed)
                        and (not expected_shipment_window or current_expected_shipment_window == expected_shipment_window)
                    )
                ):
                    continue
                persisted = order_repository.update_ups_tracking_status(
                    order_id,
                    ups_tracking_status=next_status,
                    delivered_at=delivered_at,
                    estimated_arrival_date=estimated_arrival_date,
                    delivery_date_guaranteed=delivery_date_guaranteed,
                    expected_shipment_window=expected_shipment_window,
                )
                if current_status != next_status and next_status in {"out_for_delivery", "delivered"}:
                    try:
                        shipping_notification_service.notify_customer_order_shipping_status(
                            str((persisted or {}).get("id") or order_id),
                            next_status,
                        )
                    except Exception:
                        logger.warning(
                            "[ups-status-sync] failed to send shipping status email",
                            exc_info=True,
                            extra={"orderId": order_id, "trackingNumber": tracking_number, "status": next_status},
                        )
                updated += 1
            except Exception as exc:
                failed += 1
                logger.warning(
                    "[ups-status-sync] order failed",
                    exc_info=False,
                    extra={"orderId": order_id, "trackingNumber": tracking_number, "error": str(exc)},
                )
            finally:
                if throttle_ms > 0:
                    time.sleep(throttle_ms / 1000.0)

        elapsed_ms = int((time.time() - started) * 1000)
        result = {
            "status": "success",
            "processed": processed,
            "updated": updated,
            "missing": missing,
            "failed": failed,
            "elapsedMs": elapsed_ms,
            "stoppedEarly": stopped_early,
            "maxRuntimeSeconds": int(max_runtime),
        }
        _STATE["lastFinishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _STATE["lastResult"] = result
        logger.info("[ups-status-sync] finished", extra=result)
        return result
    except Exception as exc:
        _STATE["lastFinishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _STATE["lastError"] = {"message": str(exc)}
        raise
    finally:
        try:
            token = locals().get("lease_token")
            if token:
                _release_lease(str(token), lease_seconds=_lease_seconds())
        except Exception:
            pass
        with _SYNC_LOCK:
            _IN_FLIGHT = False


def _worker() -> None:
    interval = _interval_seconds()
    logger.info("[ups-status-sync] thread started", extra={"intervalSeconds": interval})
    background_job_supervisor.record_heartbeat(
        _JOB_NAME,
        clear_error=True,
        enabled=_enabled(),
        mode="thread",
        intervalSeconds=interval,
        configured=ups_tracking.is_configured(),
    )
    time.sleep(5)
    while True:
        try:
            result = run_sync_once()
            background_job_supervisor.record_heartbeat(
                _JOB_NAME,
                last_result=result,
                clear_error=True,
                enabled=_enabled(),
                mode="thread",
                intervalSeconds=interval,
                configured=ups_tracking.is_configured(),
            )
        except Exception as exc:
            logger.error("[ups-status-sync] job failed", exc_info=True)
            background_job_supervisor.record_heartbeat(
                _JOB_NAME,
                last_error=exc,
                enabled=_enabled(),
                mode="thread",
                intervalSeconds=interval,
                configured=ups_tracking.is_configured(),
            )
        time.sleep(_interval_seconds())


def _startup_backfill_worker() -> None:
    passes = _startup_passes()
    logger.info("[ups-status-sync] startup backfill started", extra={"passes": passes})
    for attempt in range(1, passes + 1):
        try:
            result = run_sync_once(ignore_cooldown=True)
        except Exception:
            logger.error("[ups-status-sync] startup backfill failed", exc_info=True, extra={"attempt": attempt})
            return

        status = str(result.get("status") or "").strip().lower()
        updated = int(result.get("updated") or 0)
        processed = int(result.get("processed") or 0)
        reason = str(result.get("reason") or "").strip().lower()
        if status != "success":
            if reason not in {"cooldown"}:
                return
        if updated <= 0 or processed <= 0:
            return


def start_ups_status_sync(*, force: bool = False) -> None:
    global _THREAD_STARTED, _INITIAL_BACKFILL_STARTED
    interval = _interval_seconds()
    if not _enabled():
        background_job_supervisor.set_job_state(
            _JOB_NAME,
            enabled=False,
            mode=_mode(),
            intervalSeconds=interval,
            running=False,
            state="disabled",
            reason="disabled",
            configured=ups_tracking.is_configured(),
        )
        return
    if not force and _mode() != "thread":
        logger.info("[ups-status-sync] thread disabled", extra={"mode": _mode()})
        background_job_supervisor.set_job_state(
            _JOB_NAME,
            enabled=True,
            mode=_mode(),
            intervalSeconds=interval,
            running=False,
            state="external",
            reason="external_mode",
            configured=ups_tracking.is_configured(),
        )
        return
    with _THREAD_LOCK:
        if _THREAD_STARTED:
            return
        _THREAD_STARTED = True
        if not _INITIAL_BACKFILL_STARTED:
            _INITIAL_BACKFILL_STARTED = True
            startup_thread = threading.Thread(
                target=_startup_backfill_worker,
                name="ups-status-sync-startup",
                daemon=True,
            )
            startup_thread.start()
        background_job_supervisor.start_supervised_job(
            _JOB_NAME,
            _worker,
            thread_name="ups-status-sync",
            restart_delay_seconds=min(60.0, max(5.0, float(interval) / 2.0)),
            enabled=True,
            mode="thread",
            intervalSeconds=interval,
            configured=ups_tracking.is_configured(),
        )
