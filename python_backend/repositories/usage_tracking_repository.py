from __future__ import annotations

import json
from typing import Any, Dict

from ..database import mysql_client
from ..services import get_config


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def insert_event(event: str, details: Dict[str, Any]) -> None:
    if not _using_mysql():
        return
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
