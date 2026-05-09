from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from ..database import mysql_client


DEFAULT_TTL_SECONDS = 10 * 60


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _dt_to_sql(dt: datetime) -> str:
    aware = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def create_token(
    *,
    user_id: str,
    recipient_email: str,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> str:
    normalized_user_id = str(user_id or "").strip()
    normalized_email = str(recipient_email or "").strip().lower()
    if not normalized_user_id:
        raise ValueError("user_id is required")
    if not normalized_email:
        raise ValueError("recipient_email is required")

    now = _now_utc()
    raw_token = secrets.token_hex(32)
    token_sha256 = _sha256_hex(raw_token)
    expires_at = now + timedelta(seconds=int(ttl_seconds or DEFAULT_TTL_SECONDS))

    mysql_client.execute(
        """
        UPDATE email_verification_tokens
        SET consumed_at = %(now)s
        WHERE user_id = %(user_id)s
          AND consumed_at IS NULL
        """,
        {"user_id": normalized_user_id, "now": _dt_to_sql(now)},
    )
    mysql_client.execute(
        """
        INSERT INTO email_verification_tokens (
            token_sha256,
            user_id,
            recipient_email,
            expires_at,
            created_at
        ) VALUES (
            %(token_sha256)s,
            %(user_id)s,
            %(recipient_email)s,
            %(expires_at)s,
            %(created_at)s
        )
        """,
        {
            "token_sha256": token_sha256,
            "user_id": normalized_user_id,
            "recipient_email": normalized_email,
            "expires_at": _dt_to_sql(expires_at),
            "created_at": _dt_to_sql(now),
        },
    )
    return raw_token


def get_valid_token(raw_token: str) -> Optional[Dict]:
    normalized = str(raw_token or "").strip()
    if not normalized:
        return None
    token_sha256 = _sha256_hex(normalized)
    now = _now_utc()
    row = mysql_client.fetch_one(
        """
        SELECT token_sha256, user_id, recipient_email, expires_at, consumed_at, created_at
        FROM email_verification_tokens
        WHERE token_sha256 = %(token_sha256)s
          AND consumed_at IS NULL
          AND expires_at > %(now)s
        """,
        {"token_sha256": token_sha256, "now": _dt_to_sql(now)},
    )
    return row if isinstance(row, dict) else None


def consume_token(raw_token: str) -> bool:
    normalized = str(raw_token or "").strip()
    if not normalized:
        return False
    token_sha256 = _sha256_hex(normalized)
    now = _now_utc()
    mysql_client.execute(
        """
        UPDATE email_verification_tokens
        SET consumed_at = %(now)s
        WHERE token_sha256 = %(token_sha256)s
          AND consumed_at IS NULL
        """,
        {"token_sha256": token_sha256, "now": _dt_to_sql(now)},
    )
    row = mysql_client.fetch_one(
        "SELECT consumed_at FROM email_verification_tokens WHERE token_sha256 = %(token_sha256)s",
        {"token_sha256": token_sha256},
    )
    return bool(isinstance(row, dict) and row.get("consumed_at"))
