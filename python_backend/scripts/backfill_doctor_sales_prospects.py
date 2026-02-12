from __future__ import annotations

import argparse
import json
import logging
from typing import Dict, Optional

from ..config import load_config
from ..database import init_database
from ..logging import configure_logging
from ..storage import init_storage
from ..repositories import sales_prospect_repository, user_repository


LOGGER = logging.getLogger("peppro.backfill_doctor_sales_prospects")


def _normalize_role(value: object) -> str:
    return str(value or "").strip().lower()


def _normalize_email(value: object) -> str:
    return str(value or "").strip().lower()


def _ensure_converted_sales_prospect_for_user(user: Dict, *, dry_run: bool) -> Optional[str]:
    role = _normalize_role(user.get("role"))
    if role not in ("doctor", "test_doctor"):
        return None

    doctor_id = str(user.get("id") or "").strip()
    sales_rep_id = str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
    if not doctor_id or not sales_rep_id:
        return None

    name = (str(user.get("name") or "").strip() or None)
    email = _normalize_email(user.get("email")) or None
    phone = user.get("phone") or user.get("phoneNumber") or user.get("phone_number") or None

    existing = sales_prospect_repository.find_by_sales_rep_and_doctor(sales_rep_id, doctor_id)
    if not existing:
        existing = sales_prospect_repository.find_by_doctor_id(doctor_id)
    if not existing and email:
        existing = sales_prospect_repository.find_by_sales_rep_and_contact_email(sales_rep_id, email)

    existing_status = str((existing or {}).get("status") or "").strip().lower()
    preserve_status = existing_status in ("nuture", "nurturing")

    is_doctor_prospect = False
    if existing:
        existing_id = str(existing.get("id") or "")
        is_doctor_prospect = (
            existing_id.startswith("doctor:")
            and bool(existing.get("doctorId"))
            and not existing.get("referralId")
            and not existing.get("contactFormId")
        )

    prospect_payload = {
        **(existing or {}),
        "id": str(existing.get("id")) if existing and existing.get("id") else f"doctor:{doctor_id}",
        "salesRepId": sales_rep_id,
        "doctorId": doctor_id,
        "status": (existing.get("status") if existing else None) if preserve_status else "converted",
        # Doctor account prospects should be treated like manual rows (no referral/contact form anchor).
        "isManual": True if (not existing or is_doctor_prospect) else bool(existing.get("isManual")),
        "contactName": name or (existing.get("contactName") if existing else None),
        "contactEmail": email or (existing.get("contactEmail") if existing else None),
        "contactPhone": phone or (existing.get("contactPhone") if existing else None),
    }

    if prospect_payload.get("status") is None:
        prospect_payload["status"] = "converted"

    action = "update" if existing else "create"
    if dry_run:
        LOGGER.info("%s sales prospect for doctor %s (rep=%s)", action, doctor_id, sales_rep_id)
        return action

    sales_prospect_repository.upsert(prospect_payload)
    return action


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill sales_prospects rows for doctor/test_doctor accounts.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Log changes without writing to storage.")
    parser.add_argument("--limit", type=int, default=0, help="Maximum number of users to scan (0 = no limit).")
    parser.add_argument(
        "--sales-rep-id",
        type=str,
        default="",
        help="Optional sales rep id to scope to (matches users.salesRepId).",
    )
    args = parser.parse_args()

    config = load_config()
    configure_logging(config)
    init_database(config)
    init_storage(config)

    limit = int(args.limit or 0)
    rep_scope = str(args.sales_rep_id or "").strip()

    users = user_repository.get_all()
    scanned = 0
    created = 0
    updated = 0
    skipped = 0
    errors = 0

    for user in users or []:
        if not isinstance(user, dict):
            continue
        if rep_scope:
            user_rep_id = str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
            if user_rep_id != rep_scope:
                continue

        scanned += 1
        if limit and scanned > limit:
            break

        try:
            result = _ensure_converted_sales_prospect_for_user(user, dry_run=bool(args.dry_run))
            if result == "create":
                created += 1
            elif result == "update":
                updated += 1
            else:
                skipped += 1
        except Exception as exc:  # pragma: no cover - defensive logging
            errors += 1
            LOGGER.error("Failed to backfill prospect for user %s: %s", user.get("id"), exc)

    print(
        json.dumps(
            {
                "dryRun": bool(args.dry_run),
                "scanned": scanned,
                "created": created,
                "updated": updated,
                "skipped": skipped,
                "errors": errors,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
