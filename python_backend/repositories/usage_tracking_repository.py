from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from ..database import mysql_client
from ..services import get_config

logger = logging.getLogger(__name__)
_USAGE_TRACKING_COLUMNS_CACHE: Optional[set[str]] = None

_PAYLOAD_COLUMN_CANDIDATES = (
    "details_json",
    "details",
    "metadata_json",
    "metadata",
    "payload_json",
    "payload",
)


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _usage_tracking_columns() -> set[str]:
    global _USAGE_TRACKING_COLUMNS_CACHE
    if _USAGE_TRACKING_COLUMNS_CACHE is not None:
        return _USAGE_TRACKING_COLUMNS_CACHE
    if not _using_mysql():
        _USAGE_TRACKING_COLUMNS_CACHE = set()
        return _USAGE_TRACKING_COLUMNS_CACHE
    try:
        rows = mysql_client.fetch_all(
            """
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'usage_tracking'
            """,
        )
        cols = {str((row or {}).get("COLUMN_NAME") or "").strip() for row in (rows or [])}
        _USAGE_TRACKING_COLUMNS_CACHE = {c for c in cols if c}
    except Exception:
        _USAGE_TRACKING_COLUMNS_CACHE = {"event", "details_json"}
    return _USAGE_TRACKING_COLUMNS_CACHE


def _payload_column(columns: set[str]) -> Optional[str]:
    for candidate in _PAYLOAD_COLUMN_CANDIDATES:
        if candidate in columns:
            return candidate
    return None


def insert_event(event: str, details: Dict[str, Any], *, strict: bool = False) -> bool:
    if not _using_mysql():
        if strict:
            err = RuntimeError("Usage tracking requires MySQL to be enabled.")
            setattr(err, "status", 503)
            raise err
        logger.warning("Usage tracking skipped because MySQL is disabled", extra={"event": str(event or "").strip()[:128] or None})
        return False
    columns = _usage_tracking_columns()
    payload_column = _payload_column(columns)
    if "event" not in columns or not payload_column:
        message = (
            "usage_tracking table is missing the required columns. "
            f"Detected columns: {sorted(columns) if columns else []}"
        )
        if strict:
            err = RuntimeError(message)
            setattr(err, "status", 500)
            raise err
        logger.error(message)
        return False
    params = {
        "event": str(event or "").strip()[:128],
        "details_json": json.dumps(details or {}),
    }
    statements = (
        f"""
        INSERT INTO usage_tracking (event, `{payload_column}`)
        VALUES (%(event)s, %(details_json)s)
        """,
        f"""
        INSERT INTO usage_tracking (event, `{payload_column}`)
        VALUES (%(event)s, CAST(%(details_json)s AS JSON))
        """,
    )
    last_error: Exception | None = None
    for statement in statements:
        try:
            mysql_client.execute(statement, params)
            return True
        except Exception as exc:
            last_error = exc
    if strict and last_error is not None:
        raise last_error
    if last_error is not None:
        logger.exception("Usage tracking insert failed", extra={"event": params["event"], "payloadColumn": payload_column})
    return False
