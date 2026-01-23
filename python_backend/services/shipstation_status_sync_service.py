from __future__ import annotations

import json
import logging
import os
import secrets
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..integrations import ship_station, woo_commerce

logger = logging.getLogger(__name__)

_THREAD_STARTED = False
_THREAD_LOCK = threading.Lock()

_SYNC_LOCK = threading.Lock()
_IN_FLIGHT = False

_STATE: Dict[str, Any] = {
    "lastStartedAt": None,
    "lastFinishedAt": None,
    "lastResult": None,
    "lastError": None,
}

_LAST_RUN_SETTINGS_KEY = "shipStationWooStatusSyncLastRunAt"
_LEASE_SETTINGS_KEY = "shipStationWooStatusSyncLease"


def _enabled() -> bool:
    raw = str(os.environ.get("SHIPSTATION_STATUS_SYNC_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _interval_seconds() -> int:
    raw_ms = str(os.environ.get("SHIPSTATION_STATUS_SYNC_INTERVAL_MS", "") or "").strip()
    if raw_ms:
        try:
            ms = int(raw_ms)
        except Exception:
            ms = 60_000
        return max(60, min(int(ms / 1000), 3600))

    raw = str(os.environ.get("SHIPSTATION_STATUS_SYNC_INTERVAL_SECONDS", "60")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 60
    return max(60, min(value, 3600))


def _lookback_days() -> int:
    raw = str(os.environ.get("SHIPSTATION_STATUS_SYNC_LOOKBACK_DAYS", "60")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 60
    return max(1, min(value, 90))


def _max_orders() -> int:
    raw = str(os.environ.get("SHIPSTATION_STATUS_SYNC_MAX_ORDERS", "80")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 80
    return max(1, min(value, 500))


def _lease_seconds() -> int:
    raw = str(os.environ.get("SHIPSTATION_STATUS_SYNC_LEASE_SECONDS", "300")).strip()
    try:
        value = int(raw)
    except Exception:
        value = 300
    return max(30, min(value, 3600))


def _try_acquire_lease(*, lease_seconds: int) -> Optional[str]:
    """
    Best-effort MySQL-backed lease using the `settings` table.

    NOTE: Do not use MySQL GET_LOCK here. This codebase uses a pooled connection wrapper
    (`mysql_client`), and advisory locks are connection-scoped, making release unreliable.
    """
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
        if not text:
            return None
        if text == "null":
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


def _normalize_shipstation_status(value: Any) -> str:
    text = str(value or "").strip().lower()
    if not text:
        return ""
    return "_".join(text.replace("-", " ").split())


def _map_shipstation_status_to_woo(status: Any) -> Optional[str]:
    normalized = _normalize_shipstation_status(status)
    if normalized == "shipped":
        return "completed"
    if normalized in ("cancelled", "canceled"):
        return "cancelled"
    if normalized == "awaiting_shipment":
        return "processing"
    if normalized in ("awaiting_payment", "on_hold", "onhold"):
        return "on-hold"
    return None


def _fetch_orders_for_sync(*, lookback_days: int, max_orders: int) -> List[Dict[str, Any]]:
    if not woo_commerce.is_configured():
        return []

    per_page = min(100, max_orders)
    max_pages = min(int((max_orders / per_page) + 3), 20)
    after_iso = datetime.now(timezone.utc).timestamp() - (lookback_days * 24 * 60 * 60)
    after_str = datetime.fromtimestamp(after_iso, tz=timezone.utc).isoformat()

    collected: List[Dict[str, Any]] = []
    seen: set[str] = set()

    def add_batch(batch: Any) -> None:
        nonlocal collected
        if not isinstance(batch, list):
            return
        for order in batch:
            if not isinstance(order, dict):
                continue
            key = str(order.get("id") or order.get("number") or "").strip()
            if not key or key in seen:
                continue
            seen.add(key)
            collected.append(order)
            if len(collected) >= max_orders:
                break

    # Always include on-hold orders (no date filter).
    for page in range(1, max_pages + 1):
        data, _meta = woo_commerce.fetch_catalog_proxy(
            "orders",
            {"per_page": per_page, "page": page, "orderby": "date", "order": "desc", "status": "on-hold"},
        )
        if not isinstance(data, list) or len(data) == 0:
            break
        add_batch(data)
        if len(data) < per_page or len(collected) >= max_orders:
            break

    # Then include recent processing orders (for shipped → completed updates).
    for page in range(1, max_pages + 1):
        if len(collected) >= max_orders:
            break
        data, _meta = woo_commerce.fetch_catalog_proxy(
            "orders",
            {
                "per_page": per_page,
                "page": page,
                "orderby": "date",
                "order": "desc",
                "status": "processing",
                "after": after_str,
            },
        )
        if not isinstance(data, list) or len(data) == 0:
            break
        add_batch(data)
        if len(data) < per_page:
            break

    return collected


def get_status() -> Dict[str, Any]:
    return {
        **_STATE,
        "inFlight": _IN_FLIGHT,
        "enabled": _enabled(),
        "intervalSeconds": _interval_seconds(),
        "lookbackDays": _lookback_days(),
        "maxOrders": _max_orders(),
        "leaseSeconds": _lease_seconds(),
    }


def run_sync_once(*, ignore_cooldown: bool = False) -> Dict[str, Any]:
    global _IN_FLIGHT

    if not _enabled():
        result = {"status": "skipped", "reason": "disabled"}
        _STATE["lastResult"] = result
        return result
    if not woo_commerce.is_configured():
        result = {"status": "skipped", "reason": "woo_not_configured"}
        _STATE["lastResult"] = result
        return result
    if not ship_station.is_configured():
        result = {"status": "skipped", "reason": "shipstation_not_configured"}
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

        # Cooldown across workers (Passenger). If settings table isn't available, fall back to per-process interval.
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
        orders = _fetch_orders_for_sync(lookback_days=lookback_days, max_orders=max_orders)

        logger.info(
            "[shipstation-sync] starting",
            extra={"lookbackDays": lookback_days, "maxOrders": max_orders, "wooOrders": len(orders)},
        )

        for order in orders:
            if not isinstance(order, dict):
                continue
            woo_order_id = order.get("id")
            woo_number = order.get("number") or order.get("id")
            if woo_order_id is None or woo_number is None:
                continue

            processed += 1
            try:
                ss = ship_station.fetch_order_status(str(woo_number))
                if not ss:
                    missing += 1
                    continue
                next_status = _map_shipstation_status_to_woo(ss.get("status"))
                result = woo_commerce.apply_shipstation_shipment_update(
                    str(woo_order_id),
                    current_status=order.get("status"),
                    next_status=next_status,
                    shipstation_status=ss.get("status"),
                    tracking_number=ss.get("trackingNumber"),
                    carrier_code=ss.get("carrierCode"),
                    ship_date=ss.get("shipDate"),
                    existing_meta_data=order.get("meta_data") if isinstance(order.get("meta_data"), list) else None,
                )
                if isinstance(result, dict) and result.get("changed") is True:
                    updated += 1
                    note = woo_commerce.build_shipstation_note(
                        ss.get("status"),
                        ss.get("trackingNumber"),
                        ss.get("carrierCode"),
                        ss.get("shipDate"),
                    )
                    if note:
                        try:
                            woo_commerce.add_order_note(str(woo_order_id), note)
                        except Exception:
                            pass
            except Exception as exc:
                failed += 1
                logger.warning(
                    "[shipstation-sync] order failed",
                    exc_info=False,
                    extra={"wooOrderId": woo_order_id, "wooNumber": woo_number, "error": str(exc)},
                )

        elapsed_ms = int((time.time() - started) * 1000)
        result = {
            "status": "success",
            "processed": processed,
            "updated": updated,
            "missing": missing,
            "failed": failed,
            "elapsedMs": elapsed_ms,
        }
        _STATE["lastFinishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _STATE["lastResult"] = result
        logger.info("[shipstation-sync] finished", extra=result)
        return result
    except Exception as exc:
        _STATE["lastFinishedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        _STATE["lastError"] = {"message": str(exc)}
        raise
    finally:
        try:
            try:
                token = locals().get("lease_token")
                if token:
                    _release_lease(str(token), lease_seconds=_lease_seconds())
            except Exception:
                pass
        finally:
            with _SYNC_LOCK:
                _IN_FLIGHT = False


def _worker() -> None:
    interval = _interval_seconds()
    logger.info("[shipstation-sync] thread started", extra={"intervalSeconds": interval})
    time.sleep(5)
    while True:
        try:
            run_sync_once()
        except Exception:
            logger.error("[shipstation-sync] job failed", exc_info=True)
        time.sleep(_interval_seconds())


def start_shipstation_status_sync() -> None:
    global _THREAD_STARTED
    if not _enabled():
        return
    with _THREAD_LOCK:
        if _THREAD_STARTED:
            return
        _THREAD_STARTED = True
        thread = threading.Thread(target=_worker, name="shipstation-status-sync", daemon=True)
        thread.start()
