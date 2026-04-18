from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import os
import re
import time
import threading

from flask import Blueprint, Response, request, g

from ..middleware.auth import require_auth, require_media_auth
from ..database import mysql_client
from ..repositories import user_repository
from ..repositories import sales_rep_repository
from ..repositories import sales_prospect_repository
from ..services import get_config
from ..services import auth_service
from ..services import presence_service
from ..services import settings_service  # type: ignore[attr-defined]
from ..services import user_media_service
from ..utils.http import handle_action, is_admin as _is_admin, require_admin as _require_admin, service_error
from ..utils.crypto_envelope import decrypt_text

blueprint = Blueprint("settings", __name__, url_prefix="/api/settings")

_USER_ACTIVITY_CACHE_LOCK = threading.Lock()
_USER_ACTIVITY_CACHE: dict[str, dict] = {}
_USER_ACTIVITY_LONGPOLL_CONCURRENCY = int(os.environ.get("USER_ACTIVITY_LONGPOLL_CONCURRENCY") or 4)
_USER_ACTIVITY_LONGPOLL_CONCURRENCY = max(1, min(_USER_ACTIVITY_LONGPOLL_CONCURRENCY, 20))
_USER_ACTIVITY_LONGPOLL_SEMAPHORE = threading.BoundedSemaphore(_USER_ACTIVITY_LONGPOLL_CONCURRENCY)

_LIVE_CLIENTS_CACHE_LOCK = threading.Lock()
_LIVE_CLIENTS_CACHE: dict[str, dict] = {}
_LIVE_CLIENTS_LONGPOLL_CONCURRENCY = int(os.environ.get("LIVE_CLIENTS_LONGPOLL_CONCURRENCY") or 4)
_LIVE_CLIENTS_LONGPOLL_CONCURRENCY = max(1, min(_LIVE_CLIENTS_LONGPOLL_CONCURRENCY, 20))
_LIVE_CLIENTS_LONGPOLL_SEMAPHORE = threading.BoundedSemaphore(_LIVE_CLIENTS_LONGPOLL_CONCURRENCY)

_LIVE_USERS_CACHE_LOCK = threading.Lock()
_LIVE_USERS_CACHE: dict[str, dict] = {"payload": None, "expiresAt": 0.0}
_LIVE_USERS_LONGPOLL_CONCURRENCY = int(os.environ.get("LIVE_USERS_LONGPOLL_CONCURRENCY") or 12)
_LIVE_USERS_LONGPOLL_CONCURRENCY = max(1, min(_LIVE_USERS_LONGPOLL_CONCURRENCY, 20))
_LIVE_USERS_LONGPOLL_SEMAPHORE = threading.BoundedSemaphore(_LIVE_USERS_LONGPOLL_CONCURRENCY)


def _presence_longpoll_wait_chunk_seconds() -> float:
    raw = os.environ.get("PRESENCE_LONGPOLL_WAIT_CHUNK_SECONDS")
    try:
        value = float(raw) if raw is not None else 5.0
    except Exception:
        value = 5.0
    return max(0.5, min(value, 10.0))


def _wait_for_presence_change(previous_revision: int, *, deadline: float) -> int:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return previous_revision
    timeout_s = min(remaining, _presence_longpoll_wait_chunk_seconds())
    return presence_service.wait_for_change(previous_revision, timeout_s=timeout_s)


def _mysql_enabled() -> bool:
    config = get_config()
    return bool(getattr(config, "mysql", {}).get("enabled"))


def _normalize_bool(value: object) -> bool:
    if value is True or value is False:
        return value
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0.0
        except Exception:
            return False
    text = str(value or "").strip().lower()
    return text in ("1", "true", "yes", "y", "on")


def _normalize_optional_bool(value: object) -> bool | None:
    if value is True or value is False:
        return value
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0.0
        except Exception:
            return None
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text in ("1", "true", "yes", "y", "on"):
        return True
    if text in ("0", "false", "no", "n", "off"):
        return False
    return None


def _normalize_optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _mysql_host_scope() -> str:
    config = get_config()
    host = str(getattr(config, "mysql", {}).get("host") or "").strip().lower()
    return "local" if host in {"", "localhost", "127.0.0.1", "::1"} else "remote"


def _mysql_database_name() -> str:
    config = get_config()
    return str(getattr(config, "mysql", {}).get("database") or "").strip()


def _mysql_host_name() -> str:
    config = get_config()
    return str(getattr(config, "mysql", {}).get("host") or "").strip()


def _mysql_port_number() -> int | None:
    config = get_config()
    try:
        port = int(getattr(config, "mysql", {}).get("port") or 0)
    except (TypeError, ValueError):
        return None
    return port if port > 0 else None


def _mysql_quote_identifier(value: object) -> str:
    name = str(value or "").strip()
    if not name or not re.fullmatch(r"[A-Za-z0-9_]+", name):
        raise service_error("Invalid table name", 400)
    return f"`{name}`"


def _iso_utc_or_none(value: object) -> str | None:
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, str):
        parsed = _parse_iso_datetime(value)
        if parsed:
            return parsed.isoformat().replace("+00:00", "Z")
        raw = value.strip()
        return raw or None
    return None


def _database_visualizer_page(raw: object) -> int:
    try:
        parsed = int(str(raw or "").strip() or "1")
    except (TypeError, ValueError):
        parsed = 1
    return max(1, parsed)


def _database_visualizer_page_size(raw: object) -> int:
    try:
        parsed = int(str(raw or "").strip() or "25")
    except (TypeError, ValueError):
        parsed = 25
    if parsed <= 25:
        return 25
    if parsed <= 50:
        return 50
    return 100


def _database_visualizer_sort_direction(raw: object) -> str:
    return "desc" if str(raw or "").strip().lower() == "desc" else "asc"


def _database_visualizer_search_term(raw: object) -> str | None:
    value = str(raw or "").strip()
    if not value:
        return None
    return value[:120]


def _is_database_visualizer_binary_type(column_type: object) -> bool:
    normalized = str(column_type or "").strip().lower()
    return any(token in normalized for token in ("blob", "binary", "varbinary", "geometry"))


def _is_database_visualizer_searchable_type(column_type: object) -> bool:
    normalized = str(column_type or "").strip().lower()
    if _is_database_visualizer_binary_type(normalized):
        return False
    return any(
        token in normalized
        for token in (
            "char",
            "text",
            "enum",
            "set",
            "json",
            "int",
            "decimal",
            "float",
            "double",
            "real",
            "date",
            "time",
            "year",
            "timestamp",
            "bool",
        )
    )


def _serialize_database_visualizer_value(value: object) -> object:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, datetime):
        return _iso_utc_or_none(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"<binary {len(value)} bytes>"
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _serialize_database_visualizer_cell(value: object) -> dict[str, object]:
    decrypted = False
    normalized = value
    original_text = None
    if isinstance(value, str):
        original_text = value
    elif isinstance(value, (bytes, bytearray)):
        try:
            original_text = bytes(value).decode("utf-8")
        except Exception:
            original_text = None
    if original_text is not None:
        try:
            decrypted_value = decrypt_text(value)
        except Exception:
            decrypted_value = None
        else:
            if decrypted_value is not None and decrypted_value != original_text:
                normalized = decrypted_value
                decrypted = True
    return {
        "value": _serialize_database_visualizer_value(normalized),
        "decrypted": decrypted,
    }


def _load_database_visualizer_payload(
    requested_table: str | None = None,
    *,
    page: int = 1,
    page_size: int = 25,
    sort_column: str | None = None,
    sort_direction: str = "asc",
    search_term: str | None = None,
) -> dict:
    if not _mysql_enabled():
        raise service_error("MySQL is not enabled", 503)

    database_name = _mysql_database_name()
    if not database_name:
        raise service_error("MySQL database is not configured", 500)

    table_rows = mysql_client.fetch_all(
        """
        SELECT
            t.TABLE_NAME AS table_name,
            t.ENGINE AS engine,
            COALESCE(t.DATA_LENGTH, 0) AS data_bytes,
            COALESCE(t.INDEX_LENGTH, 0) AS index_bytes,
            t.UPDATE_TIME AS updated_at,
            COUNT(c.COLUMN_NAME) AS column_count
        FROM information_schema.TABLES t
        LEFT JOIN information_schema.COLUMNS c
            ON c.TABLE_SCHEMA = t.TABLE_SCHEMA
           AND c.TABLE_NAME = t.TABLE_NAME
        WHERE t.TABLE_SCHEMA = %(schema)s
        GROUP BY t.TABLE_NAME, t.ENGINE, t.DATA_LENGTH, t.INDEX_LENGTH, t.UPDATE_TIME
        ORDER BY t.TABLE_NAME ASC
        """,
        {"schema": database_name},
    )

    tables: list[dict] = []
    table_lookup: dict[str, dict] = {}
    for row in table_rows:
        table_name = str(row.get("table_name") or "").strip()
        if not table_name:
            continue
        count_row = mysql_client.fetch_one(
            f"SELECT COUNT(*) AS row_count FROM {_mysql_quote_identifier(table_name)}"
        ) or {}
        summary = {
            "name": table_name,
            "rowCount": int(count_row.get("row_count") or 0),
            "columnCount": int(row.get("column_count") or 0),
            "engine": str(row.get("engine") or "").strip() or None,
            "dataBytes": int(row.get("data_bytes") or 0),
            "indexBytes": int(row.get("index_bytes") or 0),
            "updatedAt": _iso_utc_or_none(row.get("updated_at")),
        }
        tables.append(summary)
        table_lookup[table_name] = summary

    selected_name = str(requested_table or "").strip()
    if selected_name and selected_name not in table_lookup:
        raise service_error("Unknown table", 404)
    if not selected_name and tables:
        selected_name = str(tables[0].get("name") or "")

    selected_table = None
    if selected_name:
        column_rows = mysql_client.fetch_all(
            """
            SELECT
                COLUMN_NAME AS column_name,
                COLUMN_TYPE AS column_type,
                IS_NULLABLE AS is_nullable,
                COLUMN_KEY AS column_key,
                COLUMN_DEFAULT AS column_default,
                EXTRA AS extra,
                ORDINAL_POSITION AS ordinal_position
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = %(schema)s AND TABLE_NAME = %(table_name)s
            ORDER BY ORDINAL_POSITION ASC
            """,
            {"schema": database_name, "table_name": selected_name},
        )
        selected_column_names = [
            str(row.get("column_name") or "").strip()
            for row in column_rows
            if str(row.get("column_name") or "").strip()
        ]
        selected_column_set = set(selected_column_names)
        index_rows = mysql_client.fetch_all(
            """
            SELECT
                INDEX_NAME AS index_name,
                NON_UNIQUE AS non_unique,
                COLUMN_NAME AS column_name,
                SEQ_IN_INDEX AS seq_in_index
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = %(schema)s AND TABLE_NAME = %(table_name)s
            ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC
            """,
            {"schema": database_name, "table_name": selected_name},
        )
        imported_relationship_rows = mysql_client.fetch_all(
            """
            SELECT
                kcu.CONSTRAINT_NAME AS constraint_name,
                kcu.COLUMN_NAME AS column_name,
                kcu.REFERENCED_TABLE_NAME AS referenced_table_name,
                kcu.REFERENCED_COLUMN_NAME AS referenced_column_name,
                rc.UPDATE_RULE AS update_rule,
                rc.DELETE_RULE AS delete_rule
            FROM information_schema.KEY_COLUMN_USAGE kcu
            LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
               AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
               AND rc.TABLE_NAME = kcu.TABLE_NAME
            WHERE kcu.TABLE_SCHEMA = %(schema)s
              AND kcu.TABLE_NAME = %(table_name)s
              AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY kcu.CONSTRAINT_NAME ASC, kcu.ORDINAL_POSITION ASC
            """,
            {"schema": database_name, "table_name": selected_name},
        )
        exported_relationship_rows = mysql_client.fetch_all(
            """
            SELECT
                kcu.CONSTRAINT_NAME AS constraint_name,
                kcu.TABLE_NAME AS source_table_name,
                kcu.COLUMN_NAME AS source_column_name,
                kcu.REFERENCED_COLUMN_NAME AS referenced_column_name,
                rc.UPDATE_RULE AS update_rule,
                rc.DELETE_RULE AS delete_rule
            FROM information_schema.KEY_COLUMN_USAGE kcu
            LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
                ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
               AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
               AND rc.TABLE_NAME = kcu.TABLE_NAME
            WHERE kcu.TABLE_SCHEMA = %(schema)s
              AND kcu.REFERENCED_TABLE_NAME = %(table_name)s
              AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
            ORDER BY kcu.TABLE_NAME ASC, kcu.CONSTRAINT_NAME ASC, kcu.ORDINAL_POSITION ASC
            """,
            {"schema": database_name, "table_name": selected_name},
        )
        show_create_row = mysql_client.fetch_one(
            f"SHOW CREATE TABLE {_mysql_quote_identifier(selected_name)}"
        ) or {}
        index_map: dict[str, dict] = {}
        for row in index_rows:
            index_name = str(row.get("index_name") or "").strip()
            if not index_name:
                continue
            bucket = index_map.setdefault(
                index_name,
                {
                    "name": index_name,
                    "unique": not bool(row.get("non_unique")),
                    "columns": [],
                },
            )
            column_name = str(row.get("column_name") or "").strip()
            if column_name:
                bucket["columns"].append(column_name)

        searchable_columns = [
            str(row.get("column_name") or "").strip()
            for row in column_rows
            if str(row.get("column_name") or "").strip()
            and _is_database_visualizer_searchable_type(row.get("column_type"))
        ]
        primary_index = index_map.get("PRIMARY") or {}
        default_sort_column = (
            str((primary_index.get("columns") or [None])[0] or "").strip()
            or (selected_column_names[0] if selected_column_names else "")
        )
        normalized_sort_column = str(sort_column or "").strip()
        if normalized_sort_column not in selected_column_set:
            normalized_sort_column = default_sort_column
        normalized_sort_direction = sort_direction if sort_direction == "desc" else "asc"
        preview_page = max(1, page)
        preview_page_size = _database_visualizer_page_size(page_size)
        preview_offset = (preview_page - 1) * preview_page_size
        preview_where_sql = ""
        preview_params: dict[str, object] = {}
        if search_term and searchable_columns:
            preview_params["search_term"] = f"%{search_term}%"
            preview_where_sql = " WHERE " + " OR ".join(
                [
                    f"CAST({_mysql_quote_identifier(column_name)} AS CHAR) LIKE %(search_term)s"
                    for column_name in searchable_columns
                ]
            )
        preview_count_row = mysql_client.fetch_one(
            f"SELECT COUNT(*) AS row_count FROM {_mysql_quote_identifier(selected_name)}{preview_where_sql}",
            preview_params,
        ) or {}
        filtered_row_count = int(preview_count_row.get("row_count") or 0)
        preview_total_pages = max(
            1,
            (filtered_row_count + preview_page_size - 1) // preview_page_size,
        )
        if preview_page > preview_total_pages:
            preview_page = preview_total_pages
            preview_offset = (preview_page - 1) * preview_page_size
        preview_rows = mysql_client.fetch_all(
            f"""
            SELECT *
            FROM {_mysql_quote_identifier(selected_name)}
            {preview_where_sql}
            ORDER BY {_mysql_quote_identifier(normalized_sort_column)} {normalized_sort_direction.upper()}
            LIMIT %(limit)s OFFSET %(offset)s
            """,
            {
                **preview_params,
                "limit": preview_page_size,
                "offset": preview_offset,
            },
        )
        create_statement = None
        for key, value in show_create_row.items():
            if str(key).strip().lower().startswith("create"):
                create_statement = str(value or "").strip() or None
                break

        selected_table = {
            **table_lookup[selected_name],
            "columns": [
                {
                    "name": str(row.get("column_name") or "").strip(),
                    "type": str(row.get("column_type") or "").strip(),
                    "nullable": str(row.get("is_nullable") or "").strip().upper() == "YES",
                    "key": str(row.get("column_key") or "").strip() or None,
                    "defaultValue": None if row.get("column_default") is None else str(row.get("column_default")),
                    "extra": str(row.get("extra") or "").strip() or None,
                    "position": int(row.get("ordinal_position") or 0),
                }
                for row in column_rows
            ],
            "indexes": list(index_map.values()),
            "relationships": {
                "imports": [
                    {
                        "constraintName": str(row.get("constraint_name") or "").strip() or None,
                        "columnName": str(row.get("column_name") or "").strip() or None,
                        "referencedTable": str(row.get("referenced_table_name") or "").strip() or None,
                        "referencedColumn": str(row.get("referenced_column_name") or "").strip() or None,
                        "updateRule": str(row.get("update_rule") or "").strip() or None,
                        "deleteRule": str(row.get("delete_rule") or "").strip() or None,
                    }
                    for row in imported_relationship_rows
                ],
                "exports": [
                    {
                        "constraintName": str(row.get("constraint_name") or "").strip() or None,
                        "sourceTable": str(row.get("source_table_name") or "").strip() or None,
                        "sourceColumn": str(row.get("source_column_name") or "").strip() or None,
                        "referencedColumn": str(row.get("referenced_column_name") or "").strip() or None,
                        "updateRule": str(row.get("update_rule") or "").strip() or None,
                        "deleteRule": str(row.get("delete_rule") or "").strip() or None,
                    }
                    for row in exported_relationship_rows
                ],
            },
            "createStatement": create_statement,
            "preview": {
                "page": preview_page,
                "pageSize": preview_page_size,
                "totalRowCount": int(table_lookup[selected_name].get("rowCount") or 0),
                "filteredRowCount": filtered_row_count,
                "totalPages": preview_total_pages,
                "sortColumn": normalized_sort_column or None,
                "sortDirection": normalized_sort_direction,
                "searchTerm": search_term,
                "searchableColumns": searchable_columns,
                "rows": [
                    {
                        "rowNumber": preview_offset + index + 1,
                        "values": {
                            column_name: _serialize_database_visualizer_cell(row.get(column_name))
                            for column_name in selected_column_names
                        },
                    }
                    for index, row in enumerate(preview_rows)
                ],
            },
        }

    return {
        "mysqlEnabled": True,
        "databaseName": database_name,
        "databaseHost": _mysql_host_name() or None,
        "databasePort": _mysql_port_number(),
        "hostScope": _mysql_host_scope(),
        "refreshedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "tables": tables,
        "selectedTable": selected_table,
    }

def _is_sales_lead() -> bool:
    role = str((getattr(g, "current_user", None) or {}).get("role") or "").strip().lower()
    return role in ("sales_lead", "saleslead", "sales-lead")

def _require_admin_or_sales_lead():
    if not (_is_admin() or _is_sales_lead()):
        from ..utils.http import service_error
        raise service_error("Admin access required", 403)


def _public_user_profile(
    user: dict,
    *,
    by_id: dict[str, dict] | None = None,
    by_legacy_user_id: dict[str, dict] | None = None,
    by_email: dict[str, dict] | None = None,
    profile_image_scope: str = "admin",
) -> dict:
    if not isinstance(user, dict):
        return {}
    if by_id is not None and by_legacy_user_id is not None and by_email is not None:
        rep = _resolve_sales_rep_for_user(
            user,
            by_id=by_id,
            by_legacy_user_id=by_legacy_user_id,
            by_email=by_email,
        )
        is_partner, allowed_retail = _resolve_network_partner_flags(
            user,
            by_id=by_id,
            by_legacy_user_id=by_legacy_user_id,
            by_email=by_email,
        )
    else:
        rep = _resolve_current_sales_rep_record(user)
        is_partner, allowed_retail = _resolve_network_partner_flags(user)

    sales_rep_id = _normalize_optional_text(user.get("salesRepId") or user.get("sales_rep_id"))
    if sales_rep_id is None and isinstance(rep, dict):
        sales_rep_id = _normalize_optional_text(
            rep.get("id") or rep.get("salesRepId") or rep.get("sales_rep_id")
        )
    jurisdiction = _normalize_optional_text(
        (rep.get("jurisdiction") if isinstance(rep, dict) else None) or user.get("jurisdiction")
    )
    if profile_image_scope == "network":
        profile_image_url = user_media_service.resolve_network_user_profile_image_url(
            user.get("id"),
            user.get("profileImageUrl"),
        )
    else:
        profile_image_url = user_media_service.resolve_admin_user_profile_image_url(
            user.get("id"),
            user.get("profileImageUrl"),
        )

    return {
        "id": user.get("id"),
        "name": user.get("name") or None,
        "email": user.get("email") or None,
        "role": user.get("role") or None,
        "status": user.get("status") or None,
        "handDelivered": _normalize_bool(
            user.get("handDelivered")
            if "handDelivered" in user
            else user.get("hand_delivered")
        ),
        "isOnline": bool(user.get("isOnline")),
        "lastLoginAt": user.get("lastLoginAt") or None,
        "createdAt": user.get("createdAt") or None,
        "profileImageUrl": profile_image_url,
        "greaterArea": user.get("greaterArea") or None,
        "studyFocus": user.get("studyFocus") or None,
        "bio": user.get("bio") or None,
        "networkPresenceAgreement": _normalize_bool(
            user.get("networkPresenceAgreement")
            if "networkPresenceAgreement" in user
            else user.get("network_presence_agreement")
        ),
        "resellerPermitFilePath": user.get("resellerPermitFilePath") or user.get("reseller_permit_file_path") or None,
        "resellerPermitFileName": user.get("resellerPermitFileName") or user.get("reseller_permit_file_name") or None,
        "resellerPermitUploadedAt": user.get("resellerPermitUploadedAt") or user.get("reseller_permit_uploaded_at") or None,
        "supplementalProfileLoaded": True,
        "phone": _normalize_optional_text(user.get("phone") or (rep.get("phone") if isinstance(rep, dict) else None)),
        "officeAddressLine1": user.get("officeAddressLine1") or None,
        "officeAddressLine2": user.get("officeAddressLine2") or None,
        "officeCity": user.get("officeCity") or None,
        "officeState": user.get("officeState") or None,
        "officePostalCode": user.get("officePostalCode") or None,
        "officeCountry": user.get("officeCountry") or None,
        "salesRepId": sales_rep_id,
        "isPartner": is_partner,
        "allowedRetail": allowed_retail,
        "jurisdiction": jurisdiction,
        "leadType": user.get("leadType") or None,
        "leadTypeSource": user.get("leadTypeSource") or None,
        "leadTypeLockedAt": user.get("leadTypeLockedAt") or None,
        "referralCredits": user.get("referralCredits"),
        "totalReferrals": user.get("totalReferrals"),
        "npiNumber": user.get("npiNumber") or None,
        "npiStatus": user.get("npiStatus") or None,
        "npiLastVerifiedAt": user.get("npiLastVerifiedAt") or None,
    }

def _normalize_role(value: object) -> str:
    return re.sub(r"[\s-]+", "_", str(value or "").strip().lower())

def _is_admin_role(role: str) -> bool:
    return _normalize_role(role) == "admin"

def _is_sales_rep_role(role: str) -> bool:
    normalized = _normalize_role(role)
    return normalized in ("sales_rep", "sales_partner", "test_rep", "rep", "sales_lead", "saleslead", "sales-lead")

def _is_sales_lead_role(role: str) -> bool:
    normalized = _normalize_role(role)
    return normalized in ("sales_lead", "saleslead", "sales-lead")

def _require_sales_rep_or_admin():
    role = _normalize_role((getattr(g, "current_user", None) or {}).get("role"))
    if not (_is_admin_role(role) or _is_sales_rep_role(role)):
        err = RuntimeError("Sales rep access required")
        setattr(err, "status", 403)
        raise err


def _resolve_visible_user_ids_for_current_actor(current_user: dict, current_role: str) -> set[str] | None:
    if _is_admin_role(current_role) or _is_sales_lead_role(current_role):
        return None

    base_owner_id = str(current_user.get("id") or "").strip()
    if not base_owner_id:
        err = RuntimeError("salesRepId is required")
        setattr(err, "status", 400)
        raise err

    strict_assignment = _is_sales_rep_role(current_role) and not _is_sales_lead_role(current_role)
    payload = _compute_live_clients_cached_with_scope(
        target_sales_rep_id=base_owner_id,
        strict_assignment=strict_assignment,
    )
    return {
        str(entry.get("id") or "").strip()
        for entry in (payload.get("clients") or [])
        if isinstance(entry, dict) and str(entry.get("id") or "").strip()
    }


def _normalize_hand_delivery_role(role: object) -> str:
    normalized = _normalize_role(role)
    if normalized in ("saleslead", "sales_lead"):
        return "sales_lead"
    if normalized == "rep":
        return "sales_rep"
    return normalized


def _is_hand_delivery_role(role: str) -> bool:
    normalized = _normalize_hand_delivery_role(role)
    return normalized in ("sales_rep", "sales_partner", "sales_lead", "admin")


def _is_doctor_user(user: dict) -> bool:
    role = _normalize_role(user.get("role"))
    return role in ("doctor", "test_doctor")

def _is_test_doctor_user(user: dict | None) -> bool:
    return _normalize_role((user or {}).get("role")) == "test_doctor"


def _exclude_from_physician_network(user: dict | None) -> bool:
    if _is_test_doctor_user(user):
        return True
    email = (_normalize_optional_text((user or {}).get("email")) or "").lower()
    return email == "test@doctor.com"


def _is_physician_network_visible_user(user: dict | None) -> bool:
    if not isinstance(user, dict):
        return False
    if not _is_doctor_user(user):
        return False
    if _exclude_from_physician_network(user):
        return False
    if not _normalize_bool(user.get("profileOnboarding", user.get("profile_onboarding"))):
        return False
    if not _normalize_bool(user.get("networkPresenceAgreement", user.get("network_presence_agreement"))):
        return False
    if not _normalize_bool(user.get("researchTermsAgreement", user.get("research_terms_agreement"))):
        return False
    return True


def _get_delegate_links_doctors() -> list[dict]:
    doctors = []
    for user in user_repository.get_all() or []:
        if not isinstance(user, dict):
            continue
        if _normalize_role(user.get("role")) != "doctor":
            continue
        user_id = str(user.get("id") or "").strip()
        if not user_id:
            continue
        doctors.append(
            {
                "userId": user_id,
                "name": str(user.get("name") or "").strip()
                or str(user.get("email") or "").strip()
                or f"Doctor {user_id}",
                "email": str(user.get("email") or "").strip().lower() or None,
                "delegateLinksEnabled": bool(user.get("delegateLinksEnabled")),
            }
        )
    doctors.sort(key=lambda row: (str(row.get("name") or "").lower(), str(row.get("email") or "")))
    return doctors


def _migrate_legacy_delegate_links_to_users() -> None:
    legacy_ids = [
        str(value).strip()
        for value in (settings_service.get_settings().get("patientLinksDoctorUserIds") or [])
        if str(value).strip()
    ]
    if not legacy_ids:
        return
    selected_ids = set(legacy_ids)
    migrated_any = False
    for doctor in user_repository.get_all() or []:
        if not isinstance(doctor, dict):
            continue
        if _normalize_role(doctor.get("role")) != "doctor":
            continue
        doctor_id = str(doctor.get("id") or "").strip()
        if not doctor_id or doctor_id not in selected_ids:
            continue
        if bool(doctor.get("delegateLinksEnabled")):
            migrated_any = True
            continue
        user_repository.update({**doctor, "delegateLinksEnabled": True})
        migrated_any = True
    if migrated_any:
        settings_service.update_settings({"patientLinksDoctorUserIds": []})


def _build_physician_network_entries() -> list[dict]:
    doctors: list[dict] = []
    for user in user_repository.get_all() or []:
        if not _is_physician_network_visible_user(user):
            continue
        profile = _public_user_profile(user, profile_image_scope="network")
        doctor_id = str(profile.get("id") or "").strip()
        if not doctor_id:
            continue
        doctors.append(
            {
                "id": doctor_id,
                "name": profile.get("name") or profile.get("email") or "Physician",
                "email": profile.get("email") or None,
                "profileImageUrl": profile.get("profileImageUrl") or None,
                "greaterArea": profile.get("greaterArea") or None,
                "studyFocus": profile.get("studyFocus") or None,
                "bio": profile.get("bio") or None,
                "officeCity": profile.get("officeCity") or None,
                "officeState": profile.get("officeState") or None,
                "lastLoginAt": profile.get("lastLoginAt") or None,
            }
        )
    def _sort_key(row: dict) -> tuple[float, str, str]:
        raw_last_login = row.get("lastLoginAt")
        parsed = _parse_iso_datetime(raw_last_login if isinstance(raw_last_login, str) else None)
        timestamp = parsed.timestamp() if parsed else float("-inf")
        return (-timestamp, str(row.get("name") or "").strip().lower(), str(row.get("id") or "").strip())

    doctors.sort(key=_sort_key)
    return doctors


def _build_sales_rep_indexes(reps: list[dict]) -> tuple[dict[str, dict], dict[str, dict], dict[str, dict]]:
    by_id: dict[str, dict] = {}
    by_legacy_user_id: dict[str, dict] = {}
    by_email: dict[str, dict] = {}
    for rep in reps or []:
        if not isinstance(rep, dict):
            continue
        rep_id = str(rep.get("id") or "").strip()
        if rep_id:
            by_id[rep_id] = rep
        legacy_user_id = str(rep.get("legacyUserId") or rep.get("legacy_user_id") or "").strip()
        if legacy_user_id and legacy_user_id not in by_legacy_user_id:
            by_legacy_user_id[legacy_user_id] = rep
        email = str(rep.get("email") or "").strip().lower()
        if email and email not in by_email:
            by_email[email] = rep
    return by_id, by_legacy_user_id, by_email


def _resolve_sales_rep_for_user(
    user: dict,
    *,
    by_id: dict[str, dict],
    by_legacy_user_id: dict[str, dict],
    by_email: dict[str, dict],
) -> dict | None:
    if not isinstance(user, dict):
        return None
    user_id = str(user.get("id") or "").strip()
    user_sales_rep_id = str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
    user_email = str(user.get("email") or "").strip().lower()

    for candidate_id in (user_sales_rep_id, user_id):
        if candidate_id and candidate_id in by_id:
            return by_id[candidate_id]

    if user_id and user_id in by_legacy_user_id:
        return by_legacy_user_id[user_id]

    if user_email and user_email in by_email:
        return by_email[user_email]

    return None


def _serialize_hand_delivery_entry(user: dict, rep: dict | None) -> dict:
    user_id = str(user.get("id") or "").strip()
    role = _normalize_hand_delivery_role(user.get("role"))
    jurisdiction_raw = None
    if isinstance(rep, dict):
        jurisdiction_raw = rep.get("jurisdiction")
    jurisdiction = str(jurisdiction_raw or "").strip().lower() or None
    is_local = jurisdiction == "local"
    return {
        "userId": user_id or None,
        "salesRepId": str(rep.get("id") or "").strip() if isinstance(rep, dict) else None,
        "name": str(user.get("name") or "").strip() or str(user.get("email") or "").strip() or (user_id or "User"),
        "role": role or "unknown",
        "jurisdiction": "local" if is_local else jurisdiction,
        "isLocal": is_local,
    }

def _resolve_current_sales_rep_record(current_user: dict) -> dict | None:
    try:
        reps = sales_rep_repository.get_all() or []
    except Exception:
        reps = []
    by_id, by_legacy_user_id, by_email = _build_sales_rep_indexes(reps)
    return _resolve_sales_rep_for_user(
        current_user or {},
        by_id=by_id,
        by_legacy_user_id=by_legacy_user_id,
        by_email=by_email,
    )


def _resolve_network_partner_flags(
    user: dict,
    *,
    by_id: dict[str, dict] | None = None,
    by_legacy_user_id: dict[str, dict] | None = None,
    by_email: dict[str, dict] | None = None,
) -> tuple[bool | None, bool | None]:
    role = _normalize_role((user or {}).get("role"))
    rep_like_role = role in ("sales_rep", "sales_partner", "rep", "test_rep")
    if not rep_like_role:
        return (
            _normalize_optional_bool((user or {}).get("isPartner")),
            _normalize_optional_bool((user or {}).get("allowedRetail")),
        )
    rep = None
    if by_id is not None and by_legacy_user_id is not None and by_email is not None:
        rep = _resolve_sales_rep_for_user(
            user or {},
            by_id=by_id,
            by_legacy_user_id=by_legacy_user_id,
            by_email=by_email,
        )
    else:
        rep = _resolve_current_sales_rep_record(user or {})
    if isinstance(rep, dict):
        return (
            _normalize_bool(rep.get("isPartner") if "isPartner" in rep else rep.get("is_partner")),
            _normalize_optional_bool(
                rep.get("allowedRetail") if "allowedRetail" in rep else rep.get("allowed_retail")
            ),
        )
    return (
        _normalize_optional_bool((user or {}).get("isPartner")),
        _normalize_optional_bool((user or {}).get("allowedRetail")),
    )

def _require_local_jurisdiction_for_sales_rep(current_user: dict) -> None:
    role = _normalize_role((current_user or {}).get("role"))
    if _is_admin_role(role):
        return
    rep = _resolve_current_sales_rep_record(current_user or {})
    jurisdiction = str((rep or {}).get("jurisdiction") or "").strip().lower()
    if jurisdiction != "local":
        err = RuntimeError("Sales rep local jurisdiction required")
        setattr(err, "status", 403)
        raise err

def _is_doctor_role(role: object) -> bool:
    normalized = _normalize_role(role)
    return normalized in ("doctor", "test_doctor")

def _build_hand_delivery_doctor_entries(owner_ids: set[str]) -> list[dict]:
    normalized_owner_ids = {str(value).strip() for value in (owner_ids or set()) if str(value).strip()}
    if not normalized_owner_ids:
        return []

    try:
        prospects = sales_prospect_repository.get_all() or []
    except Exception:
        prospects = []

    doctor_id_set = {
        str(record.get("doctorId") or record.get("doctor_id") or "").strip()
        for record in prospects
        if isinstance(record, dict) and str(record.get("salesRepId") or record.get("sales_rep_id") or "").strip() in normalized_owner_ids
    }
    doctor_id_set = {value for value in doctor_id_set if value}

    email_set = {
        str(record.get("contactEmail") or record.get("contact_email") or "").strip().lower()
        for record in prospects
        if isinstance(record, dict) and str(record.get("salesRepId") or record.get("sales_rep_id") or "").strip() in normalized_owner_ids
    }
    email_set = {value for value in email_set if value and "@" in value}

    users = user_repository.get_all() or []
    entries: list[dict] = []
    for user in users:
        if not isinstance(user, dict):
            continue
        if not _is_doctor_role(user.get("role")):
            continue
        user_id = str(user.get("id") or "").strip()
        user_email = str(user.get("email") or "").strip().lower()
        direct_owner_id = str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
        if not (
            (direct_owner_id and direct_owner_id in normalized_owner_ids)
            or (user_id and user_id in doctor_id_set)
            or (user_email and user_email in email_set)
        ):
            continue
        entries.append(
            {
                "userId": user_id,
                "salesRepId": direct_owner_id or None,
                "name": str(user.get("name") or "").strip()
                or str(user.get("email") or "").strip()
                or (user_id or "Doctor"),
                "email": user_email or None,
                "role": _normalize_role(user.get("role") or ""),
                "handDelivered": _normalize_bool(
                    user.get("handDelivered")
                    if "handDelivered" in user
                    else user.get("hand_delivered")
                ),
            }
        )

    entries.sort(key=lambda row: (str(row.get("name") or "").lower(), str(row.get("email") or "")))
    return entries

def _compute_allowed_sales_rep_ids(
    sales_rep_id: str,
    *,
    include_user_role_email_matches: bool = True,
) -> set[str]:
    """
    Sales-rep references can be stored under multiple ids over time:
    - sales_reps.id
    - sales_reps.legacyUserId (older user-based reps)
    - users.id (role=sales_rep)
    Match all reasonable equivalents so reps see their assigned doctors.
    """
    normalized_sales_rep_id = str(sales_rep_id or "").strip()
    allowed: set[str] = {normalized_sales_rep_id} if normalized_sales_rep_id else set()

    try:
        reps = sales_rep_repository.get_all() or []
    except Exception:
        reps = []
    rep_records: dict[str, dict] = {}
    for rep in reps:
        if not isinstance(rep, dict):
            continue
        rep_id = str(rep.get("id") or "").strip()
        if rep_id:
            rep_records[rep_id] = rep

    legacy_map = {
        str(rep.get("legacyUserId")).strip(): rep_id
        for rep_id, rep in rep_records.items()
        if rep.get("legacyUserId")
    }

    rep_record_id = legacy_map.get(normalized_sales_rep_id)
    if rep_record_id:
        allowed.add(str(rep_record_id))

    def add_legacy_user_id(rep: dict | None) -> None:
        if not isinstance(rep, dict):
            return
        legacy_user_id = str(rep.get("legacyUserId") or "").strip()
        if legacy_user_id:
            allowed.add(legacy_user_id)

    direct_rep_record = rep_records.get(normalized_sales_rep_id) if normalized_sales_rep_id else None
    add_legacy_user_id(direct_rep_record if isinstance(direct_rep_record, dict) else None)
    add_legacy_user_id(rep_records.get(str(rep_record_id)) if rep_record_id else None)

    # Cross-link via email when the sales rep has both a `users` row and a `sales_reps` row.
    try:
        users = user_repository.list_presence_projection_users() or []
    except Exception:
        users = []

    rep_user = next((u for u in users if str((u or {}).get("id") or "") == normalized_sales_rep_id), None)
    rep_user_email = (rep_user.get("email") or "").strip().lower() if isinstance(rep_user, dict) else ""
    if rep_user_email:
        for rep_id, rep in rep_records.items():
            if (rep.get("email") or "").strip().lower() == rep_user_email:
                allowed.add(str(rep_id))
                add_legacy_user_id(rep)

    rep_email_candidates = set()
    if rep_user_email:
        rep_email_candidates.add(rep_user_email)
    for record in (
        direct_rep_record if isinstance(direct_rep_record, dict) else None,
        rep_records.get(str(rep_record_id)) if rep_record_id else None,
    ):
        if isinstance(record, dict):
            email = (record.get("email") or "").strip().lower()
            if email:
                rep_email_candidates.add(email)

    if include_user_role_email_matches and rep_email_candidates:
        for user in users:
            if not isinstance(user, dict):
                continue
            email = (user.get("email") or "").strip().lower()
            if not email or email not in rep_email_candidates:
                continue
            role = (user.get("role") or "").lower()
            if role in ("sales_rep", "sales_partner", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
                allowed.add(str(user.get("id")))

    return {value for value in allowed if str(value or "").strip()}

def _compute_presence_snapshot(user: dict, *, now_epoch: float, online_threshold_s: float, idle_threshold_s: float, presence: dict) -> dict:
    user_id = str(user.get("id") or "")
    presence_entry = presence.get(user_id)
    presence_public = presence_service.to_public_fields(presence_entry)

    last_login_dt = _parse_iso_datetime(user.get("lastLoginAt") or None)
    last_seen_dt = _parse_iso_datetime(user.get("lastSeenAt") or None)
    last_interaction_dt = _parse_iso_datetime(user.get("lastInteractionAt") or None)

    last_seen_epoch = None
    try:
        raw_seen = presence_entry.get("lastHeartbeatAt") if isinstance(presence_entry, dict) else None
        if isinstance(raw_seen, (int, float)) and float(raw_seen) > 0:
            last_seen_epoch = float(raw_seen)
    except Exception:
        last_seen_epoch = None
    if last_seen_epoch is None and last_seen_dt:
        last_seen_epoch = float(last_seen_dt.timestamp())

    derived_online = presence_service.is_recent_epoch(
        last_seen_epoch,
        now_epoch=now_epoch,
        threshold_s=online_threshold_s,
    )
    if derived_online and not bool(user.get("isOnline")):
        derived_online = False

    idle_anchor_epoch = None
    try:
        raw_interaction = presence_entry.get("lastInteractionAt") if isinstance(presence_entry, dict) else None
        if isinstance(raw_interaction, (int, float)) and float(raw_interaction) > 0:
            idle_anchor_epoch = float(raw_interaction)
    except Exception:
        idle_anchor_epoch = None
    if idle_anchor_epoch is None and last_interaction_dt:
        idle_anchor_epoch = float(last_interaction_dt.timestamp())
    if idle_anchor_epoch is None and last_login_dt:
        idle_anchor_epoch = float(last_login_dt.timestamp())
    if idle_anchor_epoch is None and last_seen_epoch is not None:
        idle_anchor_epoch = float(last_seen_epoch)

    computed_idle = None
    if derived_online and isinstance(idle_anchor_epoch, (int, float)) and float(idle_anchor_epoch) > 0:
        computed_idle = (now_epoch - float(idle_anchor_epoch)) >= idle_threshold_s

    idle_minutes = None
    if isinstance(idle_anchor_epoch, (int, float)) and float(idle_anchor_epoch) > 0:
        idle_minutes = max(0, int((now_epoch - float(idle_anchor_epoch)) // 60))

    online_minutes = None
    if last_login_dt:
        online_minutes = max(0, int((now_epoch - float(last_login_dt.timestamp())) // 60))

    last_seen_at = presence_public.get("lastSeenAt") or user.get("lastSeenAt") or None
    last_interaction_at = presence_public.get("lastInteractionAt") or user.get("lastInteractionAt") or None

    return {
        "isOnline": derived_online,
        "isIdle": computed_idle,
        "lastLoginAt": user.get("lastLoginAt") or None,
        "lastSeenAt": last_seen_at,
        "lastInteractionAt": last_interaction_at,
        "idleMinutes": idle_minutes,
        "onlineMinutes": online_minutes,
    }

def _compute_live_clients_payload(
    *,
    target_sales_rep_id: str,
    strict_assignment: bool = False,
) -> dict:
    all_users = user_repository.list_presence_projection_users()

    allowed_rep_ids = _compute_allowed_sales_rep_ids(
        target_sales_rep_id,
        include_user_role_email_matches=not strict_assignment,
    )
    prospects = sales_prospect_repository.find_by_sales_rep(target_sales_rep_id)
    doctor_ids = {
        str(p.get("doctorId")).strip()
        for p in (prospects or [])
        if p and p.get("doctorId")
    }
    contact_emails = {
        str(p.get("contactEmail") or "").strip().lower()
        for p in (prospects or [])
        if p and p.get("contactEmail")
    }
    contact_emails = {e for e in contact_emails if e and "@" in e}

    candidate_by_id: dict[str, dict] = {}
    sales_actor_by_id: dict[str, dict] = {}
    for user in all_users or []:
        if not isinstance(user, dict):
            continue
        user_role = _normalize_role(user.get("role"))
        if user_role in ("admin", "sales_partner", "sales_lead", "saleslead", "sales-lead"):
            uid = str(user.get("id") or "").strip()
            if uid:
                sales_actor_by_id[uid] = user
            continue
        if user_role not in ("doctor", "test_doctor"):
            continue
        uid = str(user.get("id") or "").strip()
        if not uid:
            continue
        email = str(user.get("email") or "").strip().lower()
        doctor_sales_rep_id = str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
        if doctor_sales_rep_id and doctor_sales_rep_id in allowed_rep_ids:
            candidate_by_id[uid] = user
            continue
        if uid in doctor_ids:
            candidate_by_id[uid] = user
            continue
        if email and email in contact_emails:
            candidate_by_id[uid] = user

    now_epoch = time.time()
    online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
    online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
    idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
    idle_threshold_s = max(60.0, min(idle_threshold_s, 6 * 60 * 60))
    presence = presence_service.snapshot()

    try:
        reps = sales_rep_repository.get_all() or []
    except Exception:
        reps = []
    rep_by_id, rep_by_legacy_user_id, rep_by_email = _build_sales_rep_indexes(reps)

    clients = []
    visible_users = list(candidate_by_id.values()) + list(sales_actor_by_id.values())
    for user in visible_users:
        is_partner, allowed_retail = _resolve_network_partner_flags(
            user,
            by_id=rep_by_id,
            by_legacy_user_id=rep_by_legacy_user_id,
            by_email=rep_by_email,
        )
        snapshot = _compute_presence_snapshot(
            user,
            now_epoch=now_epoch,
            online_threshold_s=online_threshold_s,
            idle_threshold_s=idle_threshold_s,
            presence=presence,
        )
        clients.append(
            {
                "id": user.get("id"),
                "name": user.get("name") or None,
                "email": user.get("email") or None,
                "role": _normalize_role(user.get("role")) or "unknown",
                "isPartner": is_partner,
                "allowedRetail": allowed_retail,
                **snapshot,
            }
        )

    # Sort online+active, online+idle, then offline.
    clients.sort(
        key=lambda entry: (
            0 if bool(entry.get("isOnline")) and not bool(entry.get("isIdle"))
            else 1 if bool(entry.get("isOnline"))
            else 2,
            str(entry.get("name") or entry.get("email") or entry.get("id") or "").lower(),
        )
    )

    sig = [
        {
            "id": entry.get("id"),
            "isOnline": bool(entry.get("isOnline")),
            "isIdle": bool(entry.get("isIdle")),
            "lastLoginAt": entry.get("lastLoginAt") or None,
            "lastSeenAt": entry.get("lastSeenAt") or None,
            "lastInteractionAt": entry.get("lastInteractionAt") or None,
            "isPartner": _normalize_optional_bool(entry.get("isPartner")),
            "allowedRetail": _normalize_optional_bool(entry.get("allowedRetail")),
        }
        for entry in clients
    ]
    sig.sort(key=lambda entry: str(entry.get("id") or ""))
    etag = hashlib.sha256(
        json.dumps({"salesRepId": target_sales_rep_id, "clients": sig}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    return {
        "etag": etag,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "salesRepId": target_sales_rep_id,
        "clients": clients,
        "total": len(clients),
    }

def _compute_live_clients_cached(*, target_sales_rep_id: str) -> dict:
    return _compute_live_clients_cached_with_scope(
        target_sales_rep_id=target_sales_rep_id,
        strict_assignment=False,
    )


def _compute_live_clients_cached_with_scope(
    *,
    target_sales_rep_id: str,
    strict_assignment: bool,
) -> dict:
    now = time.monotonic()
    ttl_s = float(os.environ.get("LIVE_CLIENTS_CACHE_TTL_SECONDS") or 1.0)
    ttl_s = max(0.25, min(ttl_s, 5.0))

    normalized_target_sales_rep_id = str(target_sales_rep_id or "").strip()
    cache_key = (
        f"{normalized_target_sales_rep_id}:strict"
        if strict_assignment
        else normalized_target_sales_rep_id
    )
    with _LIVE_CLIENTS_CACHE_LOCK:
        cached = _LIVE_CLIENTS_CACHE.get(cache_key) or {}
        cached_at = float(cached.get("at") or 0.0)
        if cached and cached_at > 0 and (now - cached_at) < ttl_s:
            payload = cached.get("payload")
            if isinstance(payload, dict):
                return payload

    payload = _compute_live_clients_payload(
        target_sales_rep_id=normalized_target_sales_rep_id,
        strict_assignment=strict_assignment,
    )
    with _LIVE_CLIENTS_CACHE_LOCK:
        _LIVE_CLIENTS_CACHE[cache_key] = {"at": now, "payload": payload}
    return payload


def _compute_live_users_payload() -> dict:
    users = user_repository.list_presence_projection_users()
    users_by_id: dict[str, dict] = {}

    for user in users or []:
        if not isinstance(user, dict):
            continue
        uid = str(user.get("id") or "").strip()
        if not uid:
            continue
        users_by_id[uid] = user

    # Admin Live Users should only reflect the canonical `users` table to avoid duplicates.

    def normalize_user_role(value: object) -> str:
        normalized = _normalize_role(value)
        return normalized or "unknown"

    now_epoch = time.time()
    online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
    online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
    idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
    idle_threshold_s = max(10.0, min(idle_threshold_s, 6 * 60 * 60))
    presence = presence_service.snapshot()

    try:
        reps = sales_rep_repository.get_all() or []
    except Exception:
        reps = []
    rep_by_id, rep_by_legacy_user_id, rep_by_email = _build_sales_rep_indexes(reps)

    entries = []
    for user in users_by_id.values():
        is_partner, allowed_retail = _resolve_network_partner_flags(
            user,
            by_id=rep_by_id,
            by_legacy_user_id=rep_by_legacy_user_id,
            by_email=rep_by_email,
        )
        snapshot = _compute_presence_snapshot(
            user,
            now_epoch=now_epoch,
            online_threshold_s=online_threshold_s,
            idle_threshold_s=idle_threshold_s,
            presence=presence,
        )
        entries.append(
            {
                "id": user.get("id"),
                "name": user.get("name") or None,
                "email": user.get("email") or None,
                "role": normalize_user_role(user.get("role")),
                "isPartner": is_partner,
                "allowedRetail": allowed_retail,
                **snapshot,
            }
        )

    entries.sort(
        key=lambda entry: (
            0 if bool(entry.get("isOnline")) and not bool(entry.get("isIdle"))
            else 1 if bool(entry.get("isOnline"))
            else 2,
            str(entry.get("name") or entry.get("email") or entry.get("id") or "").lower(),
        )
    )

    sig = [
        {
            "id": entry.get("id"),
            "role": entry.get("role") or "unknown",
            "isOnline": bool(entry.get("isOnline")),
            "isIdle": bool(entry.get("isIdle")),
            "lastLoginAt": entry.get("lastLoginAt") or None,
            "isPartner": _normalize_optional_bool(entry.get("isPartner")),
            "allowedRetail": _normalize_optional_bool(entry.get("allowedRetail")),
        }
        for entry in entries
    ]
    sig.sort(key=lambda entry: str(entry.get("id") or ""))
    etag = hashlib.sha256(
        json.dumps({"users": sig}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    return {
        "etag": etag,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "users": entries,
        "total": len(entries),
    }


def _compute_live_users_cached() -> dict:
    now = time.monotonic()
    ttl_s = float(os.environ.get("LIVE_USERS_CACHE_TTL_SECONDS") or 1.0)
    ttl_s = max(0.25, min(ttl_s, 5.0))

    with _LIVE_USERS_CACHE_LOCK:
        cached = _LIVE_USERS_CACHE.get("payload")
        expires_at = float(_LIVE_USERS_CACHE.get("expiresAt") or 0.0)
        if cached and expires_at > now:
            return cached

    payload = _compute_live_users_payload()
    with _LIVE_USERS_CACHE_LOCK:
        _LIVE_USERS_CACHE["payload"] = payload
        _LIVE_USERS_CACHE["expiresAt"] = now + ttl_s
    return payload


@blueprint.get("/shop")
def get_shop():
    def action():
        settings = settings_service.get_settings()
        return {
            "shopEnabled": bool(settings.get("shopEnabled", True)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.get("/beta-services")
@require_auth
def get_beta_services():
    def action():
        settings = settings_service.get_settings()
        return {
            "betaServices": settings.get("betaServices") or [],
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.get("/forum")
def get_forum():
    def action():
        settings = settings_service.get_settings()
        return {
            "peptideForumEnabled": bool(settings.get("peptideForumEnabled", True)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.get("/research")
def get_research():
    def action():
        settings = settings_service.get_settings()
        return {
            "researchDashboardEnabled": bool(settings.get("researchDashboardEnabled", False)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.get("/physician-map")
def get_physician_map():
    def action():
        settings = settings_service.get_settings()
        return {
            "physicianMapEnabled": bool(settings.get("physicianMapEnabled", False)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.get("/network/doctors")
@require_auth
def get_network_doctors():
    def action():
        settings = settings_service.get_settings()
        current_user = getattr(g, "current_user", None) or {}
        if not bool(settings.get("physicianMapEnabled", False)) and not _is_test_doctor_user(current_user):
            raise service_error("Physician map is disabled", 403)
        doctors = _build_physician_network_entries()
        return {
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "doctors": doctors,
            "total": len(doctors),
        }

    return handle_action(action)


@blueprint.get("/network/doctors/<user_id>/profile-image")
@require_media_auth
def get_network_doctor_profile_image(user_id: str):
    def action():
        settings = settings_service.get_settings()
        current_user = getattr(g, "current_user", None) or {}
        if not bool(settings.get("physicianMapEnabled", False)) and not _is_test_doctor_user(current_user):
            raise service_error("Physician map is disabled", 403)

        target_id = str(user_id or "").strip()
        if not target_id:
            err = RuntimeError("user_id is required")
            setattr(err, "status", 400)
            raise err

        user = user_repository.find_by_id(target_id)
        if not _is_physician_network_visible_user(user):
            err = RuntimeError("User not found")
            setattr(err, "status", 404)
            raise err

        response = user_media_service.build_embedded_image_response(user.get("profileImageUrl"))
        if response is None:
            err = RuntimeError("Profile image not found")
            setattr(err, "status", 404)
            raise err
        return response

    return handle_action(action)


@blueprint.get("/patient-links")
def get_patient_links():
    def action():
        _migrate_legacy_delegate_links_to_users()
        settings = settings_service.get_settings()
        return {
            "patientLinksEnabled": bool(settings.get("patientLinksEnabled", False)),
            "patientLinksDoctorUserIds": [
                str(doctor.get("userId") or "").strip()
                for doctor in _get_delegate_links_doctors()
                if bool(doctor.get("delegateLinksEnabled"))
            ],
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.get("/patient-links/doctors")
@require_auth
def get_patient_links_doctors():
    def action():
        _require_admin()
        _migrate_legacy_delegate_links_to_users()
        return {
            "doctors": _get_delegate_links_doctors(),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.get("/crm")
def get_crm():
    def action():
        settings = settings_service.get_settings()
        return {
            "crmEnabled": bool(settings.get("crmEnabled", True)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.get("/database-visualizer")
@require_auth
def get_database_visualizer():
    def action():
        _require_admin()
        table_name = request.args.get("table")
        return _load_database_visualizer_payload(
            table_name if isinstance(table_name, str) else None,
            page=_database_visualizer_page(request.args.get("page")),
            page_size=_database_visualizer_page_size(request.args.get("pageSize")),
            sort_column=request.args.get("sortColumn"),
            sort_direction=_database_visualizer_sort_direction(request.args.get("sortDirection")),
            search_term=_database_visualizer_search_term(request.args.get("search")),
        )

    return handle_action(action)


@blueprint.put("/shop")
@require_auth
def update_shop():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"shopEnabled": enabled})
        return {
            "shopEnabled": bool(updated.get("shopEnabled", True)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.put("/beta-services")
@require_auth
def update_beta_services():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        updated = settings_service.update_settings(
            {"betaServices": payload.get("betaServices") or []}
        )
        return {
            "betaServices": updated.get("betaServices") or [],
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.put("/forum")
@require_auth
def update_forum():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"peptideForumEnabled": enabled})
        return {
            "peptideForumEnabled": bool(updated.get("peptideForumEnabled", True)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.put("/research")
@require_auth
def update_research():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"researchDashboardEnabled": enabled})
        return {
            "researchDashboardEnabled": bool(updated.get("researchDashboardEnabled", False)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.put("/physician-map")
@require_auth
def update_physician_map():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("physicianMapEnabled", payload.get("enabled", False)))
        updated = settings_service.update_settings({"physicianMapEnabled": enabled})
        return {
            "physicianMapEnabled": bool(updated.get("physicianMapEnabled", False)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.put("/patient-links")
@require_auth
def update_patient_links():
    def action():
        _require_admin()
        _migrate_legacy_delegate_links_to_users()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        raw_doctor_ids = payload.get("doctorUserIds")
        if raw_doctor_ids is None:
            legacy_single = str(payload.get("doctorUserId") or payload.get("patientLinksDoctorUserId") or "").strip()
            doctor_user_ids = [legacy_single] if legacy_single else []
        elif isinstance(raw_doctor_ids, list):
            doctor_user_ids = [str(value).strip() for value in raw_doctor_ids if str(value).strip()]
        else:
            doctor_user_ids = []
        validated_doctor_user_ids = []
        seen_doctor_ids = set()
        for doctor_user_id in doctor_user_ids:
            if doctor_user_id in seen_doctor_ids:
                continue
            seen_doctor_ids.add(doctor_user_id)
            doctor = user_repository.find_by_id(doctor_user_id)
            if not doctor:
                err = RuntimeError("Doctor not found")
                setattr(err, "status", 404)
                raise err
            if _normalize_role(doctor.get("role")) != "doctor":
                err = RuntimeError("Doctor access required")
                setattr(err, "status", 400)
                raise err
            validated_doctor_user_ids.append(doctor_user_id)
        selected_ids = set(validated_doctor_user_ids)
        for doctor in user_repository.get_all() or []:
            if not isinstance(doctor, dict):
                continue
            if _normalize_role(doctor.get("role")) != "doctor":
                continue
            doctor_id = str(doctor.get("id") or "").strip()
            if not doctor_id:
                continue
            next_enabled = doctor_id in selected_ids
            if bool(doctor.get("delegateLinksEnabled")) == next_enabled:
                continue
            user_repository.update({**doctor, "delegateLinksEnabled": next_enabled})
        updated = settings_service.update_settings(
            {
                "patientLinksEnabled": enabled,
                "patientLinksDoctorUserIds": [],
            }
        )
        return {
            "patientLinksEnabled": bool(updated.get("patientLinksEnabled", False)),
            "patientLinksDoctorUserIds": [
                str(doctor.get("userId") or "").strip()
                for doctor in _get_delegate_links_doctors()
                if bool(doctor.get("delegateLinksEnabled"))
            ],
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.put("/crm")
@require_auth
def update_crm():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"crmEnabled": enabled})
        return {
            "crmEnabled": bool(updated.get("crmEnabled", True)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)

@blueprint.get("/test-payments-override")
@require_auth
def get_test_payments_override():
    def action():
        _require_admin()
        settings = settings_service.get_settings()
        return {
            "testPaymentsOverrideEnabled": bool(settings.get("testPaymentsOverrideEnabled", False)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.put("/test-payments-override")
@require_auth
def update_test_payments_override():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"testPaymentsOverrideEnabled": enabled})
        return {
            "testPaymentsOverrideEnabled": bool(updated.get("testPaymentsOverrideEnabled", False)),
            "mysqlEnabled": _mysql_enabled(),
        }

    return handle_action(action)


@blueprint.post("/presence")
@require_auth
def record_presence():
    def action():
        current_user = getattr(g, "current_user", None) or {}
        if current_user.get("shadow") is True or getattr(g, "shadow_context", None):
            # Maintenance/shadow sessions must never mutate the target user's real live presence.
            return {"ok": True, "skipped": True, "reason": "shadow_session"}
        user_id = current_user.get("id")
        if not user_id:
            err = RuntimeError("Authenticated user required")
            setattr(err, "status", 401)
            raise err
        payload = request.get_json(silent=True) or {}
        kind = str(payload.get("kind") or "heartbeat").strip().lower()
        is_idle_raw = payload.get("isIdle")
        is_idle = is_idle_raw if isinstance(is_idle_raw, bool) else None
        presence_service.record_ping(str(user_id), kind=kind, is_idle=is_idle)
        # Persist the heartbeat into MySQL so "online" isn't a sticky flag.
        # This also enables server-side idle/session enforcement in `require_auth`.
        try:
            existing = user_repository.find_by_id(str(user_id)) or {}
            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            should_bump_interaction = kind == "interaction" or (kind == "heartbeat" and is_idle is False)
            next_user = {
                **existing,
                "id": str(user_id),
                "isOnline": True,
                "lastSeenAt": now_iso,
                "lastInteractionAt": now_iso if should_bump_interaction else (existing.get("lastInteractionAt") or None),
            }
            if existing:
                user_repository.update(next_user)
        except Exception:
            pass
        return {"ok": True}

    return handle_action(action)

@blueprint.get("/live-clients")
@require_auth
def get_live_clients():
    def action():
        current_user = getattr(g, "current_user", None) or {}
        role = _normalize_role(current_user.get("role"))
        if not (_is_admin_role(role) or _is_sales_rep_role(role)):
            err = RuntimeError("Sales rep access required")
            setattr(err, "status", 403)
            raise err

        requested_sales_rep_id = request.args.get("salesRepId") if _is_admin_role(role) else None
        target_sales_rep_id = str(requested_sales_rep_id or current_user.get("id") or "").strip()
        if not target_sales_rep_id:
            err = RuntimeError("salesRepId is required")
            setattr(err, "status", 400)
            raise err

        strict_assignment = _is_sales_rep_role(role) and not _is_sales_lead_role(role)
        return _compute_live_clients_payload(
            target_sales_rep_id=target_sales_rep_id,
            strict_assignment=strict_assignment,
        )

    return handle_action(action)

@blueprint.get("/live-clients/longpoll")
@require_auth
def longpoll_live_clients():
    def action():
        current_user = getattr(g, "current_user", None) or {}
        role = _normalize_role(current_user.get("role"))
        if not (_is_admin_role(role) or _is_sales_rep_role(role)):
            err = RuntimeError("Sales rep access required")
            setattr(err, "status", 403)
            raise err

        requested_sales_rep_id = request.args.get("salesRepId") if _is_admin_role(role) else None
        target_sales_rep_id = str(requested_sales_rep_id or current_user.get("id") or "").strip()
        if not target_sales_rep_id:
            err = RuntimeError("salesRepId is required")
            setattr(err, "status", 400)
            raise err

        client_etag = str(request.args.get("etag") or "").strip() or None
        strict_assignment = _is_sales_rep_role(role) and not _is_sales_lead_role(role)
        try:
            timeout_ms = int(request.args.get("timeoutMs") or 25000)
        except Exception:
            timeout_ms = 25000
        timeout_ms = max(1000, min(timeout_ms, 30000))

        acquired = _LIVE_CLIENTS_LONGPOLL_SEMAPHORE.acquire(blocking=False)
        if not acquired:
            if strict_assignment:
                return _compute_live_clients_payload(
                    target_sales_rep_id=target_sales_rep_id,
                    strict_assignment=True,
                )
            return _compute_live_clients_cached(target_sales_rep_id=target_sales_rep_id)

        try:
            deadline = time.monotonic() + (timeout_ms / 1000.0)
            payload = (
                _compute_live_clients_payload(
                    target_sales_rep_id=target_sales_rep_id,
                    strict_assignment=True,
                )
                if strict_assignment
                else _compute_live_clients_cached(target_sales_rep_id=target_sales_rep_id)
            )
            etag = str(payload.get("etag") or "").strip() or None
            if not etag or etag != client_etag:
                return payload

            revision = presence_service.current_revision()
            while time.monotonic() < deadline:
                revision = _wait_for_presence_change(revision, deadline=deadline)
                payload = (
                    _compute_live_clients_payload(
                        target_sales_rep_id=target_sales_rep_id,
                        strict_assignment=True,
                    )
                    if strict_assignment
                    else _compute_live_clients_cached(target_sales_rep_id=target_sales_rep_id)
                )
                etag = str(payload.get("etag") or "").strip() or None
                if not etag or etag != client_etag:
                    return payload

            return Response(status=204)
        finally:
            try:
                _LIVE_CLIENTS_LONGPOLL_SEMAPHORE.release()
            except ValueError:
                pass

    return handle_action(action)


@blueprint.get("/live-users")
@require_auth
def get_live_users():
    def action():
        _require_admin_or_sales_lead()
        return _compute_live_users_cached()

    return handle_action(action)


@blueprint.get("/live-users/longpoll")
@require_auth
def longpoll_live_users():
    def action():
        _require_admin_or_sales_lead()

        client_etag = str(request.args.get("etag") or "").strip() or None
        try:
            timeout_ms = int(request.args.get("timeoutMs") or 25000)
        except Exception:
            timeout_ms = 25000
        timeout_ms = max(1000, min(timeout_ms, 30000))

        acquired = _LIVE_USERS_LONGPOLL_SEMAPHORE.acquire(blocking=False)
        if not acquired:
            return _compute_live_users_cached()

        try:
            deadline = time.monotonic() + (timeout_ms / 1000.0)
            payload = _compute_live_users_cached()
            etag = str(payload.get("etag") or "").strip() or None
            if not etag or etag != client_etag:
                return payload

            revision = presence_service.current_revision()
            while time.monotonic() < deadline:
                revision = _wait_for_presence_change(revision, deadline=deadline)
                payload = _compute_live_users_cached()
                etag = str(payload.get("etag") or "").strip() or None
                if not etag or etag != client_etag:
                    return payload

            return Response(status=204)
        finally:
            try:
                _LIVE_USERS_LONGPOLL_SEMAPHORE.release()
            except ValueError:
                pass

    return handle_action(action)


@blueprint.get("/users/<user_id>")
@require_auth
def get_user_profile(user_id: str):
    def action():
        _require_admin_or_sales_lead()
        target_id = (user_id or "").strip()
        if not target_id:
            err = RuntimeError("user_id is required")
            setattr(err, "status", 400)
            raise err
        user = user_repository.find_by_id(target_id)
        if not user:
            err = RuntimeError("User not found")
            setattr(err, "status", 404)
            raise err
        reps = sales_rep_repository.get_all() or []
        by_id, by_legacy_user_id, by_email = _build_sales_rep_indexes(reps)
        profile = _public_user_profile(
            user,
            by_id=by_id,
            by_legacy_user_id=by_legacy_user_id,
            by_email=by_email,
        )
        try:
            now_epoch = time.time()
            online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
            online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
            idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
            idle_threshold_s = max(60.0, min(idle_threshold_s, 6 * 60 * 60))
            presence = presence_service.snapshot()
            snapshot = _compute_presence_snapshot(
                user,
                now_epoch=now_epoch,
                online_threshold_s=online_threshold_s,
                idle_threshold_s=idle_threshold_s,
                presence=presence,
            )
            profile["isOnline"] = bool(snapshot.get("isOnline"))
        except Exception:
            pass
        return {"user": profile}

    return handle_action(action)


@blueprint.get("/users/<user_id>/profile-image")
@require_media_auth
def get_user_profile_image(user_id: str):
    def action():
        current_user = getattr(g, "current_user", None) or {}
        current_role = _normalize_role(current_user.get("role"))
        _require_sales_rep_or_admin()

        target_id = str(user_id or "").strip()
        if not target_id:
            err = RuntimeError("user_id is required")
            setattr(err, "status", 400)
            raise err

        visible_user_ids = _resolve_visible_user_ids_for_current_actor(current_user, current_role)
        if visible_user_ids is not None and target_id not in visible_user_ids:
            err = RuntimeError("User not found")
            setattr(err, "status", 404)
            raise err

        user = user_repository.find_by_id(target_id)
        if not user:
            err = RuntimeError("User not found")
            setattr(err, "status", 404)
            raise err

        response = user_media_service.build_embedded_image_response(user.get("profileImageUrl"))
        if response is None:
            err = RuntimeError("Profile image not found")
            setattr(err, "status", 404)
            raise err
        return response

    return handle_action(action)


@blueprint.get("/users")
@require_auth
def get_user_profiles():
    def action():
        current_user = getattr(g, "current_user", None) or {}
        current_role = _normalize_role(current_user.get("role"))
        _require_sales_rep_or_admin()
        raw_ids = str(request.args.get("ids") or "").strip()
        if not raw_ids:
            err = RuntimeError("ids is required")
            setattr(err, "status", 400)
            raise err

        requested_ids: list[str] = []
        seen_ids: set[str] = set()
        for raw_id in raw_ids.split(","):
            target_id = str(raw_id or "").strip()
            if not target_id or target_id in seen_ids:
                continue
            seen_ids.add(target_id)
            requested_ids.append(target_id)
            if len(requested_ids) >= 100:
                break

        visible_user_ids = _resolve_visible_user_ids_for_current_actor(current_user, current_role)

        reps = sales_rep_repository.get_all() or []
        by_id, by_legacy_user_id, by_email = _build_sales_rep_indexes(reps)
        users: list[dict] = []
        for target_id in requested_ids:
            if visible_user_ids is not None and target_id not in visible_user_ids:
                continue
            user = user_repository.find_by_id(target_id)
            if not user:
                continue
            profile = _public_user_profile(
                user,
                by_id=by_id,
                by_legacy_user_id=by_legacy_user_id,
                by_email=by_email,
            )
            users.append(
                {
                    "id": profile.get("id"),
                    "name": profile.get("name"),
                    "email": profile.get("email"),
                    "phone": profile.get("phone"),
                    "role": profile.get("role"),
                    "status": profile.get("status"),
                    "profileImageUrl": profile.get("profileImageUrl"),
                    "greaterArea": profile.get("greaterArea"),
                    "studyFocus": profile.get("studyFocus"),
                    "bio": profile.get("bio"),
                    "salesRepId": profile.get("salesRepId"),
                    "isPartner": profile.get("isPartner"),
                    "allowedRetail": profile.get("allowedRetail"),
                    "jurisdiction": profile.get("jurisdiction"),
                    "officeAddressLine1": profile.get("officeAddressLine1"),
                    "officeAddressLine2": profile.get("officeAddressLine2"),
                    "officeCity": profile.get("officeCity"),
                    "officeState": profile.get("officeState"),
                    "officePostalCode": profile.get("officePostalCode"),
                    "officeCountry": profile.get("officeCountry"),
                    "resellerPermitFilePath": profile.get("resellerPermitFilePath"),
                    "resellerPermitFileName": profile.get("resellerPermitFileName"),
                    "resellerPermitUploadedAt": profile.get("resellerPermitUploadedAt"),
                    "supplementalProfileLoaded": profile.get("supplementalProfileLoaded"),
                }
            )

        return {"users": users}

    return handle_action(action)


@blueprint.get("/sales-reps/<sales_rep_id>")
@require_auth
def get_sales_rep_profile(sales_rep_id: str):
    def action():
        _require_admin_or_sales_lead()
        rep_id = str(sales_rep_id or "").strip()
        if not rep_id:
            err = RuntimeError("Sales rep id is required")
            setattr(err, "status", 400)
            raise err

        # IMPORTANT: `sales_rep_id` can refer to multiple identifier namespaces depending on the deployment:
        # - `sales_reps.id` (canonical rep record id)
        # - `sales_reps.legacy_user_id` (linked app user id)
        # - `users.sales_rep_id` (external rep key used by some integrations and stored on doctors)
        #
        # The admin UI may pass any of these values, so we attempt to resolve the best matching
        # `sales_reps` record without mutating any ids.
        rep = sales_rep_repository.find_by_id(rep_id)
        resolved_user_id = None
        if not rep:
            try:
                reps = sales_rep_repository.get_all() or []
            except Exception:
                reps = []
            # Try legacy user id match first.
            rep = next(
                (
                    entry
                    for entry in reps
                    if entry
                    and str(entry.get("legacyUserId") or entry.get("legacy_user_id") or "").strip() == rep_id
                ),
                None,
            )

        # If the input looks like a user id (or external rep key), try resolving via users table.
        if not rep:
            user = None
            try:
                user = user_repository.find_by_id(rep_id)
            except Exception:
                user = None
            if user and user.get("email"):
                resolved_user_id = str(user.get("id") or "").strip() or None
                try:
                    rep = sales_rep_repository.find_by_email(str(user.get("email")))
                except Exception:
                    rep = None

        if not rep:
            # Final fallback: `rep_id` might be `users.sales_rep_id` (external key). Query for a rep-like user
            # whose `sales_rep_id` matches, then resolve to the `sales_reps` record by email.
            try:
                from ..services import get_config
                from ..database import mysql_client

                if bool(get_config().mysql.get("enabled")):
                    row = mysql_client.fetch_one(
                        """
                        SELECT id, email, role
                        FROM users
                        WHERE sales_rep_id = %(sales_rep_id)s
                        LIMIT 1
                        """,
                        {"sales_rep_id": rep_id},
                    )
                    email = (row.get("email") or "").strip() if isinstance(row, dict) else ""
                    if email:
                        resolved_user_id = str(row.get("id") or "").strip() or None
                        rep = sales_rep_repository.find_by_email(email)
            except Exception:
                rep = None

        if not rep:
            err = RuntimeError("Sales rep not found")
            setattr(err, "status", 404)
            raise err

        # Resolve linked user id when possible (used by admin UI deep-links).
        legacy_user_id = rep.get("legacyUserId") or rep.get("legacy_user_id")
        if legacy_user_id:
            resolved_user_id = str(legacy_user_id).strip() or resolved_user_id
        if not resolved_user_id and rep.get("email"):
            try:
                linked = user_repository.find_by_email(str(rep.get("email")))
                if linked and linked.get("id"):
                    resolved_user_id = str(linked.get("id")).strip() or resolved_user_id
            except Exception:
                pass
        return {
            "salesRep": {
                "id": rep.get("id"),
                "name": rep.get("name"),
                "email": rep.get("email"),
                "phone": rep.get("phone"),
                "initials": rep.get("initials"),
                "salesCode": rep.get("salesCode"),
                "status": rep.get("status"),
                "role": _normalize_role(
                    (user_repository.find_by_email(str(rep.get("email"))) or {}).get("role")
                    or rep.get("role")
                    or "sales_rep"
                ),
                "isPartner": _normalize_bool(rep.get("isPartner")),
                "allowedRetail": _normalize_bool(rep.get("allowedRetail")),
                "jurisdiction": rep.get("jurisdiction"),
                "userId": resolved_user_id,
            }
        }

    return handle_action(action)


@blueprint.get("/structure/hand-delivery")
@require_auth
def get_hand_delivery_structure():
    def action():
        _require_admin()
        users = user_repository.get_all() or []
        reps = sales_rep_repository.get_all() or []
        by_id, by_legacy_user_id, by_email = _build_sales_rep_indexes(reps)

        entries: list[dict] = []
        for user in users:
            if not isinstance(user, dict):
                continue
            role = _normalize_hand_delivery_role(user.get("role"))
            if not _is_hand_delivery_role(role):
                continue
            rep = _resolve_sales_rep_for_user(
                user,
                by_id=by_id,
                by_legacy_user_id=by_legacy_user_id,
                by_email=by_email,
            )
            entries.append(_serialize_hand_delivery_entry(user, rep))

        entries.sort(
            key=lambda entry: (
                str(entry.get("name") or "").lower(),
                str(entry.get("role") or ""),
                str(entry.get("userId") or ""),
            )
        )
        return {
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "users": entries,
            "total": len(entries),
        }

    return handle_action(action)


@blueprint.patch("/structure/hand-delivery/<user_id>")
@require_auth
def update_hand_delivery_jurisdiction(user_id: str):
    def action():
        _require_admin()
        target_id = str(user_id or "").strip()
        if not target_id:
            err = RuntimeError("user_id is required")
            setattr(err, "status", 400)
            raise err

        user = user_repository.find_by_id(target_id)
        if not user:
            err = RuntimeError("User not found")
            setattr(err, "status", 404)
            raise err

        role = _normalize_hand_delivery_role(user.get("role"))
        if not _is_hand_delivery_role(role):
            err = RuntimeError("Only sales reps, sales leads, and admins are supported")
            setattr(err, "status", 400)
            raise err

        payload = request.get_json(silent=True) or {}
        raw_jurisdiction = payload.get("jurisdiction")
        jurisdiction = None if raw_jurisdiction is None else str(raw_jurisdiction).strip().lower()
        if jurisdiction in ("", "null", "none"):
            jurisdiction = None
        if jurisdiction not in (None, "local"):
            err = RuntimeError("jurisdiction must be 'local' or null")
            setattr(err, "status", 400)
            raise err

        reps = sales_rep_repository.get_all() or []
        by_id, by_legacy_user_id, by_email = _build_sales_rep_indexes(reps)
        rep = _resolve_sales_rep_for_user(
            user,
            by_id=by_id,
            by_legacy_user_id=by_legacy_user_id,
            by_email=by_email,
        )

        if rep is None and jurisdiction == "local":
            user_id_value = str(user.get("id") or "").strip()
            rep_id = str(user.get("salesRepId") or user.get("sales_rep_id") or user_id_value).strip()
            if not rep_id:
                err = RuntimeError("Unable to resolve sales rep id")
                setattr(err, "status", 400)
                raise err
            insert_payload = {
                "id": rep_id,
                "legacyUserId": user_id_value if user_id_value and user_id_value != rep_id else None,
                "name": str(user.get("name") or "").strip() or str(user.get("email") or "").strip() or rep_id,
                "email": str(user.get("email") or "").strip() or None,
                "phone": str(user.get("phone") or "").strip() or None,
                "role": role,
                "status": "active",
                "jurisdiction": jurisdiction,
            }
            rep = sales_rep_repository.insert(insert_payload)

        updated_rep = rep
        if isinstance(rep, dict):
            updated_rep = sales_rep_repository.update(
                {
                    "id": rep.get("id"),
                    "jurisdiction": jurisdiction,
                }
            ) or {
                **rep,
                "jurisdiction": jurisdiction,
            }

        return {
            "entry": _serialize_hand_delivery_entry(user, updated_rep),
        }

    return handle_action(action)


@blueprint.get("/structure/hand-delivery/doctors")
@require_auth
def get_hand_delivery_doctors():
    def action():
        _require_sales_rep_or_admin()
        current_user = getattr(g, "current_user", None) or {}
        _require_local_jurisdiction_for_sales_rep(current_user)
        base_owner_id = str(current_user.get("salesRepId") or current_user.get("sales_rep_id") or current_user.get("id") or "").strip()
        owner_ids = _compute_allowed_sales_rep_ids(base_owner_id) if base_owner_id else set()
        if current_user.get("id"):
            owner_ids.add(str(current_user.get("id")))
        entries = _build_hand_delivery_doctor_entries(owner_ids)
        return {
            "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "doctors": entries,
            "total": len(entries),
        }

    return handle_action(action)


@blueprint.patch("/structure/hand-delivery/doctors/<doctor_user_id>")
@require_auth
def update_hand_delivery_doctor(doctor_user_id: str):
    def action():
        _require_sales_rep_or_admin()
        current_user = getattr(g, "current_user", None) or {}
        role = _normalize_role(current_user.get("role"))
        _require_local_jurisdiction_for_sales_rep(current_user)

        target_id = str(doctor_user_id or "").strip()
        if not target_id:
            err = RuntimeError("doctor_user_id is required")
            setattr(err, "status", 400)
            raise err

        payload = request.get_json(silent=True) or {}
        requested = payload.get("handDelivered")
        if type(requested) is not bool:
            err = RuntimeError("handDelivered boolean is required")
            setattr(err, "status", 400)
            raise err

        doctor = user_repository.find_by_id(target_id)
        if not doctor:
            err = RuntimeError("User not found")
            setattr(err, "status", 404)
            raise err
        if not _is_doctor_role(doctor.get("role")):
            err = RuntimeError("Doctor access required")
            setattr(err, "status", 403)
            raise err

        if not _is_admin_role(role):
            base_owner_id = str(current_user.get("salesRepId") or current_user.get("sales_rep_id") or current_user.get("id") or "").strip()
            owner_ids = _compute_allowed_sales_rep_ids(base_owner_id) if base_owner_id else set()
            if current_user.get("id"):
                owner_ids.add(str(current_user.get("id")))
            allowed_doctors = _build_hand_delivery_doctor_entries(owner_ids)
            if not any(str(entry.get("userId") or "") == target_id for entry in allowed_doctors):
                err = RuntimeError("Not authorized to edit this user")
                setattr(err, "status", 403)
                raise err

        updated = user_repository.update(
            {
                **doctor,
                "handDelivered": requested,
                "hand_delivered": 1 if requested else 0,
            }
        )
        if not updated:
            err = RuntimeError("Unable to update doctor hand delivery")
            setattr(err, "status", 500)
            raise err

        entry = {
            "userId": str(updated.get("id") or "").strip(),
            "salesRepId": str(updated.get("salesRepId") or updated.get("sales_rep_id") or "").strip() or None,
            "name": str(updated.get("name") or "").strip()
            or str(updated.get("email") or "").strip()
            or f"Doctor {str(updated.get('id') or '')}",
            "email": str(updated.get("email") or "").strip().lower() or None,
            "role": _normalize_role(updated.get("role") or ""),
            "handDelivered": _normalize_bool(
                updated.get("handDelivered")
                if "handDelivered" in updated
                else updated.get("hand_delivered")
            ),
        }
        return {"entry": entry}

    return handle_action(action)

@blueprint.patch("/users/<user_id>")
@require_auth
def patch_user_profile(user_id: str):
    def action():
        current_user = getattr(g, "current_user", None) or {}
        role = _normalize_role(current_user.get("role"))
        target_id = (user_id or "").strip()
        if not target_id:
            err = RuntimeError("user_id is required")
            setattr(err, "status", 400)
            raise err

        payload = request.get_json(silent=True) or {}
        if _is_admin_role(role):
            return {"user": auth_service.update_profile(target_id, payload)}

        if _is_sales_rep_role(role):
            # Sales reps may edit limited profile fields (phone + office address) for their assigned doctors.
            target = user_repository.find_by_id(target_id) or {}
            target_role = _normalize_role((target or {}).get("role"))
            if target_role not in ("doctor", "test_doctor"):
                err = RuntimeError("Doctor access required")
                setattr(err, "status", 403)
                raise err
            allowed = _compute_allowed_sales_rep_ids(str(current_user.get("id") or ""))
            doctor_rep_id = str((target or {}).get("salesRepId") or (target or {}).get("sales_rep_id") or "").strip()
            if not doctor_rep_id or doctor_rep_id not in allowed:
                err = RuntimeError("Not authorized to edit this user")
                setattr(err, "status", 403)
                raise err
            allowed_keys = (
                "phone",
                "officeAddressLine1",
                "officeAddressLine2",
                "officeCity",
                "officeState",
                "officePostalCode",
                "officeCountry",
            )
            patch = {key: payload.get(key) for key in allowed_keys if key in payload}
            return {"user": auth_service.update_profile(target_id, patch)}

        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err

    return handle_action(action)


@blueprint.get("/stripe")
def get_stripe():
    def action():
        mode = settings_service.get_effective_stripe_mode()
        config = get_config()
        mysql_enabled = bool(config.mysql.get("enabled"))
        settings_logger = __import__("logging").getLogger("peppro.settings")
        settings_logger.debug("Stripe settings requested", extra={"mode": mode, "mysqlEnabled": mysql_enabled})
        try:
            resolved = settings_service.resolve_stripe_publishable_key(mode)
            live_key = str(config.stripe.get("publishable_key_live") or "").strip()
            test_key = str(config.stripe.get("publishable_key_test") or "").strip()
            print(
                f"[payments] settings publishable: mode={mode} resolved_prefix={(resolved or '')[:8]} live_present={bool(live_key)} test_present={bool(test_key)}",
                flush=True,
            )
        except Exception:
            pass
        return {
            "stripeMode": mode,
            "stripeTestMode": mode == "test",
            "onsiteEnabled": bool(config.stripe.get("onsite_enabled")),
            "publishableKey": settings_service.resolve_stripe_publishable_key(mode),
            "publishableKeyLive": str(config.stripe.get("publishable_key_live") or "").strip(),
            "publishableKeyTest": str(config.stripe.get("publishable_key_test") or "").strip(),
            "mysqlEnabled": mysql_enabled,
        }

    return handle_action(action)


@blueprint.put("/stripe")
@require_auth
def update_stripe():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        raw_mode = payload.get("mode")
        raw_test_mode = payload.get("testMode")
        if isinstance(raw_mode, str):
            mode = raw_mode.strip().lower()
        else:
            mode = "test" if bool(raw_test_mode) else "live"
        if mode not in ("test", "live"):
            mode = "test"
        config = get_config()
        mysql_enabled = bool(config.mysql.get("enabled"))
        settings_logger = __import__("logging").getLogger("peppro.settings")
        settings_logger.info("Stripe mode update requested", extra={"requestedMode": mode, "mysqlEnabled": mysql_enabled, "userId": (getattr(g, "current_user", None) or {}).get("id")})
        settings_service.update_settings({"stripeMode": mode})
        resolved_mode = settings_service.get_effective_stripe_mode()
        return {
            "stripeMode": resolved_mode,
            "stripeTestMode": resolved_mode == "test",
            "onsiteEnabled": bool(config.stripe.get("onsite_enabled")),
            "publishableKey": settings_service.resolve_stripe_publishable_key(resolved_mode),
            "publishableKeyLive": str(config.stripe.get("publishable_key_live") or "").strip(),
            "publishableKeyTest": str(config.stripe.get("publishable_key_test") or "").strip(),
            "mysqlEnabled": mysql_enabled,
        }

    return handle_action(action)


@blueprint.get("/reports")
@require_auth
def get_reports():
    def action():
        _require_admin_or_sales_lead()
        settings = settings_service.get_settings()
        role = str((g.current_user or {}).get("role") or "").strip().lower()
        is_sales_lead = _is_sales_lead_role(role)
        is_admin = _is_admin()
        if is_sales_lead and not is_admin:
            downloaded_at = settings.get("salesLeadSalesBySalesRepCsvDownloadedAt")
            return {
                "salesLeadSalesBySalesRepCsvDownloadedAt": downloaded_at if isinstance(downloaded_at, str) else None,
            }
        downloaded_at = settings.get("salesBySalesRepCsvDownloadedAt")
        sales_lead_downloaded_at = settings.get("salesLeadSalesBySalesRepCsvDownloadedAt")
        taxes_downloaded_at = settings.get("taxesByStateCsvDownloadedAt")
        products_downloaded_at = settings.get("productsCommissionCsvDownloadedAt")
        return {
            "salesBySalesRepCsvDownloadedAt": downloaded_at if isinstance(downloaded_at, str) else None,
            "salesLeadSalesBySalesRepCsvDownloadedAt": sales_lead_downloaded_at if isinstance(sales_lead_downloaded_at, str) else None,
            "taxesByStateCsvDownloadedAt": taxes_downloaded_at if isinstance(taxes_downloaded_at, str) else None,
            "productsCommissionCsvDownloadedAt": products_downloaded_at if isinstance(products_downloaded_at, str) else None,
        }

    return handle_action(action)


@blueprint.put("/reports")
@require_auth
def update_reports():
    def action():
        _require_admin_or_sales_lead()
        payload = request.get_json(silent=True) or {}
        role = str((g.current_user or {}).get("role") or "").strip().lower()
        is_sales_lead = _is_sales_lead_role(role)
        is_admin = _is_admin()
        patch = {}
        if is_sales_lead and not is_admin:
            if "salesLeadSalesBySalesRepCsvDownloadedAt" in payload or "downloadedAt" in payload:
                raw = payload.get("salesLeadSalesBySalesRepCsvDownloadedAt") or payload.get("downloadedAt")
                parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
                stamp = (
                    parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                    if parsed
                    else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                )
                patch["salesLeadSalesBySalesRepCsvDownloadedAt"] = stamp
            updated = settings_service.update_settings(patch) if patch else settings_service.get_settings()
            return {
                "salesLeadSalesBySalesRepCsvDownloadedAt": updated.get("salesLeadSalesBySalesRepCsvDownloadedAt"),
            }

        if "salesBySalesRepCsvDownloadedAt" in payload or "downloadedAt" in payload:
            raw = payload.get("salesBySalesRepCsvDownloadedAt") or payload.get("downloadedAt")
            parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
            stamp = (
                parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if parsed
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            patch["salesBySalesRepCsvDownloadedAt"] = stamp

        if "salesLeadSalesBySalesRepCsvDownloadedAt" in payload:
            raw = payload.get("salesLeadSalesBySalesRepCsvDownloadedAt")
            parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
            stamp = (
                parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if parsed
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            patch["salesLeadSalesBySalesRepCsvDownloadedAt"] = stamp

        if "taxesByStateCsvDownloadedAt" in payload:
            raw = payload.get("taxesByStateCsvDownloadedAt")
            parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
            stamp = (
                parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if parsed
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            patch["taxesByStateCsvDownloadedAt"] = stamp

        if "productsCommissionCsvDownloadedAt" in payload:
            raw = payload.get("productsCommissionCsvDownloadedAt")
            parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
            stamp = (
                parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if parsed
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            patch["productsCommissionCsvDownloadedAt"] = stamp

        if patch:
            updated = settings_service.update_settings(patch)
        else:
            updated = settings_service.get_settings()
        return {
            "salesBySalesRepCsvDownloadedAt": updated.get("salesBySalesRepCsvDownloadedAt"),
            "salesLeadSalesBySalesRepCsvDownloadedAt": updated.get("salesLeadSalesBySalesRepCsvDownloadedAt"),
            "taxesByStateCsvDownloadedAt": updated.get("taxesByStateCsvDownloadedAt"),
            "productsCommissionCsvDownloadedAt": updated.get("productsCommissionCsvDownloadedAt"),
        }

    return handle_action(action)


def _parse_activity_window(raw: str | None) -> str:
    normalized = str(raw or "").strip().lower()
    if normalized in ("hour", "1h", "last_hour"):
        return "hour"
    if normalized in ("day", "1d", "last_day"):
        return "day"
    if normalized in ("3days", "3d", "3_days"):
        return "3days"
    if normalized in ("week", "7d", "last_week"):
        return "week"
    if normalized in ("month", "30d", "last_month"):
        return "month"
    if normalized in ("6months", "6mo", "half_year"):
        return "6months"
    if normalized in ("year", "12mo", "365d", "last_year"):
        return "year"
    return "day"


def _window_delta(window_key: str) -> timedelta:
    if window_key == "hour":
        return timedelta(hours=1)
    if window_key == "day":
        return timedelta(days=1)
    if window_key == "3days":
        return timedelta(days=3)
    if window_key == "week":
        return timedelta(days=7)
    if window_key == "month":
        return timedelta(days=30)
    if window_key == "6months":
        return timedelta(days=182)
    if window_key == "year":
        return timedelta(days=365)
    return timedelta(days=1)


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


@blueprint.post("/downloads/track")
@require_auth
def track_download_event():
    def action():
        payload = request.get_json(silent=True) or {}
        user_id = str((getattr(g, "current_user", None) or {}).get("id") or "").strip()
        if not user_id:
            err = RuntimeError("Authentication required")
            setattr(err, "status", 401)
            raise err

        kind = payload.get("kind") or payload.get("type") or payload.get("event")
        kind = str(kind or "").strip().lower()
        if not kind:
            err = RuntimeError("Download kind required")
            setattr(err, "status", 400)
            raise err

        raw_at = payload.get("at") if isinstance(payload.get("at"), str) else None
        at = (
            _parse_iso_datetime(raw_at).isoformat().replace("+00:00", "Z")
            if raw_at and _parse_iso_datetime(raw_at)
            else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        )

        event = {
            "kind": kind,
            "at": at,
            "wooProductId": payload.get("wooProductId") or payload.get("woo_product_id") or payload.get("wooId"),
            "productId": payload.get("productId") or payload.get("product_id"),
            "filename": payload.get("filename"),
        }

        user = user_repository.find_by_id(user_id) or {}
        downloads = user.get("downloads")
        if not isinstance(downloads, list):
            downloads = []
        downloads.append(event)
        # Keep the list bounded so the users table doesn't grow unbounded.
        max_events = int(os.environ.get("USER_DOWNLOAD_EVENTS_MAX") or 5000)
        max_events = max(100, min(max_events, 50000))
        if len(downloads) > max_events:
            downloads = downloads[-max_events:]

        user_repository.update({**user, "id": user_id, "downloads": downloads})
        return {"ok": True}

    return handle_action(action)


@blueprint.get("/user-activity")
@require_auth
def get_user_activity():
    def action():
        _require_admin()
        raw_window = request.args.get("window")
        window_key = _parse_activity_window(raw_window)
        return _compute_user_activity(window_key, raw_window=raw_window)

    return handle_action(action)


@blueprint.get("/user-activity/longpoll")
@require_auth
def longpoll_user_activity():
    def action():
        _require_admin()

        raw_window = request.args.get("window")
        window_key = _parse_activity_window(raw_window)
        client_etag = str(request.args.get("etag") or "").strip() or None
        try:
            timeout_ms = int(request.args.get("timeoutMs") or 25000)
        except Exception:
            timeout_ms = 25000
        timeout_ms = max(1000, min(timeout_ms, 30000))

        acquired = _USER_ACTIVITY_LONGPOLL_SEMAPHORE.acquire(blocking=False)
        if not acquired:
            report = _compute_user_activity_cached(window_key, raw_window=raw_window, include_logs=False)
            report["longpollSkipped"] = True
            return report

        try:
            deadline = time.monotonic() + (timeout_ms / 1000.0)
            report = _compute_user_activity_cached(window_key, raw_window=raw_window, include_logs=False)
            etag = str(report.get("etag") or "").strip() or None
            if not etag or etag != client_etag:
                return report

            revision = presence_service.current_revision()
            while time.monotonic() < deadline:
                revision = _wait_for_presence_change(revision, deadline=deadline)
                report = _compute_user_activity_cached(window_key, raw_window=raw_window, include_logs=False)
                etag = str(report.get("etag") or "").strip() or None
                if not etag or etag != client_etag:
                    return report

            return report
        finally:
            try:
                _USER_ACTIVITY_LONGPOLL_SEMAPHORE.release()
            except ValueError:
                pass

    return handle_action(action)

def _compute_user_activity_cached(
    window_key: str,
    *,
    raw_window: str | None = None,
    include_logs: bool = True,
) -> dict:
    """
    User activity reports are polled frequently. Recomputing the report every ~150ms
    per request can overload small VPS instances and lead to upstream 502/504s.
    Cache for a short TTL so concurrent longpolls share work.
    """
    now = time.monotonic()
    ttl_s = float(os.environ.get("USER_ACTIVITY_CACHE_TTL_SECONDS") or 1.0)
    ttl_s = max(0.25, min(ttl_s, 5.0))

    cache_key = window_key
    with _USER_ACTIVITY_CACHE_LOCK:
        cached = _USER_ACTIVITY_CACHE.get(cache_key) or {}
        cached_at = float(cached.get("at") or 0.0)
        if cached and cached_at > 0 and (now - cached_at) < ttl_s:
            payload = cached.get("payload")
            if isinstance(payload, dict):
                return payload

    payload = _compute_user_activity(window_key, raw_window=raw_window, include_logs=include_logs)
    with _USER_ACTIVITY_CACHE_LOCK:
        _USER_ACTIVITY_CACHE[cache_key] = {"at": now, "payload": payload}
    return payload


def _compute_user_activity(window_key: str, *, raw_window: str | None = None, include_logs: bool = True) -> dict:
    logger = logging.getLogger("peppro.user_activity")
    cutoff = datetime.now(timezone.utc) - _window_delta(window_key)
    presence = presence_service.snapshot()
    # "Online right now" should reflect recent heartbeats (not a 45-minute window).
    online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
    online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
    # Match the frontend's default idle threshold (10 minutes), but keep it configurable.
    idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
    idle_threshold_s = max(60.0, min(idle_threshold_s, 6 * 60 * 60))
    now_epoch = time.time()

    if include_logs:
        print(
            f"[user-activity] window_raw={raw_window!r} window={window_key} cutoff={cutoff.isoformat()}",
            flush=True,
        )
        logger.info(
            "User activity requested",
            extra={
                "windowRaw": raw_window,
                "window": window_key,
                "cutoff": cutoff.isoformat(),
                "userId": (getattr(g, "current_user", None) or {}).get("id"),
            },
        )

    users = user_repository.list_recent_users_since(cutoff)
    recent: list[dict] = []
    live_users: list[dict] = []
    for user in users:
        user_id = str(user.get("id") or "").strip()
        if not user_id:
            continue
        presence_entry = presence.get(user_id)
        presence_public = presence_service.to_public_fields(presence_entry)
        persisted_seen_dt = _parse_iso_datetime(user.get("lastSeenAt") or None)
        persisted_interaction_dt = _parse_iso_datetime(user.get("lastInteractionAt") or None)
        persisted_login_dt = _parse_iso_datetime(user.get("lastLoginAt") or None)

        last_seen_epoch = None
        try:
            raw_seen = presence_entry.get("lastHeartbeatAt") if isinstance(presence_entry, dict) else None
            if isinstance(raw_seen, (int, float)) and float(raw_seen) > 0:
                last_seen_epoch = float(raw_seen)
        except Exception:
            last_seen_epoch = None
        if last_seen_epoch is None and persisted_seen_dt:
            last_seen_epoch = float(persisted_seen_dt.timestamp())

        last_interaction_epoch = None
        try:
            raw_interaction = presence_entry.get("lastInteractionAt") if isinstance(presence_entry, dict) else None
            if isinstance(raw_interaction, (int, float)) and float(raw_interaction) > 0:
                last_interaction_epoch = float(raw_interaction)
        except Exception:
            last_interaction_epoch = None
        if last_interaction_epoch is None and persisted_interaction_dt:
            last_interaction_epoch = float(persisted_interaction_dt.timestamp())

        is_online_db = bool(user.get("isOnline"))
        derived_online = bool(
            is_online_db
            and presence_service.is_recent_epoch(
                last_seen_epoch,
                now_epoch=now_epoch,
                threshold_s=online_threshold_s,
            )
        )

        session_start_epoch = float(persisted_login_dt.timestamp()) if persisted_login_dt else None
        session_age_s = (now_epoch - session_start_epoch) if session_start_epoch else None
        is_idle_flag = (
            bool(presence_entry.get("isIdle"))
            if isinstance(presence_entry, dict) and isinstance(presence_entry.get("isIdle"), bool)
            else None
        )

        idle_anchor_epoch = None
        if isinstance(last_interaction_epoch, (int, float)) and float(last_interaction_epoch) > 0:
            idle_anchor_epoch = float(last_interaction_epoch)
        elif isinstance(last_seen_epoch, (int, float)) and float(last_seen_epoch) > 0:
            idle_anchor_epoch = float(last_seen_epoch)
        elif session_start_epoch:
            idle_anchor_epoch = float(session_start_epoch)

        idle_age_s = (
            (now_epoch - float(idle_anchor_epoch))
            if isinstance(idle_anchor_epoch, (int, float)) and float(idle_anchor_epoch) > 0
            else None
        )

        computed_idle = False
        if derived_online:
            computed_idle = bool(is_idle_flag) or bool(idle_age_s is not None and idle_age_s >= idle_threshold_s)

        entry = {
            "id": user.get("id"),
            "name": user.get("name") or None,
            "email": user.get("email") or None,
            "role": str(user.get("role") or "").strip().lower() or "unknown",
            "isOnline": derived_online,
            "lastLoginAt": user.get("lastLoginAt") or None,
            "profileImageUrl": user.get("profileImageUrl") or None,
            **{
                "lastSeenAt": presence_public.get("lastSeenAt") or (user.get("lastSeenAt") or None),
                "lastInteractionAt": presence_public.get("lastInteractionAt") or (user.get("lastInteractionAt") or None),
                "isIdle": computed_idle if derived_online else False,
            },
        }

        if entry["isOnline"]:
            live_users.append(entry)

        last_login = _parse_iso_datetime(entry.get("lastLoginAt"))
        if not last_login or last_login < cutoff:
            continue
        recent.append(entry)

    recent.sort(
        key=lambda entry: _parse_iso_datetime(entry.get("lastLoginAt"))
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )

    live_users.sort(
        key=lambda entry: str(entry.get("name") or entry.get("email") or entry.get("id") or "").lower()
    )

    by_role: dict[str, int] = {}
    sig_recent: list[dict] = []
    for entry in recent:
        role = entry.get("role") or "unknown"
        by_role[role] = int(by_role.get(role, 0)) + 1
        sig_recent.append(
            {
                "id": entry.get("id"),
                "role": role,
                "isOnline": bool(entry.get("isOnline")),
                "isIdle": entry.get("isIdle") if isinstance(entry.get("isIdle"), bool) else None,
                "lastLoginAt": entry.get("lastLoginAt") or None,
                "profileImageUrl": entry.get("profileImageUrl") or None,
            }
        )

    # ETag should only reflect meaningful state changes (online/offline + logins),
    # not the moving cutoff timestamp.
    sig_live = [
        {
            "id": entry.get("id"),
            "role": entry.get("role") or "unknown",
            "isOnline": bool(entry.get("isOnline")),
            "isIdle": entry.get("isIdle") if isinstance(entry.get("isIdle"), bool) else None,
            "lastLoginAt": entry.get("lastLoginAt") or None,
            "profileImageUrl": entry.get("profileImageUrl") or None,
        }
        for entry in live_users
    ]
    sig_recent.sort(key=lambda entry: str(entry.get("id") or ""))
    sig_live.sort(key=lambda entry: str(entry.get("id") or ""))
    sig_payload = {"window": window_key, "recent": sig_recent, "live": sig_live}
    etag = hashlib.sha256(
        json.dumps(sig_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    if include_logs:
        print(
            f"[user-activity] matched={len(recent)} by_role={by_role}",
            flush=True,
        )
        logger.info(
            "User activity computed",
            extra={"matched": len(recent), "byRole": by_role, "window": window_key},
        )

    return {
        "window": window_key,
        "etag": etag,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "cutoff": cutoff.isoformat(),
        "liveUsers": live_users,
        "total": len(recent),
        "byRole": by_role,
        "users": recent,
    }
