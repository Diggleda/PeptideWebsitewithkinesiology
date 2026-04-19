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


def _normalize_event_names(events: list[str] | tuple[str, ...] | None) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for value in events or []:
        name = str(value or "").strip()[:128]
        if not name or name in seen:
            continue
        seen.add(name)
        normalized.append(name)
    return normalized


def _payload_count(payload: Dict[str, Any]) -> int:
    raw_count = payload.get("count")
    if isinstance(raw_count, bool):
        raw_count = int(raw_count)
    if isinstance(raw_count, (int, float)):
        return max(0, int(raw_count))
    instances = payload.get("instances")
    if isinstance(instances, list):
        return len(instances)
    return 1 if payload else 0


def _payload_instances(payload: Dict[str, Any]) -> list[Dict[str, Any]]:
    instances = payload.get("instances")
    if isinstance(instances, list):
        return [dict(item) for item in instances if isinstance(item, dict)]
    return [dict(payload)] if payload else []


def _normalize_actor_key(value: Any) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _instance_actor_key(instance: Dict[str, Any]) -> Optional[str]:
    who = instance.get("who")
    if not isinstance(who, dict):
        return None
    actor_id = str(who.get("id") or "").strip()
    if actor_id:
        return f"id:{actor_id}"
    email = str(who.get("email") or "").strip().lower()
    if email:
        return f"email:{email}"
    return None


def _instance_actor_summary(instance: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    who = instance.get("who")
    if not isinstance(who, dict):
        return None
    key = _instance_actor_key(instance)
    if not key:
        return None
    user_id = str(who.get("id") or "").strip() or None
    name = str(who.get("name") or "").strip() or None
    email = str(who.get("email") or "").strip() or None
    role = str(who.get("role") or "").strip() or None
    return {
        "key": key,
        "userId": user_id,
        "name": name,
        "email": email,
        "role": role,
        "eventCount": 1,
    }


def _merge_actor_summary(current: Dict[str, Any], incoming: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "key": current.get("key") or incoming.get("key"),
        "userId": current.get("userId") or incoming.get("userId"),
        "name": current.get("name") or incoming.get("name"),
        "email": current.get("email") or incoming.get("email"),
        "role": current.get("role") or incoming.get("role"),
        "eventCount": int(current.get("eventCount") or 0) + int(incoming.get("eventCount") or 0),
    }


def _fetch_event_payload_rows(normalized_events: list[str], *, payload_column: str) -> list[Dict[str, Any]]:
    params: Dict[str, Any] = {}
    placeholders: list[str] = []
    for index, event in enumerate(normalized_events):
        key = f"event_{index}"
        params[key] = event
        placeholders.append(f"%({key})s")

    return mysql_client.fetch_all(
        f"""
        SELECT event, `{payload_column}` AS payload_value
        FROM usage_tracking
        WHERE event IN ({", ".join(placeholders)})
        """,
        params,
    )


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


def get_event_funnel(
    events: list[str] | tuple[str, ...] | None,
    *,
    actor_key: Optional[str] = None,
) -> Dict[str, Any]:
    normalized_events = _normalize_event_names(events)
    if not normalized_events:
        return {"counts": {}, "actors": []}
    if not _using_mysql():
        return {"counts": {event: 0 for event in normalized_events}, "actors": []}

    columns = _usage_tracking_columns()
    payload_column = _payload_column(columns)
    if "event" not in columns or not payload_column:
        logger.error(
            "usage_tracking table is missing the required columns for analytics. Detected columns: %s",
            sorted(columns) if columns else [],
        )
        return {"counts": {event: 0 for event in normalized_events}, "actors": []}

    rows = _fetch_event_payload_rows(normalized_events, payload_column=payload_column)

    counts = {event: 0 for event in normalized_events}
    actor_summaries: Dict[str, Dict[str, Any]] = {}
    normalized_actor_key = _normalize_actor_key(actor_key)
    for row in rows or []:
        event_name = str((row or {}).get("event") or "").strip()
        if not event_name or event_name not in counts:
            continue
        payload = _parse_payload((row or {}).get("payload_value"))
        instances = _payload_instances(payload)
        if normalized_actor_key:
            counts[event_name] = sum(
                1
                for instance in instances
                if _instance_actor_key(instance) == normalized_actor_key
            )
        else:
            counts[event_name] = _payload_count(payload)

        for instance in instances:
            summary = _instance_actor_summary(instance)
            if not summary:
                continue
            key = str(summary.get("key") or "").strip()
            if not key:
                continue
            actor_summaries[key] = _merge_actor_summary(actor_summaries.get(key) or {}, summary)

    actors = sorted(
        actor_summaries.values(),
        key=lambda item: (
            str(item.get("name") or item.get("email") or item.get("userId") or "").lower(),
            str(item.get("key") or "").lower(),
        ),
    )
    return {"counts": counts, "actors": actors}


def get_event_counts(
    events: list[str] | tuple[str, ...] | None,
    *,
    actor_key: Optional[str] = None,
) -> Dict[str, int]:
    funnel = get_event_funnel(events, actor_key=actor_key)
    return dict(funnel.get("counts") or {})
