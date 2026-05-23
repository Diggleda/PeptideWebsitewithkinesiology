from __future__ import annotations

import secrets
from typing import Any, Dict, Iterable, Optional

from ..database import mysql_client
from ..services import get_config
from ._mysql_datetime import to_mysql_datetime


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _normalize_text(value: Any, *, max_len: Optional[int] = None) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_len] if max_len is not None else text


def record_acceptances(
    *,
    user_id: str,
    documents: Iterable[Dict[str, Any]],
    accepted_at: Any,
    acceptance_context: Optional[str] = None,
    ip_hash: Optional[str] = None,
    user_agent_hash: Optional[str] = None,
) -> int:
    if not _using_mysql():
        return 0

    normalized_user_id = _normalize_text(user_id, max_len=64)
    if not normalized_user_id:
        return 0

    accepted_at_value = to_mysql_datetime(accepted_at)
    if not accepted_at_value:
        return 0

    rows = []
    for document in documents or []:
        if not isinstance(document, dict):
            continue
        document_key = _normalize_text(document.get("document_key") or document.get("key"), max_len=64)
        document_version = _normalize_text(
            document.get("document_version") or document.get("version"),
            max_len=64,
        )
        if not document_key or not document_version:
            continue
        rows.append(
            {
                "id": secrets.token_hex(16),
                "user_id": normalized_user_id,
                "document_key": document_key,
                "document_version": document_version,
                "accepted_at": accepted_at_value,
                "acceptance_context": _normalize_text(acceptance_context, max_len=64),
                "ip_hash": _normalize_text(ip_hash, max_len=64),
                "user_agent_hash": _normalize_text(user_agent_hash, max_len=64),
            }
        )

    for row in rows:
        mysql_client.execute(
            """
            INSERT INTO legal_acceptances (
                id, user_id, document_key, document_version, accepted_at,
                acceptance_context, ip_hash, user_agent_hash
            ) VALUES (
                %(id)s, %(user_id)s, %(document_key)s, %(document_version)s, %(accepted_at)s,
                %(acceptance_context)s, %(ip_hash)s, %(user_agent_hash)s
            )
            """,
            row,
        )

    return len(rows)

