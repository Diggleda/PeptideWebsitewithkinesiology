from __future__ import annotations

from typing import Any, Dict

from ..services.catalog_snapshot_service import sync_catalog_snapshots


def sync_catalog_snapshot_job() -> Dict[str, Any]:
    """
    RQ job: refresh the MySQL-backed catalog snapshot (products, categories, variations).
    """
    return sync_catalog_snapshots(include_variations=True)

