from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from ..database import mysql_client
from . import get_config

logger = logging.getLogger(__name__)

_RESOURCE_RE = re.compile(r"^[a-z0-9][a-z0-9._:-]{0,63}$")
_LOCK = threading.Lock()
_MEMORY_VERSIONS: Dict[str, Dict[str, Any]] = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_resource_name(value: object) -> str:
    name = str(value or "").strip().lower()
    if not name or not _RESOURCE_RE.fullmatch(name):
        raise ValueError("Invalid resource name")
    return name


def normalize_resource_names(values: Iterable[object] | None) -> List[str]:
    if values is None:
        return []
    result: List[str] = []
    seen: set[str] = set()
    for value in values:
        try:
            name = normalize_resource_name(value)
        except Exception:
            continue
        if name in seen:
            continue
        seen.add(name)
        result.append(name)
    return result


def parse_resources_param(value: object) -> List[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        raw_values = value
    else:
        raw_values = str(value or "").split(",")
    return normalize_resource_names(raw_values)


def _mysql_enabled() -> bool:
    try:
        return bool(get_config().mysql.get("enabled"))
    except Exception:
        return False


def _metadata_json(metadata: Optional[Dict[str, Any]]) -> Optional[str]:
    if not metadata:
        return None
    try:
        return json.dumps(metadata, separators=(",", ":"), sort_keys=True)
    except Exception:
        return None


def _serialize_row(row: Dict[str, Any]) -> Dict[str, Any]:
    updated_at = row.get("updated_at") or row.get("updatedAt")
    if isinstance(updated_at, datetime):
        updated = updated_at.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    elif updated_at:
        updated = str(updated_at)
    else:
        updated = _now_iso()
    return {
        "resource": str(row.get("resource_name") or row.get("resource") or ""),
        "version": int(row.get("version") or 0),
        "updatedAt": updated,
    }


def _memory_bump(resource_name: str, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    now = _now_iso()
    with _LOCK:
        current = _MEMORY_VERSIONS.get(resource_name) or {
            "resource": resource_name,
            "version": 0,
            "updatedAt": now,
        }
        next_row = {
            "resource": resource_name,
            "version": int(current.get("version") or 0) + 1,
            "updatedAt": now,
        }
        if metadata:
            next_row["metadata"] = dict(metadata)
        _MEMORY_VERSIONS[resource_name] = next_row
        return dict(next_row)


def _memory_get(resources: List[str]) -> Dict[str, Dict[str, Any]]:
    with _LOCK:
        source = _MEMORY_VERSIONS
        if resources:
            names = resources
        else:
            names = sorted(source.keys())
        return {
            name: {
                "resource": name,
                "version": int((source.get(name) or {}).get("version") or 0),
                "updatedAt": (source.get(name) or {}).get("updatedAt") or _now_iso(),
            }
            for name in names
            if name in source
        }


def bump(resource_name: object, *, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    name = normalize_resource_name(resource_name)
    if not _mysql_enabled():
        return _memory_bump(name, metadata=metadata)

    metadata_json = _metadata_json(metadata)
    try:
        mysql_client.execute(
            """
            INSERT INTO resource_versions (resource_name, version, updated_at, metadata_json)
            VALUES (%(resource_name)s, 1, UTC_TIMESTAMP(), %(metadata_json)s)
            ON DUPLICATE KEY UPDATE
                version = version + 1,
                updated_at = UTC_TIMESTAMP(),
                metadata_json = COALESCE(VALUES(metadata_json), metadata_json)
            """,
            {"resource_name": name, "metadata_json": metadata_json},
        )
        row = mysql_client.fetch_one(
            """
            SELECT resource_name, version, updated_at
            FROM resource_versions
            WHERE resource_name = %(resource_name)s
            """,
            {"resource_name": name},
        )
        return _serialize_row(row or {"resource_name": name, "version": 1})
    except Exception:
        logger.warning("Failed to bump resource version", exc_info=True, extra={"resource": name})
        return _memory_bump(name, metadata=metadata)


def bump_many(resources: Iterable[object], *, metadata: Optional[Dict[str, Any]] = None) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    for name in normalize_resource_names(resources):
        try:
            result[name] = bump(name, metadata=metadata)
        except Exception:
            logger.warning("Failed to bump resource version", exc_info=True, extra={"resource": name})
    return result


def bump_safe(resource_name: object, *, metadata: Optional[Dict[str, Any]] = None) -> None:
    try:
        bump(resource_name, metadata=metadata)
    except Exception:
        logger.warning("Resource version bump skipped", exc_info=True, extra={"resource": resource_name})


def bump_many_safe(resources: Iterable[object], *, metadata: Optional[Dict[str, Any]] = None) -> None:
    try:
        bump_many(resources, metadata=metadata)
    except Exception:
        logger.warning("Resource version bump batch skipped", exc_info=True)


def get_versions(resources: Iterable[object] | None = None) -> Dict[str, Dict[str, Any]]:
    names = normalize_resource_names(resources)
    if not _mysql_enabled():
        return _memory_get(names)

    try:
        params: Dict[str, Any] = {}
        where = ""
        if names:
            placeholders = []
            for index, name in enumerate(names):
                key = f"resource_{index}"
                placeholders.append(f"%({key})s")
                params[key] = name
            where = f"WHERE resource_name IN ({', '.join(placeholders)})"
        rows = mysql_client.fetch_all(
            f"""
            SELECT resource_name, version, updated_at
            FROM resource_versions
            {where}
            ORDER BY resource_name ASC
            """,
            params,
        )
        return {
            row["resource"]: row
            for row in (_serialize_row(row or {}) for row in rows or [])
            if row.get("resource")
        }
    except Exception:
        logger.warning("Failed to read resource versions", exc_info=True)
        return _memory_get(names)

