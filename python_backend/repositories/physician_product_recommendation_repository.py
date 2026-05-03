from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..services import get_config


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _format_mysql_datetime(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return normalized.astimezone(timezone.utc).replace(tzinfo=None)


def _format_response_datetime(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, datetime):
        normalized = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return normalized.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


def _parse_recommendations_json(value: Any) -> List[Dict[str, Any]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, str):
        return []
    raw = value.strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [item for item in parsed if isinstance(item, dict)]


def _row_to_snapshot(row: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "userId": row.get("user_id"),
        "modelVersion": row.get("model_version"),
        "recommendations": _parse_recommendations_json(row.get("recommendations_json")),
        "fallback": bool(row.get("fallback")),
        "fallbackReason": row.get("fallback_reason"),
        "generatedAt": _format_response_datetime(row.get("generated_at")),
        "expiresAt": _format_response_datetime(row.get("expires_at")),
        "createdAt": _format_response_datetime(row.get("created_at")),
        "updatedAt": _format_response_datetime(row.get("updated_at")),
    }


def save_snapshot(
    *,
    user_id: str,
    recommendations: List[Dict[str, Any]],
    model_version: str,
    fallback: bool = False,
    fallback_reason: Optional[str] = None,
    generated_at: Optional[datetime] = None,
    expires_at: Optional[datetime] = None,
) -> bool:
    if not _using_mysql():
        return False

    normalized_user_id = str(user_id or "").strip()
    normalized_model_version = str(model_version or "").strip()[:64]
    if not normalized_user_id or not normalized_model_version:
        return False

    safe_recommendations = [item for item in recommendations or [] if isinstance(item, dict)]
    recommendations_json = json.dumps(safe_recommendations, separators=(",", ":"))
    generated = generated_at or datetime.now(timezone.utc)

    with mysql_client.cursor() as cur:
        cur.execute(
            """
            DELETE FROM physician_product_recommendations
            WHERE user_id = %(user_id)s
              AND model_version = %(model_version)s
            """,
            {
                "user_id": normalized_user_id,
                "model_version": normalized_model_version,
            },
        )
        cur.execute(
            """
            INSERT INTO physician_product_recommendations (
                user_id,
                model_version,
                recommendations_json,
                fallback,
                fallback_reason,
                generated_at,
                expires_at,
                created_at,
                updated_at
            ) VALUES (
                %(user_id)s,
                %(model_version)s,
                %(recommendations_json)s,
                %(fallback)s,
                %(fallback_reason)s,
                %(generated_at)s,
                %(expires_at)s,
                NOW(),
                NOW()
            )
            """,
            {
                "user_id": normalized_user_id,
                "model_version": normalized_model_version,
                "recommendations_json": recommendations_json,
                "fallback": 1 if fallback else 0,
                "fallback_reason": str(fallback_reason or "").strip()[:128] or None,
                "generated_at": _format_mysql_datetime(generated),
                "expires_at": _format_mysql_datetime(expires_at),
            },
        )
    return True


def find_latest_for_user(
    user_id: str,
    *,
    model_version: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    if not _using_mysql():
        return None

    normalized_user_id = str(user_id or "").strip()
    if not normalized_user_id:
        return None

    if model_version:
        row = mysql_client.fetch_one(
            """
            SELECT *
            FROM physician_product_recommendations
            WHERE user_id = %(user_id)s
              AND model_version = %(model_version)s
            ORDER BY generated_at DESC, id DESC
            LIMIT 1
            """,
            {
                "user_id": normalized_user_id,
                "model_version": str(model_version).strip()[:64],
            },
        )
    else:
        row = mysql_client.fetch_one(
            """
            SELECT *
            FROM physician_product_recommendations
            WHERE user_id = %(user_id)s
            ORDER BY generated_at DESC, id DESC
            LIMIT 1
            """,
            {"user_id": normalized_user_id},
        )
    return _row_to_snapshot(row) if row else None
