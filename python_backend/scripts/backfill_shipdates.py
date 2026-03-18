from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from python_backend.config import load_config
from python_backend.database import init_database, mysql_client
from python_backend.integrations import ship_station
from python_backend.logging_config import configure_logging
from python_backend.services import configure_services

LOGGER = logging.getLogger("peppro.backfill_shipdates")


def _strip_wrapping_quotes(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and ((text[0] == text[-1]) and text[0] in ("'", '"')):
        return text[1:-1]
    return text


def _load_setenv_from_htaccess() -> Dict[str, str]:
    """
    Mirror Passenger/Apache SetEnv behavior for CLI script runs.
    This keeps script bootstrapping aligned with how Woo/ShipStation sync runs in web workers.
    """
    loaded: Dict[str, str] = {}
    repo_root = Path(__file__).resolve().parents[2]
    candidates = [
        repo_root / "public_html" / ".htaccess",
        repo_root / "server" / "php" / "public_html" / "port.peppro.net" / ".htaccess",
    ]

    for path in candidates:
        if not path.exists():
            continue
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except Exception:
            continue
        for line in lines:
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if not stripped.lower().startswith("setenv "):
                continue
            parts = stripped.split(None, 2)
            if len(parts) < 3:
                continue
            key = parts[1].strip()
            raw_value = _strip_wrapping_quotes(parts[2])
            if not key:
                continue
            os.environ[key] = raw_value
            loaded[key] = raw_value

    return loaded


def _bootstrap_cli_env() -> None:
    """
    For CLI runs, attempt the same environment source used by Passenger workers.
    """
    if os.environ.get("MYSQL_USER") and os.environ.get("MYSQL_DATABASE"):
        return

    loaded = _load_setenv_from_htaccess()
    dot_env_path = loaded.get("DOTENV_CONFIG_PATH")
    if dot_env_path and not os.environ.get("DOTENV_CONFIG_PATH"):
        os.environ["DOTENV_CONFIG_PATH"] = dot_env_path


def _safe_str(value: Any) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text if text else None


def _normalize_token(value: Any) -> Optional[str]:
    text = _safe_str(value)
    if not text:
        return None
    if text.startswith("#"):
        text = text[1:].strip()
    return text or None


def _parse_json(value: Any) -> Dict[str, Any]:
    if not value:
        return {}
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return {}
    return {}


def _parse_ship_date_to_mysql(value: Any) -> Optional[str]:
    raw = _safe_str(value)
    if not raw:
        return None

    candidates = [raw]
    if raw.endswith("Z"):
        candidates.append(raw[:-1] + "+00:00")

    for candidate in candidates:
        try:
            parsed = datetime.fromisoformat(candidate)
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
            return parsed.strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            continue

    try:
        # Fallback for common ShipStation date-only values.
        parsed = datetime.strptime(raw[:10], "%Y-%m-%d")
        return parsed.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


def _table_exists(table: str) -> bool:
    row = mysql_client.fetch_one(
        """
        SELECT COUNT(*) AS cnt
        FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = %(table)s
        """,
        {"table": table},
    )
    return int((row or {}).get("cnt") or 0) > 0


def _column_exists(table: str, column: str) -> bool:
    row = mysql_client.fetch_one(
        """
        SELECT COUNT(*) AS cnt
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = %(table)s
          AND column_name = %(column)s
        """,
        {"table": table, "column": column},
    )
    return int((row or {}).get("cnt") or 0) > 0


def _ensure_shipped_at_column(table: str) -> None:
    if _column_exists(table, "shipped_at"):
        return
    mysql_client.execute(f"ALTER TABLE {table} ADD COLUMN shipped_at DATETIME NULL")
    LOGGER.info("Added missing shipped_at column on table=%s", table)


def _pick_candidate_order_numbers(row: Dict[str, Any]) -> List[str]:
    payload = _parse_json(row.get("payload"))
    order_obj = payload.get("order") if isinstance(payload.get("order"), dict) else payload
    integrations = payload.get("integrations") if isinstance(payload.get("integrations"), dict) else {}
    woo = integrations.get("wooCommerce") if isinstance(integrations.get("wooCommerce"), dict) else {}

    candidates = [
        row.get("woo_order_id"),
        row.get("woo_order_number"),
        row.get("order_number"),
        row.get("number"),
        order_obj.get("wooOrderNumber") if isinstance(order_obj, dict) else None,
        order_obj.get("woo_order_number") if isinstance(order_obj, dict) else None,
        order_obj.get("number") if isinstance(order_obj, dict) else None,
        woo.get("wooOrderNumber") if isinstance(woo, dict) else None,
        woo.get("response", {}).get("number") if isinstance(woo.get("response"), dict) else None,
        payload.get("wooOrderNumber"),
        payload.get("woo_order_number"),
        payload.get("number"),
    ]

    normalized: List[str] = []
    seen = set()
    for candidate in candidates:
        token = _normalize_token(candidate)
        if not token or token in seen:
            continue
        seen.add(token)
        normalized.append(token)
    return normalized


def _patch_payload(payload_raw: Any, ship_info: Dict[str, Any]) -> Optional[str]:
    payload = _parse_json(payload_raw)
    if not payload:
        return None

    ship_date = _safe_str(ship_info.get("shipDate"))
    tracking = _safe_str(ship_info.get("trackingNumber"))
    carrier = _safe_str(ship_info.get("carrierCode"))
    status = _safe_str(ship_info.get("status"))

    if ship_date:
        payload["shippedAt"] = ship_date
        payload["shipped_at"] = ship_date

    integrations = payload.get("integrations")
    if not isinstance(integrations, dict):
        integrations = {}
    shipstation = integrations.get("shipStation")
    if not isinstance(shipstation, dict):
        shipstation = {}
    if status:
        shipstation["status"] = status
    if ship_date:
        shipstation["shipDate"] = ship_date
    if tracking:
        shipstation["trackingNumber"] = shipstation.get("trackingNumber") or tracking
    if carrier:
        shipstation["carrierCode"] = shipstation.get("carrierCode") or carrier
    integrations["shipStation"] = shipstation
    payload["integrations"] = integrations

    if isinstance(payload.get("order"), dict):
        order = dict(payload["order"])
        if ship_date:
            order["shippedAt"] = ship_date
            order["shipped_at"] = ship_date
        shipping_estimate = order.get("shippingEstimate")
        if not isinstance(shipping_estimate, dict):
            shipping_estimate = {}
        if ship_date:
            shipping_estimate["shipDate"] = ship_date
        if status:
            shipping_estimate["status"] = shipping_estimate.get("status") or str(status).lower()
        if carrier:
            shipping_estimate["carrierId"] = shipping_estimate.get("carrierId") or carrier
        order["shippingEstimate"] = shipping_estimate
        if tracking and not order.get("trackingNumber"):
            order["trackingNumber"] = tracking
        payload["order"] = order
    else:
        if tracking and not payload.get("trackingNumber"):
            payload["trackingNumber"] = tracking

    return json.dumps(payload, separators=(",", ":"))


def _fetch_candidates(table: str, limit: int, offset: int) -> List[Dict[str, Any]]:
    if table == "peppro_orders":
        return mysql_client.fetch_all(
            """
            SELECT id, woo_order_id, shipstation_order_id, status, payload
            FROM peppro_orders
            WHERE shipped_at IS NULL
              AND LOWER(REPLACE(REPLACE(COALESCE(status, ''), '_', '-'), ' ', '-')) IN ('shipped', 'completed')
            ORDER BY created_at DESC
            LIMIT %(limit)s OFFSET %(offset)s
            """,
            {"limit": int(limit), "offset": int(offset)},
        )

    return mysql_client.fetch_all(
        """
        SELECT id, woo_order_number, tracking_number, status, payload
        FROM orders
        WHERE shipped_at IS NULL
          AND LOWER(REPLACE(REPLACE(COALESCE(status, ''), '_', '-'), ' ', '-')) IN ('shipped', 'completed')
        ORDER BY created_at DESC
        LIMIT %(limit)s OFFSET %(offset)s
        """,
        {"limit": int(limit), "offset": int(offset)},
    )


def _apply_update(
    table: str,
    order_id: str,
    ship_info: Dict[str, Any],
    payload_raw: Any,
    *,
    require_tracking: bool,
) -> bool:
    ship_date_text = _parse_ship_date_to_mysql(ship_info.get("shipDate"))
    if not ship_date_text:
        return False

    tracking = _safe_str(ship_info.get("trackingNumber"))
    if require_tracking and not tracking:
        return False

    payload_next = _patch_payload(payload_raw, ship_info)

    if table == "peppro_orders":
        mysql_client.execute(
            """
            UPDATE peppro_orders
            SET shipped_at = %(shipped_at)s,
                payload = CASE
                  WHEN %(payload)s IS NULL THEN payload
                  ELSE %(payload)s
                END,
                updated_at = NOW()
            WHERE id = %(id)s
            """,
            {"id": order_id, "shipped_at": ship_date_text, "payload": payload_next},
        )
        return True

    mysql_client.execute(
        """
        UPDATE orders
        SET shipped_at = %(shipped_at)s,
            tracking_number = COALESCE(tracking_number, %(tracking)s),
            payload = CASE
              WHEN %(payload)s IS NULL THEN payload
              ELSE %(payload)s
            END,
            updated_at = NOW()
        WHERE id = %(id)s
        """,
        {
            "id": order_id,
            "shipped_at": ship_date_text,
            "tracking": tracking,
            "payload": payload_next,
        },
    )
    return True


def _resolve_ship_info(order_numbers: Sequence[str], sleep_ms: int) -> Optional[Tuple[Dict[str, Any], str]]:
    for number in order_numbers:
        info = None
        try:
            info = ship_station.fetch_order_status(number)
        except Exception as exc:
            LOGGER.warning("ShipStation lookup failed for orderNumber=%s: %s", number, exc)
        if sleep_ms > 0:
            time.sleep(max(0, sleep_ms) / 1000.0)
        if info and _safe_str(info.get("shipDate")):
            return info, number
    return None


def run(*, apply: bool, limit: int, offset: int, sleep_ms: int, require_tracking: bool) -> None:
    _bootstrap_cli_env()
    config = load_config()
    configure_logging(config)
    configure_services(config)
    init_database(config)

    if not config.mysql.get("enabled"):
        raise RuntimeError("MySQL is not enabled. Set MYSQL_ENABLED=true and DB env vars.")
    if not ship_station.is_configured():
        raise RuntimeError("ShipStation is not configured. Set SHIPSTATION credentials first.")

    tables = [table for table in ("peppro_orders", "orders") if _table_exists(table)]
    if not tables:
        raise RuntimeError("Neither peppro_orders nor orders table exists in this database.")

    for table in tables:
        _ensure_shipped_at_column(table)

    scanned = 0
    matched = 0
    updated = 0
    skipped_no_candidates = 0
    skipped_no_shipdate = 0
    skipped_tracking_required = 0

    for table in tables:
        rows = _fetch_candidates(table, limit=limit, offset=offset)
        for row in rows or []:
            scanned += 1
            order_id = _safe_str(row.get("id"))
            if not order_id:
                continue

            candidates = _pick_candidate_order_numbers(row)
            if not candidates:
                skipped_no_candidates += 1
                continue

            resolved = _resolve_ship_info(candidates, sleep_ms=sleep_ms)
            if not resolved:
                skipped_no_shipdate += 1
                continue
            ship_info, via_number = resolved

            tracking = _safe_str(ship_info.get("trackingNumber"))
            if require_tracking and not tracking:
                skipped_tracking_required += 1
                continue

            matched += 1
            ship_date = _safe_str(ship_info.get("shipDate"))
            if not apply:
                print(
                    f"[dry-run] table={table} order_id={order_id} ship_date={ship_date} "
                    f"tracking={tracking or ''} via={via_number}"
                )
                continue

            wrote = _apply_update(
                table,
                order_id,
                ship_info,
                row.get("payload"),
                require_tracking=require_tracking,
            )
            if wrote:
                updated += 1
                print(
                    f"[updated] table={table} order_id={order_id} ship_date={ship_date} "
                    f"tracking={tracking or ''} via={via_number}"
                )

    mode = "APPLIED" if apply else "DRY-RUN"
    summary = {
        "mode": mode,
        "limit": limit,
        "offset": offset,
        "scanned": scanned,
        "matched": matched,
        "updated": updated,
        "skipped_no_candidates": skipped_no_candidates,
        "skipped_no_shipdate": skipped_no_shipdate,
        "skipped_tracking_required": skipped_tracking_required,
    }
    LOGGER.info("Ship date backfill complete: %s", summary)
    print(json.dumps(summary, indent=2))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backfill shipped_at from ShipStation historical ship dates.")
    parser.add_argument("--apply", action="store_true", help="Write updates (default is dry-run).")
    parser.add_argument("--limit", type=int, default=500, help="Rows to scan per table.")
    parser.add_argument("--offset", type=int, default=0, help="Offset into result set.")
    parser.add_argument("--sleep-ms", type=int, default=120, help="Sleep between ShipStation calls.")
    parser.add_argument(
        "--require-tracking",
        action="store_true",
        help="Only update rows where ShipStation also has a tracking number.",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run(
        apply=bool(args.apply),
        limit=max(1, min(int(args.limit), 100000)),
        offset=max(0, int(args.offset)),
        sleep_ms=max(0, min(int(args.sleep_ms), 10000)),
        require_tracking=bool(args.require_tracking),
    )
