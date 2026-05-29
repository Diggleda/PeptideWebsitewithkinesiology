from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

from ..database import mysql_client
from ..services import get_config
from ._mysql_datetime import to_mysql_datetime

_JSON_LOCK = threading.Lock()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _using_mysql() -> bool:
    return mysql_client.is_enabled()


def _json_path() -> Path:
    try:
        data_dir = Path(get_config().data_dir)
    except Exception:
        data_dir = Path("server-data")
    return data_dir / "email_campaigns.json"


def _default_store() -> Dict[str, list]:
    return {
        "campaigns": [],
        "recipients": [],
        "events": [],
        "unsubscribes": [],
    }


def _load_json() -> Dict[str, list]:
    path = _json_path()
    if not path.exists():
        return _default_store()
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return _default_store()
    store = _default_store()
    if isinstance(data, dict):
        for key in store:
            value = data.get(key)
            store[key] = value if isinstance(value, list) else []
    return store


def _save_json(store: Dict[str, list]) -> None:
    path = _json_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(store, handle, indent=2, sort_keys=True)


def _json_dumps(value: Any) -> str:
    return json.dumps(value if value is not None else {}, separators=(",", ":"), sort_keys=True)


def _json_loads(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(str(value))
    except Exception:
        return fallback


def _format_datetime(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    text = str(value).strip()
    if not text:
        return None
    if " " in text and "T" not in text:
        text = text.replace(" ", "T", 1)
    if text.endswith("+00:00"):
        return text[:-6] + "Z"
    if text.endswith("Z"):
        return text
    return text


def _normalize_campaign(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    result = dict(row)
    result["variables_json"] = _json_loads(result.get("variables_json"), {})
    for key in ("created_at", "scheduled_at", "sent_at"):
        result[key] = _format_datetime(result.get(key))
    return result


def _normalize_recipient(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    result = dict(row)
    result["variables_json"] = _json_loads(result.get("variables_json"), {})
    for key in ("created_at", "sent_at"):
        result[key] = _format_datetime(result.get(key))
    return result


def _normalize_event(row: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not row:
        return None
    result = dict(row)
    result["metadata_json"] = _json_loads(result.get("metadata_json"), {})
    result["created_at"] = _format_datetime(result.get("created_at"))
    return result


def create_campaign(campaign: Dict[str, Any], recipients: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    campaign_record = dict(campaign)
    campaign_record.setdefault("created_at", _now_iso())
    campaign_record["recipient_count"] = int(campaign_record.get("recipient_count") or 0)
    recipient_records = [dict(recipient) for recipient in recipients]
    for recipient in recipient_records:
        recipient.setdefault("created_at", campaign_record["created_at"])
        recipient.setdefault("status", "pending")

    if _using_mysql():
        mysql_client.execute(
            """
            INSERT INTO email_campaigns (
                id,
                campaign_type,
                template_id,
                subject,
                created_by_admin_id,
                status,
                recipient_count,
                variables_json,
                created_at,
                scheduled_at,
                sent_at
            ) VALUES (
                %(id)s,
                %(campaign_type)s,
                %(template_id)s,
                %(subject)s,
                %(created_by_admin_id)s,
                %(status)s,
                %(recipient_count)s,
                %(variables_json)s,
                %(created_at)s,
                %(scheduled_at)s,
                %(sent_at)s
            )
            """,
            {
                **campaign_record,
                "variables_json": _json_dumps(campaign_record.get("variables_json")),
                "created_at": to_mysql_datetime(campaign_record.get("created_at")),
                "scheduled_at": to_mysql_datetime(campaign_record.get("scheduled_at")),
                "sent_at": to_mysql_datetime(campaign_record.get("sent_at")),
            },
        )
        for recipient in recipient_records:
            mysql_client.execute(
                """
                INSERT INTO email_campaign_recipients (
                    id,
                    campaign_id,
                    recipient_email,
                    recipient_name,
                    recipient_type,
                    status,
                    variables_json,
                    created_at,
                    sent_at,
                    error_message
                ) VALUES (
                    %(id)s,
                    %(campaign_id)s,
                    %(recipient_email)s,
                    %(recipient_name)s,
                    %(recipient_type)s,
                    %(status)s,
                    %(variables_json)s,
                    %(created_at)s,
                    %(sent_at)s,
                    %(error_message)s
                )
                """,
                {
                    **recipient,
                    "variables_json": _json_dumps(recipient.get("variables_json")),
                    "created_at": to_mysql_datetime(recipient.get("created_at")),
                    "sent_at": to_mysql_datetime(recipient.get("sent_at")),
                },
            )
        return get_campaign(str(campaign_record["id"])) or campaign_record

    with _JSON_LOCK:
        store = _load_json()
        store["campaigns"].append(campaign_record)
        store["recipients"].extend(recipient_records)
        _save_json(store)
    return campaign_record


def get_campaign(campaign_id: str) -> Optional[Dict[str, Any]]:
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT * FROM email_campaigns WHERE id = %(id)s",
            {"id": campaign_id},
        )
        return _normalize_campaign(row)
    with _JSON_LOCK:
        return _normalize_campaign(next((row for row in _load_json()["campaigns"] if row.get("id") == campaign_id), None))


def delete_draft_campaign(campaign_id: str) -> bool:
    if _using_mysql():
        deleted = mysql_client.execute(
            "DELETE FROM email_campaigns WHERE id = %(id)s AND status = 'draft'",
            {"id": campaign_id},
        )
        if not deleted:
            return False
        mysql_client.execute(
            "DELETE FROM email_campaign_recipients WHERE campaign_id = %(campaign_id)s",
            {"campaign_id": campaign_id},
        )
        return True

    with _JSON_LOCK:
        store = _load_json()
        campaigns = store["campaigns"]
        campaign = next((row for row in campaigns if row.get("id") == campaign_id), None)
        if not campaign or str(campaign.get("status") or "") != "draft":
            return False
        store["campaigns"] = [row for row in campaigns if row.get("id") != campaign_id]
        store["recipients"] = [
            row
            for row in store["recipients"]
            if str(row.get("campaign_id") or "") != campaign_id
        ]
        _save_json(store)
        return True


def list_campaigns(*, status: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 50), 250))
    statuses = ["sending", "sent"] if status == "sent" else ([status] if status else [])
    if _using_mysql():
        if status == "sent":
            rows = mysql_client.fetch_all(
                """
                SELECT *
                FROM email_campaigns
                WHERE status IN ('sending', 'sent')
                ORDER BY created_at DESC
                LIMIT %(limit)s
                """,
                {"limit": limit},
            )
        elif status:
            rows = mysql_client.fetch_all(
                """
                SELECT *
                FROM email_campaigns
                WHERE status = %(status)s
                ORDER BY created_at DESC
                LIMIT %(limit)s
                """,
                {"status": status, "limit": limit},
            )
        else:
            rows = mysql_client.fetch_all(
                """
                SELECT *
                FROM email_campaigns
                ORDER BY created_at DESC
                LIMIT %(limit)s
                """,
                {"limit": limit},
            )
        return [row for row in (_normalize_campaign(row) for row in rows) if row]

    with _JSON_LOCK:
        campaigns = [_normalize_campaign(row) for row in _load_json()["campaigns"]]
    filtered = [
        row
        for row in campaigns
        if row and (not statuses or row.get("status") in statuses)
    ]
    filtered.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return filtered[:limit]


def promote_due_scheduled_campaigns(*, now: Optional[str] = None) -> int:
    now_iso = now or _now_iso()
    if _using_mysql():
        return int(
            mysql_client.execute(
                """
                UPDATE email_campaigns
                SET status = 'sending'
                WHERE status = 'scheduled'
                  AND scheduled_at IS NOT NULL
                  AND scheduled_at <= %(now)s
                """,
                {"now": to_mysql_datetime(now_iso)},
            )
            or 0
        )

    promoted = 0
    with _JSON_LOCK:
        store = _load_json()
        for campaign in store["campaigns"]:
            if str(campaign.get("status") or "") != "scheduled":
                continue
            scheduled_at = str(campaign.get("scheduled_at") or "")
            if scheduled_at and scheduled_at <= now_iso:
                campaign["status"] = "sending"
                promoted += 1
        if promoted:
            _save_json(store)
    return promoted


def list_campaign_recipients(campaign_id: str, *, limit: int = 500) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 500), 1000))
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT *
            FROM email_campaign_recipients
            WHERE campaign_id = %(campaign_id)s
            ORDER BY created_at ASC, id ASC
            LIMIT %(limit)s
            """,
            {"campaign_id": campaign_id, "limit": limit},
        )
        return [row for row in (_normalize_recipient(row) for row in rows) if row]

    with _JSON_LOCK:
        rows = [
            row
            for row in _load_json()["recipients"]
            if str(row.get("campaign_id") or "") == campaign_id
        ]
    rows.sort(key=lambda row: str(row.get("created_at") or ""))
    return [row for row in (_normalize_recipient(row) for row in rows[:limit]) if row]


def list_campaign_events(campaign_id: str, *, limit: int = 500) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 500), 1000))
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT *
            FROM email_events
            WHERE campaign_id = %(campaign_id)s
            ORDER BY created_at DESC
            LIMIT %(limit)s
            """,
            {"campaign_id": campaign_id, "limit": limit},
        )
        return [row for row in (_normalize_event(row) for row in rows) if row]

    with _JSON_LOCK:
        rows = [
            row
            for row in _load_json()["events"]
            if str(row.get("campaign_id") or "") == campaign_id
        ]
    rows.sort(key=lambda row: str(row.get("created_at") or ""), reverse=True)
    return [row for row in (_normalize_event(row) for row in rows[:limit]) if row]


def count_recipients_by_status(campaign_id: str) -> Dict[str, int]:
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT status, COUNT(*) AS count
            FROM email_campaign_recipients
            WHERE campaign_id = %(campaign_id)s
            GROUP BY status
            """,
            {"campaign_id": campaign_id},
        )
    else:
        with _JSON_LOCK:
            rows = [
                {"status": row.get("status"), "count": 1}
                for row in _load_json()["recipients"]
                if str(row.get("campaign_id") or "") == campaign_id
            ]

    counts: Dict[str, int] = {}
    for row in rows:
        status = str(row.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + int(row.get("count") or 0)
    return counts


def update_campaign_status(campaign_id: str, status: str, *, sent_at: Any = None) -> None:
    if _using_mysql():
        mysql_client.execute(
            """
            UPDATE email_campaigns
            SET status = %(status)s,
                sent_at = COALESCE(%(sent_at)s, sent_at)
            WHERE id = %(id)s
            """,
            {"id": campaign_id, "status": status, "sent_at": to_mysql_datetime(sent_at)},
        )
        return

    with _JSON_LOCK:
        store = _load_json()
        for campaign in store["campaigns"]:
            if campaign.get("id") == campaign_id:
                campaign["status"] = status
                if sent_at:
                    campaign["sent_at"] = _format_datetime(sent_at)
                break
        _save_json(store)


def update_recipient_status(
    recipient_id: str,
    status: str,
    *,
    sent_at: Any = None,
    error_message: Optional[str] = None,
) -> None:
    if _using_mysql():
        mysql_client.execute(
            """
            UPDATE email_campaign_recipients
            SET status = %(status)s,
                sent_at = %(sent_at)s,
                error_message = %(error_message)s
            WHERE id = %(id)s
            """,
            {
                "id": recipient_id,
                "status": status,
                "sent_at": to_mysql_datetime(sent_at),
                "error_message": error_message,
            },
        )
        return

    with _JSON_LOCK:
        store = _load_json()
        for recipient in store["recipients"]:
            if recipient.get("id") == recipient_id:
                recipient["status"] = status
                recipient["sent_at"] = _format_datetime(sent_at) if sent_at else None
                recipient["error_message"] = error_message
                break
        _save_json(store)


def update_recipient_status_by_campaign_and_email(
    campaign_id: str,
    recipient_email: str,
    status: str,
    *,
    sent_at: Any = None,
    error_message: Optional[str] = None,
) -> bool:
    normalized_email = str(recipient_email or "").strip().lower()
    if not campaign_id or not normalized_email:
        return False
    if _using_mysql():
        updated = mysql_client.execute(
            """
            UPDATE email_campaign_recipients
            SET status = %(status)s,
                sent_at = COALESCE(%(sent_at)s, sent_at),
                error_message = %(error_message)s
            WHERE campaign_id = %(campaign_id)s
              AND recipient_email = %(recipient_email)s
            """,
            {
                "campaign_id": campaign_id,
                "recipient_email": normalized_email,
                "status": status,
                "sent_at": to_mysql_datetime(sent_at),
                "error_message": error_message,
            },
        )
        return bool(updated)

    updated = False
    with _JSON_LOCK:
        store = _load_json()
        for recipient in store["recipients"]:
            if (
                str(recipient.get("campaign_id") or "") == campaign_id
                and str(recipient.get("recipient_email") or "").strip().lower() == normalized_email
            ):
                recipient["status"] = status
                if sent_at:
                    recipient["sent_at"] = _format_datetime(sent_at)
                recipient["error_message"] = error_message
                updated = True
                break
        if updated:
            _save_json(store)
    return updated


def get_recipient_by_campaign_and_email(campaign_id: str, recipient_email: str) -> Optional[Dict[str, Any]]:
    normalized_email = str(recipient_email or "").strip().lower()
    if not campaign_id or not normalized_email:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT *
            FROM email_campaign_recipients
            WHERE campaign_id = %(campaign_id)s
              AND recipient_email = %(recipient_email)s
            LIMIT 1
            """,
            {"campaign_id": campaign_id, "recipient_email": normalized_email},
        )
        return _normalize_recipient(row)

    with _JSON_LOCK:
        recipient = next(
            (
                row
                for row in _load_json()["recipients"]
                if str(row.get("campaign_id") or "") == campaign_id
                and str(row.get("recipient_email") or "").strip().lower() == normalized_email
            ),
            None,
        )
    return _normalize_recipient(recipient)


def list_recipients_by_status(status: str, *, limit: int = 250) -> List[Dict[str, Any]]:
    normalized_status = str(status or "").strip()
    if not normalized_status:
        return []
    limit = max(1, min(int(limit or 250), 1000))
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT *
            FROM email_campaign_recipients
            WHERE status = %(status)s
            ORDER BY sent_at ASC, created_at ASC, id ASC
            LIMIT %(limit)s
            """,
            {"status": normalized_status, "limit": limit},
        )
        return [row for row in (_normalize_recipient(row) for row in rows) if row]

    with _JSON_LOCK:
        rows = [
            row
            for row in _load_json()["recipients"]
            if str(row.get("status") or "") == normalized_status
        ]
    rows.sort(key=lambda row: (str(row.get("sent_at") or ""), str(row.get("created_at") or ""), str(row.get("id") or "")))
    return [row for row in (_normalize_recipient(row) for row in rows[:limit]) if row]


def requeue_stale_processing_recipients(cutoff: Any) -> int:
    cutoff_value = _format_datetime(cutoff)
    if not cutoff_value:
        return 0
    if _using_mysql():
        return int(
            mysql_client.execute(
                """
                UPDATE email_campaign_recipients
                SET status = 'pending',
                    sent_at = NULL,
                    error_message = NULL
                WHERE status = 'processing'
                  AND sent_at IS NOT NULL
                  AND sent_at <= %(cutoff)s
                """,
                {"cutoff": to_mysql_datetime(cutoff_value)},
            )
            or 0
        )

    requeued = 0
    with _JSON_LOCK:
        store = _load_json()
        for recipient in store["recipients"]:
            if str(recipient.get("status") or "") != "processing":
                continue
            sent_at = _format_datetime(recipient.get("sent_at"))
            if sent_at and sent_at <= cutoff_value:
                recipient["status"] = "pending"
                recipient["sent_at"] = None
                recipient["error_message"] = None
                requeued += 1
        if requeued:
            _save_json(store)
    return requeued


def list_due_pending_recipients(*, limit: int = 25) -> List[Dict[str, Any]]:
    limit = max(1, min(int(limit or 25), 250))
    now_sql = to_mysql_datetime(_now_iso())
    if _using_mysql():
        rows = mysql_client.fetch_all(
            """
            SELECT
                r.id AS recipient_id,
                r.campaign_id,
                r.recipient_email,
                r.recipient_name,
                r.recipient_type,
                r.variables_json AS recipient_variables_json,
                c.template_id,
                c.campaign_type,
                c.subject,
                c.status AS campaign_status,
                c.variables_json AS campaign_variables_json
            FROM email_campaign_recipients r
            INNER JOIN email_campaigns c ON c.id = r.campaign_id
            WHERE r.status = 'pending'
              AND c.status IN ('scheduled', 'sending')
              AND (c.scheduled_at IS NULL OR c.scheduled_at <= %(now)s)
            ORDER BY c.created_at ASC, r.created_at ASC, r.id ASC
            LIMIT %(limit)s
            """,
            {"now": now_sql, "limit": limit},
        )
        claimed: List[Dict[str, Any]] = []
        for row in rows:
            updated = mysql_client.execute(
                """
                UPDATE email_campaign_recipients
                SET status = 'processing',
                    sent_at = %(claimed_at)s,
                    error_message = NULL
                WHERE id = %(id)s
                  AND status = 'pending'
                """,
                {"id": row.get("recipient_id"), "claimed_at": now_sql},
            )
            if not updated:
                continue
            row["recipient_variables_json"] = _json_loads(row.get("recipient_variables_json"), {})
            row["campaign_variables_json"] = _json_loads(row.get("campaign_variables_json"), {})
            claimed.append(row)
        return claimed

    now_text = _now_iso()
    with _JSON_LOCK:
        store = _load_json()
        campaigns = {row.get("id"): row for row in store["campaigns"]}
        jobs: List[Dict[str, Any]] = []
        for recipient in store["recipients"]:
            if recipient.get("status") != "pending":
                continue
            campaign = campaigns.get(recipient.get("campaign_id"))
            if not campaign or campaign.get("status") not in ("scheduled", "sending"):
                continue
            scheduled_at = str(campaign.get("scheduled_at") or "")
            if scheduled_at and scheduled_at > now_text:
                continue
            recipient["status"] = "processing"
            recipient["sent_at"] = now_text
            recipient["error_message"] = None
            jobs.append(
                {
                    "recipient_id": recipient.get("id"),
                    "campaign_id": recipient.get("campaign_id"),
                    "recipient_email": recipient.get("recipient_email"),
                    "recipient_name": recipient.get("recipient_name"),
                    "recipient_type": recipient.get("recipient_type"),
                    "recipient_variables_json": recipient.get("variables_json") or {},
                    "template_id": campaign.get("template_id"),
                    "campaign_type": campaign.get("campaign_type"),
                    "subject": campaign.get("subject"),
                    "campaign_status": campaign.get("status"),
                    "campaign_variables_json": campaign.get("variables_json") or {},
                }
            )
            if len(jobs) >= limit:
                break
        _save_json(store)
        return jobs


def log_event(
    *,
    event_id: str,
    event_type: str,
    campaign_id: Optional[str] = None,
    recipient_email: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    record = {
        "id": event_id,
        "campaign_id": campaign_id,
        "recipient_email": recipient_email,
        "event_type": event_type,
        "metadata_json": metadata or {},
        "created_at": created_at or _now_iso(),
    }
    if _using_mysql():
        mysql_client.execute(
            """
            INSERT INTO email_events (
                id,
                campaign_id,
                recipient_email,
                event_type,
                metadata_json,
                created_at
            ) VALUES (
                %(id)s,
                %(campaign_id)s,
                %(recipient_email)s,
                %(event_type)s,
                %(metadata_json)s,
                %(created_at)s
            )
            """,
            {
                **record,
                "metadata_json": _json_dumps(record["metadata_json"]),
                "created_at": to_mysql_datetime(record["created_at"]),
            },
        )
        return record

    with _JSON_LOCK:
        store = _load_json()
        store["events"].append(record)
        _save_json(store)
    return record


def is_unsubscribed(email: str) -> bool:
    normalized = str(email or "").strip().lower()
    if not normalized:
        return False
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT recipient_email FROM email_unsubscribes WHERE recipient_email = %(email)s LIMIT 1",
            {"email": normalized},
        )
        return bool(row)
    with _JSON_LOCK:
        return any(str(row.get("recipient_email") or "").strip().lower() == normalized for row in _load_json()["unsubscribes"])


def add_unsubscribe(
    *,
    email: str,
    source: str,
    campaign_id: Optional[str] = None,
    created_at: Optional[str] = None,
) -> Dict[str, Any]:
    normalized = str(email or "").strip().lower()
    record = {
        "recipient_email": normalized,
        "source": source,
        "campaign_id": campaign_id,
        "created_at": created_at or _now_iso(),
    }
    if _using_mysql():
        mysql_client.execute(
            """
            INSERT INTO email_unsubscribes (
                recipient_email,
                source,
                campaign_id,
                created_at
            ) VALUES (
                %(recipient_email)s,
                %(source)s,
                %(campaign_id)s,
                %(created_at)s
            )
            ON DUPLICATE KEY UPDATE
                source = VALUES(source),
                campaign_id = COALESCE(VALUES(campaign_id), campaign_id),
                created_at = created_at
            """,
            {**record, "created_at": to_mysql_datetime(record["created_at"])},
        )
        return record

    with _JSON_LOCK:
        store = _load_json()
        existing = next(
            (
                row
                for row in store["unsubscribes"]
                if str(row.get("recipient_email") or "").strip().lower() == normalized
            ),
            None,
        )
        if existing:
            existing.update({key: value for key, value in record.items() if value is not None})
        else:
            store["unsubscribes"].append(record)
        _save_json(store)
    return record
