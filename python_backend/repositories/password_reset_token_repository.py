from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from ..database import mysql_client


DEFAULT_TTL_SECONDS = 60 * 60  # 1 hour


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _dt_to_sql(dt: datetime) -> str:
    aware = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    return aware.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def create_token(
    *,
    account_type: str,
    account_id: str,
    recipient_email: str,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> str:
    raw_token = secrets.token_hex(32)
    token_sha256 = _sha256_hex(raw_token)
    now = _now_utc()
    expires_at = now + timedelta(seconds=int(ttl_seconds))

    mysql_client.execute(
        """
        INSERT INTO password_reset_tokens (
            token_sha256,
            account_type,
            account_id,
            recipient_email,
            expires_at,
            created_at
        ) VALUES (
            %(token_sha256)s,
            %(account_type)s,
            %(account_id)s,
            %(recipient_email)s,
            %(expires_at)s,
            %(created_at)s
        )
        """,
        {
            "token_sha256": token_sha256,
            "account_type": (account_type or "").strip(),
            "account_id": str(account_id or "").strip(),
            "recipient_email": (recipient_email or "").strip().lower(),
            "expires_at": _dt_to_sql(expires_at),
            "created_at": _dt_to_sql(now),
        },
    )

    return raw_token


def get_valid_token(raw_token: str) -> Optional[Dict]:
    token_sha256 = _sha256_hex(raw_token)
    now = _now_utc()

    row = mysql_client.fetch_one(
        """
        SELECT token_sha256, account_type, account_id, recipient_email, expires_at, consumed_at, created_at
        FROM password_reset_tokens
        WHERE token_sha256 = %(token_sha256)s
          AND consumed_at IS NULL
          AND expires_at > %(now)s
        """,
        {"token_sha256": token_sha256, "now": _dt_to_sql(now)},
    )
    if not isinstance(row, dict):
        return None
    return row


def consume_token(raw_token: str) -> bool:
    token_sha256 = _sha256_hex(raw_token)
    now = _now_utc()
    mysql_client.execute(
        """
        UPDATE password_reset_tokens
        SET consumed_at = %(now)s
        WHERE token_sha256 = %(token_sha256)s
          AND consumed_at IS NULL
        """,
        {"token_sha256": token_sha256, "now": _dt_to_sql(now)},
    )
    row = mysql_client.fetch_one(
        "SELECT consumed_at FROM password_reset_tokens WHERE token_sha256 = %(token_sha256)s",
        {"token_sha256": token_sha256},
    )
    if not isinstance(row, dict):
        return False
    return bool(row.get("consumed_at"))

