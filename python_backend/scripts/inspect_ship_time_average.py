from __future__ import annotations

import argparse
import logging
from datetime import date, datetime, timedelta
from typing import Dict, List

from python_backend.config import load_config
from python_backend.database import init_database, mysql_client
from python_backend.logging_config import configure_logging
from python_backend.services import configure_services
from python_backend.scripts.backfill_shipdates import _bootstrap_cli_env

LOGGER = logging.getLogger("peppro.inspect_ship_time_average")


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


def _fetch_rows(limit: int) -> List[Dict]:
    return mysql_client.fetch_all(
        """
        SELECT id, tracking_number, created_at, shipped_at, status
        FROM orders
        WHERE NULLIF(TRIM(COALESCE(tracking_number, '')), '') IS NOT NULL
          AND created_at IS NOT NULL
          AND shipped_at IS NOT NULL
          AND DATE(shipped_at) >= DATE(created_at)
          AND LOWER(COALESCE(status, '')) NOT IN ('cancelled', 'canceled', 'refunded', 'failed')
        ORDER BY shipped_at DESC, id DESC
        LIMIT %(limit)s
        """,
        {"limit": int(limit)},
    )


def _parse_dt(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    text = str(value or "").strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        if " " in text and "T" not in text:
            text = text.replace(" ", "T", 1)
        return datetime.fromisoformat(text)
    except Exception:
        return None


def run(*, limit: int, show_rows: bool) -> int:
    rows = _fetch_rows(limit)
    durations: List[float] = []
    rendered_rows: List[Dict[str, object]] = []

    for row in rows:
        created_at = _parse_dt(row.get("created_at"))
        shipped_at = _parse_dt(row.get("shipped_at"))
        if not created_at or not shipped_at or shipped_at.date() < created_at.date():
            continue
        business_days = _business_days_between(created_at, shipped_at)
        durations.append(business_days)
        rendered_rows.append(
            {
                "id": row.get("id"),
                "tracking_number": row.get("tracking_number"),
                "created_at": created_at,
                "shipped_at": shipped_at,
                "status": row.get("status"),
                "business_days": business_days,
            }
        )

    average_business_days = _trimmed_average(durations) if durations else 0.0
    rounded_business_days = max(1, int(round(average_business_days))) if average_business_days > 0 else 1

    print(f"included_orders={len(rendered_rows)}")
    print(f"average_business_days={average_business_days:.2f}" if rendered_rows else "average_business_days=0.00")
    print(f"rounded_business_days={rounded_business_days}")
    print(f"rule=tracking_number -> created_at/shipped_at present -> compare dates only -> exclude cancelled/refunded/failed")

    if show_rows:
        for row in rendered_rows:
            print(
                f"{row['id']} | tracking_number={row['tracking_number']} | "
                f"created_at={row['created_at']} | shipped_at={row['shipped_at']} | "
                f"business_days={row['business_days']:.1f} | status={row['status']}"
            )
    return len(rendered_rows)


def main() -> None:
    parser = argparse.ArgumentParser(description="Inspect the orders included in the historical ship-time average.")
    parser.add_argument("--limit", type=int, default=250, help="Maximum number of qualifying rows to inspect.")
    parser.add_argument("--show-rows", action="store_true", help="Print each included row.")
    args = parser.parse_args()

    _bootstrap_cli_env()
    load_config()
    configure_logging()
    init_database()
    configure_services()
    run(limit=max(1, int(args.limit)), show_rows=bool(args.show_rows))


if __name__ == "__main__":
    main()
