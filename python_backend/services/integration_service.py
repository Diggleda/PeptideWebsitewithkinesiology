from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List

from ..database import mysql_client
from ..repositories import sales_rep_repository, user_repository
from ..storage import seamless_store
from ..utils.http import service_error as _service_error
from . import get_config
from . import peptide_forum_service


def _sanitize_string(value: str, max_length: int = 190) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\r\n\t]+", " ", value.strip())[:max_length]


def _normalize_email(value: str) -> str:
    candidate = _sanitize_string(value, 190).lower()
    if candidate and re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", candidate):
        return candidate
    return ""


def _normalize_initials(value: str, fallback_name: str) -> str:
    raw = _sanitize_string(value, 10).upper()
    cleaned = re.sub(r"[^A-Z0-9]", "", raw)
    if cleaned:
        return cleaned[:6]

    fallback_parts = [part[:1] for part in _sanitize_string(fallback_name, 190).upper().split() if part]
    fallback = "".join(fallback_parts) or _sanitize_string(fallback_name, 6).upper()
    fallback_cleaned = re.sub(r"[^A-Z0-9]", "", fallback)
    return fallback_cleaned[:6] or "XX"


def sync_sales_reps(payload: Dict, headers: Dict[str, str]) -> Dict:
    config = get_config()
    secret = config.integrations.get("google_sheets_secret")
    if secret:
        header_secret = headers.get("x-webhook-signature") or headers.get("authorization", "")
        header_secret = re.sub(r"^(Bearer|Basic)\s+", "", header_secret, flags=re.I)
        if header_secret != secret:
            raise _service_error("Unauthorized webhook request", 401)

    rows: List[Dict] = payload.get("salesReps") if isinstance(payload.get("salesReps"), list) else []
    upserted = 0
    skipped = 0

    for row in rows:
        email = _normalize_email(row.get("email"))
        name = _sanitize_string(row.get("name") or row.get("fullName") or "", 190)
        if not email or not name:
            skipped += 1
            continue

        phone = _sanitize_string(row.get("phone") or "", 32) or None
        territory = _sanitize_string(row.get("territory") or "", 120) or None
        initials = _normalize_initials(row.get("initials") or row.get("codePrefix") or "", name)
        sales_code = _sanitize_string(row.get("salesCode") or row.get("sales_code") or "", 8)
        sales_code = sales_code.upper() or None

        user = user_repository.find_by_email(email)

        existing = sales_rep_repository.find_by_email(email)
        if existing:
            update_payload = {
                **existing,
                "name": name,
                "email": email,
                "phone": phone or existing.get("phone"),
                "territory": territory or existing.get("territory"),
                "initials": initials,
                "salesCode": sales_code or existing.get("salesCode"),
            }
            if user and not existing.get("legacyUserId"):
                update_payload["legacyUserId"] = user.get("id")
            sales_rep_repository.update(update_payload)
        else:
            # IMPORTANT: do not create a new sales rep id when we can reuse an existing identifier.
            # In this system, many deployments use `users.sales_rep_id` (`salesRepId`) as an external
            # rep key referenced by orders and integrations. When we sync reps from Google Sheets and
            # insert without an explicit id, the repository will generate a new timestamp-like id,
            # which can create a mismatch between `sales_reps.id` and `users.sales_rep_id`.
            rep_id = None
            if user:
                rep_id = (user.get("salesRepId") or user.get("sales_rep_id") or "").strip() or None
                if not rep_id:
                    rep_id = str(user.get("id") or "").strip() or None
            insert_payload = {
                "id": rep_id,
                "legacyUserId": user.get("id") if user else None,
                "name": name,
                "email": email,
                "phone": phone,
                "territory": territory,
                "initials": initials,
                "salesCode": sales_code,
            }
            # Remove None ids so the repository can generate one only when unavoidable.
            if not insert_payload.get("id"):
                insert_payload.pop("id", None)
            sales_rep_repository.insert(insert_payload)

        if user and user.get("role") != "sales_rep":
            user_repository.update({**user, "role": "sales_rep"})

        upserted += 1

    return {"success": True, "upserted": upserted, "skipped": skipped, "total": len(rows)}

def sync_peptide_forum(payload: Dict, headers: Dict[str, str]) -> Dict:
    config = get_config()
    secret = config.integrations.get("google_sheets_secret")
    if secret:
        header_secret = headers.get("x-webhook-signature") or headers.get("authorization", "")
        header_secret = re.sub(r"^(Bearer|Basic)\s+", "", header_secret, flags=re.I)
        if header_secret != secret:
            raise _service_error("Unauthorized webhook request", 401)

    items: List[Dict] = payload.get("items") if isinstance(payload.get("items"), list) else []
    result = peptide_forum_service.replace_from_webhook(items)
    return {"success": True, **result}


def _normalize_role(value: Any) -> str:
    role = str(value or "").strip().lower()
    return re.sub(r"[\s-]+", "_", role)


def _ensure_sales_role(current_user: Dict[str, Any]) -> None:
    role = _normalize_role((current_user or {}).get("role"))
    if role not in ("sales_rep", "test_rep", "rep", "sales_lead", "saleslead", "admin"):
        raise _service_error("Sales role access required", 403)


def _safe_limit(limit_raw: Any, fallback: int = 20) -> int:
    try:
        value = int(limit_raw)
    except Exception:
        value = fallback
    return max(1, min(value, 200))


def _to_iso_or_none(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        parsed = value
    elif isinstance(value, (int, float)):
        try:
            parsed = datetime.fromtimestamp(float(value), tz=timezone.utc)
        except Exception:
            return None
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except Exception:
            return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_json_maybe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list, int, float, bool)):
        return value
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except Exception:
            return value
    return value


def _normalize_seamless_entry(row: Dict[str, Any], fallback_id: int) -> Dict[str, Any]:
    entry_id = row.get("id")
    source_system = str(row.get("sourceSystem") or row.get("source_system") or "seamless").strip().lower() or "seamless"
    trigger = str(row.get("trigger") or "webhook").strip().lower() or "webhook"
    actor_id = row.get("actorId") if row.get("actorId") is not None else row.get("actor_id")
    actor_text = str(actor_id).strip() if actor_id is not None else ""
    received_at = _to_iso_or_none(row.get("receivedAt") or row.get("received_at"))
    created_at = _to_iso_or_none(row.get("createdAt") or row.get("created_at")) or received_at
    payload = _parse_json_maybe(row.get("payload") if "payload" in row else row.get("payload_json"))
    return {
        "id": str(entry_id if entry_id is not None else fallback_id),
        "sourceSystem": source_system,
        "trigger": trigger,
        "actorId": actor_text or None,
        "payload": payload,
        "receivedAt": received_at,
        "createdAt": created_at,
    }


def _entry_sort_key(entry: Dict[str, Any]) -> float:
    for key in ("createdAt", "receivedAt"):
        parsed = _to_iso_or_none(entry.get(key))
        if parsed:
            try:
                return datetime.fromisoformat(parsed.replace("Z", "+00:00")).timestamp()
            except Exception:
                continue
    return 0.0


def list_seamless_raw_payloads(current_user: Dict[str, Any], limit: Any = 20) -> Dict[str, Any]:
    _ensure_sales_role(current_user)
    safe_limit = _safe_limit(limit, 20)
    entries: List[Dict[str, Any]] = []

    if bool(get_config().mysql.get("enabled")):
        try:
            rows = mysql_client.fetch_all(
                """
                SELECT
                  id,
                  source_system,
                  trigger,
                  actor_id,
                  payload_json,
                  received_at,
                  created_at
                FROM seamless
                ORDER BY created_at DESC, id DESC
                LIMIT %(limit)s
                """,
                {"limit": safe_limit},
            )
            entries = [
                _normalize_seamless_entry(row or {}, index + 1)
                for index, row in enumerate(rows or [])
            ]
        except Exception:
            # Fall back to JSON store if the table is not provisioned in this environment.
            entries = []

    if not entries:
        rows = seamless_store.read() if seamless_store else []
        normalized = [
            _normalize_seamless_entry(row or {}, index + 1)
            for index, row in enumerate(rows if isinstance(rows, list) else [])
        ]
        entries = sorted(normalized, key=_entry_sort_key, reverse=True)[:safe_limit]

    return {
        "ok": True,
        "sourceSystem": "seamless",
        "count": len(entries),
        "entries": entries,
    }
