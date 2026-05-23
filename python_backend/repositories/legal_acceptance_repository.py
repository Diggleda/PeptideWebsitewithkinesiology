from __future__ import annotations

import json
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


def _load_acceptance_history(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        history = value
    elif isinstance(value, str) and value.strip():
        try:
            history = json.loads(value)
        except (TypeError, ValueError):
            history = {}
    else:
        history = {}

    events = history.get("events") if isinstance(history, dict) else None
    if not isinstance(events, list):
        events = []
    return {
        "schemaVersion": 1,
        "events": events,
    }


def _latest_version_column(document_key: str) -> Optional[str]:
    normalized = str(document_key or "").strip().lower()
    if normalized == "terms":
        return "latest_terms_version"
    if normalized in {"shipping", "shipping_policy"}:
        return "latest_shipping_policy_version"
    if normalized in {"privacy", "privacy_policy"}:
        return "latest_privacy_policy_version"
    return None


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

    normalized_documents = []
    latest_versions = {
        "latest_terms_version": None,
        "latest_shipping_policy_version": None,
        "latest_privacy_policy_version": None,
    }
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
        normalized_documents.append(
            {
                "documentKey": document_key,
                "documentVersion": document_version,
            }
        )
        latest_column = _latest_version_column(document_key)
        if latest_column:
            latest_versions[latest_column] = document_version

    if not normalized_documents:
        return 0

    existing = mysql_client.fetch_one(
        """
        SELECT acceptances_json
        FROM legal_acceptances
        WHERE user_id = %(user_id)s
        LIMIT 1
        """,
        {"user_id": normalized_user_id},
    )
    history = _load_acceptance_history((existing or {}).get("acceptances_json"))
    history["events"].append(
        {
            "acceptedAt": accepted_at_value,
            "acceptanceContext": _normalize_text(acceptance_context, max_len=64),
            "ipHash": _normalize_text(ip_hash, max_len=64),
            "userAgentHash": _normalize_text(user_agent_hash, max_len=64),
            "documents": normalized_documents,
        }
    )

    mysql_client.execute(
        """
        INSERT INTO legal_acceptances (
            id, user_id, acceptances_json,
            latest_terms_version, latest_shipping_policy_version,
            latest_privacy_policy_version, latest_accepted_at
        ) VALUES (
            %(id)s, %(user_id)s, %(acceptances_json)s,
            %(latest_terms_version)s, %(latest_shipping_policy_version)s,
            %(latest_privacy_policy_version)s, %(latest_accepted_at)s
        )
        ON DUPLICATE KEY UPDATE
            acceptances_json = VALUES(acceptances_json),
            latest_terms_version = COALESCE(VALUES(latest_terms_version), latest_terms_version),
            latest_shipping_policy_version = COALESCE(VALUES(latest_shipping_policy_version), latest_shipping_policy_version),
            latest_privacy_policy_version = COALESCE(VALUES(latest_privacy_policy_version), latest_privacy_policy_version),
            latest_accepted_at = VALUES(latest_accepted_at)
        """,
        {
            "id": secrets.token_hex(16),
            "user_id": normalized_user_id,
            "acceptances_json": json.dumps(history, separators=(",", ":")),
            "latest_terms_version": latest_versions["latest_terms_version"],
            "latest_shipping_policy_version": latest_versions["latest_shipping_policy_version"],
            "latest_privacy_policy_version": latest_versions["latest_privacy_policy_version"],
            "latest_accepted_at": accepted_at_value,
        },
    )

    return len(normalized_documents)
