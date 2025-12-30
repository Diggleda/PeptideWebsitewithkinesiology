from __future__ import annotations

import logging
from typing import Dict, List

from ..config import load_config
from ..database import init_database
from ..logging import configure_logging
from ..storage import init_storage, user_store, order_store, sales_rep_store, referral_code_store, referral_store, sales_prospect_store, credit_ledger_store
from ..repositories import (
    user_repository,
    order_repository,
    sales_rep_repository,
    referral_code_repository,
    referral_repository,
    sales_prospect_repository,
    credit_ledger_repository,
)


LOGGER = logging.getLogger("peppro.migrate")


def _ensure_mysql_enabled(config) -> None:
    if not config.mysql.get("enabled"):
        raise RuntimeError("MySQL is not enabled. Set MYSQL_ENABLED=true in your environment before running this script.")


def _load_json_data(store, name: str) -> List[Dict]:
    if store is None:
        LOGGER.warning("JSON store for %s is not initialised – skipping", name)
        return []
    try:
        return list(store.read())
    except Exception as exc:  # pragma: no cover - defensive logging
        LOGGER.error("Failed to read %s JSON store: %s", name, exc)
        return []


def migrate() -> None:
    """
    Import existing JSON storage data into the configured MySQL database.
    """
    config = load_config()
    configure_logging(config)
    _ensure_mysql_enabled(config)

    init_database(config)
    init_storage(config)

    migrations = [
        ("sales reps", sales_rep_store, sales_rep_repository.insert),
        ("users", user_store, user_repository.insert),
        ("referral codes", referral_code_store, referral_code_repository.insert),
        ("referrals", referral_store, referral_repository.insert),
        ("sales prospects", sales_prospect_store, sales_prospect_repository.upsert),
        ("orders", order_store, order_repository.insert),
        ("credit ledger", credit_ledger_store, credit_ledger_repository.insert),
    ]

    total_imported = 0

    for label, store, inserter in migrations:
        records = _load_json_data(store, label)
        if not records:
            LOGGER.info("No %s found in JSON store – skipping", label)
            continue

        inserted = 0
        for record in records:
            try:
                inserter(dict(record))
                inserted += 1
            except Exception as exc:  # pragma: no cover - defensive logging
                LOGGER.error("Failed to insert %s record %s: %s", label, record.get("id"), exc)

        total_imported += inserted
        LOGGER.info("Imported %s %s record(s) into MySQL", inserted, label)

    LOGGER.info("Migration complete. Total records imported: %s", total_imported)


if __name__ == "__main__":
    migrate()
