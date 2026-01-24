#!/usr/bin/env python3
"""
Backfill MySQL `orders.total` to the true grand total:
  grand = (itemsSubtotal or total) - appliedReferralCredit + shippingTotal + taxTotal

Why:
  Historically we stored the *items subtotal* in `orders.total`, which breaks any downstream
  logic that assumes it is the full order total.

Usage (dry-run):
  python3 scripts/backfill_mysql_order_totals.py --limit 200

Apply:
  python3 scripts/backfill_mysql_order_totals.py --apply --limit 200
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any


def _num(val: Any, fallback: float = 0.0) -> float:
    try:
        return float(val)
    except Exception:
        return fallback


def _compute_grand_total(payload: dict, row_total: float) -> float:
    items_subtotal = _num(payload.get("itemsSubtotal"), _num(payload.get("total"), row_total))
    shipping_total = _num(payload.get("shippingTotal"), 0.0)
    tax_total = _num(payload.get("taxTotal"), 0.0)
    discount_total = _num(payload.get("appliedReferralCredit"), 0.0)
    grand_total = _num(payload.get("grandTotal"), items_subtotal - discount_total + shipping_total + tax_total)
    return max(0.0, round(grand_total + 1e-9, 2))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Write updates to MySQL.")
    parser.add_argument("--limit", type=int, default=5000, help="Max rows to scan.")
    parser.add_argument("--only-mismatched", action="store_true", help="Only update when the computed total differs.")
    args = parser.parse_args()

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)

    from python_backend.services import get_config  # noqa: WPS433
    from python_backend.database import mysql_client  # noqa: WPS433

    if not bool(get_config().mysql.get("enabled")):
        print("MySQL is not enabled in config; nothing to backfill.", file=sys.stderr)
        return 2

    limit = max(1, min(int(args.limit or 5000), 200000))
    rows = mysql_client.fetch_all(
        """
        SELECT id, total, payload
        FROM orders
        ORDER BY created_at DESC
        LIMIT %(limit)s
        """,
        {"limit": limit},
    )

    updated = 0
    scanned = 0
    for row in rows or []:
        scanned += 1
        order_id = row.get("id")
        row_total = _num(row.get("total"), 0.0)
        payload_raw = row.get("payload")
        if not order_id or not payload_raw:
            continue
        try:
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else {}
        except Exception:
            payload = {}
        if not isinstance(payload, dict) or not payload:
            continue

        computed = _compute_grand_total(payload, row_total)
        if args.only_mismatched and abs(computed - row_total) < 0.005:
            continue

        if not args.apply:
            print(f"[dry-run] order_id={order_id} total_db={row_total:.2f} total_calc={computed:.2f}")
            updated += 1
            continue

        mysql_client.execute(
            "UPDATE orders SET total = %(total)s, updated_at = NOW() WHERE id = %(id)s",
            {"id": order_id, "total": computed},
        )
        updated += 1

    mode = "APPLIED" if args.apply else "DRY-RUN"
    print(f"{mode}: scanned={scanned} updated={updated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

