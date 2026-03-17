from __future__ import annotations

import json
import logging
from typing import Any, Dict

from ..database import mysql_client
from ..services import get_config

logger = logging.getLogger(__name__)


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def insert_event(event: str, details: Dict[str, Any], *, strict: bool = False) -> bool:
    if not _using_mysql():
        if strict:
            err = RuntimeError("Usage tracking requires MySQL to be enabled.")
            setattr(err, "status", 503)
            raise err
        logger.warning("Usage tracking skipped because MySQL is disabled", extra={"event": str(event or "").strip()[:128] or None})
        return False
    mysql_client.execute(
        """
        INSERT INTO usage_tracking (event, details_json)
        VALUES (%(event)s, CAST(%(details_json)s AS JSON))
        """,
        {
            "event": str(event or "").strip()[:128],
            "details_json": json.dumps(details or {}),
        },
    )
    return True
