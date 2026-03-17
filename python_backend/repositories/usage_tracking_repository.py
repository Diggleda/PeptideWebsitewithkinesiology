from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from ..database import mysql_client
from ..services import get_config

logger = logging.getLogger(__name__)
_USAGE_TRACKING_COLUMNS_CACHE: Optional[set[str]] = None

_PAYLOAD_COLUMN_CANDIDATES = ("details_json", "details", "metadata_json", "metadata", "payload_json", "payload")


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


def _parse_payload(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except Exception:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _merge_event_payload(existing_payloads: list[Dict[str, Any]], latest_details: Dict[str, Any]) -> Dict[str, Any]:
    instances: list[Dict[str, Any]] = []
    for payload in existing_payloads:
        existing_instances = payload.get("instances")
        if isinstance(existing_instances, list) and existing_instances:
            for item in existing_instances:
                if isinstance(item, dict):
                    instances.append(dict(item))
        elif payload:
            instances.append(dict(payload))
    instances.append(dict(latest_details or {}))
    return {
        "count": len(instances),
        "instances": instances,
    }


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
    }
    try:
        id_column_present = "id" in columns
        select_columns = f"id, `{payload_column}` AS payload_value" if id_column_present else f"`{payload_column}` AS payload_value"
        rows = mysql_client.fetch_all(
            f"""
            SELECT {select_columns}
            FROM usage_tracking
            WHERE event = %(event)s
            ORDER BY {"id ASC" if id_column_present else "event ASC"}
            """,
            params,
        )
        existing_payloads = [_parse_payload((row or {}).get("payload_value")) for row in (rows or [])]
        merged_payload = _merge_event_payload(existing_payloads, details)
        payload_json = json.dumps(merged_payload or {})
        if rows:
            first_row = rows[0] or {}
            if id_column_present and first_row.get("id") is not None:
                mysql_client.execute(
                    f"""
                    UPDATE usage_tracking
                    SET `{payload_column}` = %(details_json)s
                    WHERE id = %(row_id)s
                    """,
                    {"details_json": payload_json, "row_id": first_row.get("id")},
                )
                duplicate_ids = [
                    row.get("id")
                    for row in rows[1:]
                    if isinstance(row, dict) and row.get("id") is not None
                ]
                for duplicate_id in duplicate_ids:
                    mysql_client.execute(
                        "DELETE FROM usage_tracking WHERE id = %(row_id)s",
                        {"row_id": duplicate_id},
                    )
            else:
                mysql_client.execute(
                    f"""
                    UPDATE usage_tracking
                    SET `{payload_column}` = %(details_json)s
                    WHERE event = %(event)s
                    """,
                    {"event": params["event"], "details_json": payload_json},
                )
        else:
            mysql_client.execute(
                f"""
                INSERT INTO usage_tracking (event, `{payload_column}`)
                VALUES (%(event)s, %(details_json)s)
                """,
                {"event": params["event"], "details_json": payload_json},
            )
        return True
    except Exception as exc:
        if strict:
            raise exc
        logger.exception("Usage tracking insert failed", extra={"event": params["event"], "payloadColumn": payload_column})
        return False
