from __future__ import annotations

import re
from typing import Dict, List, Tuple

from ..repositories import sales_rep_repository, user_repository
from . import get_config


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

        existing = sales_rep_repository.find_by_email(email)
        if existing:
            sales_rep_repository.update({**existing, "name": name, "email": email, "phone": phone or existing.get("phone"),
                                         "territory": territory or existing.get("territory"), "initials": initials,
                                         "salesCode": sales_code or existing.get("salesCode")})
        else:
            sales_rep_repository.insert({"name": name, "email": email, "phone": phone, "territory": territory,
                                         "initials": initials, "salesCode": sales_code})

        user = user_repository.find_by_email(email)
        if user and user.get("role") != "sales_rep":
            user_repository.update({**user, "role": "sales_rep"})

        upserted += 1

    return {"success": True, "upserted": upserted, "skipped": skipped, "total": len(rows)}


def _service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err
