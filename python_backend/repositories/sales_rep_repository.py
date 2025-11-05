from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Dict, List, Optional

from ..services import get_config
from ..database import mysql_client
from .. import storage


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _get_store():
    store = storage.sales_rep_store
    if store is None:
        raise RuntimeError("sales_rep_store is not initialised")
    return store


def _normalize_initials(initials: str) -> str:
    return re.sub(r"[^A-Za-z]", "", (initials or ""))[:2].upper().ljust(2, "X")[:2]


def _normalize_sales_code(code: Optional[str]) -> Optional[str]:
    if not code:
        return None
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(code).strip()).upper()
    return cleaned or None


def _ensure_defaults(rep: Dict) -> Dict:
    normalized = dict(rep)
    normalized.setdefault("id", rep.get("id") or _generate_id())
    name = normalized.get("name") or " ".join(filter(None, [rep.get("firstName"), rep.get("lastName")])).strip()
    normalized["name"] = name or "Sales Rep"
    normalized["initials"] = _normalize_initials(normalized.get("initials") or normalized["name"])
    normalized.setdefault("status", "active")
    normalized["email"] = (normalized.get("email") or "").lower() or None
    normalized.setdefault("phone", None)
    normalized.setdefault("territory", None)
    normalized["salesCode"] = _normalize_sales_code(normalized.get("salesCode") or normalized.get("sales_code"))
    created_at = normalized.get("createdAt") or _now()
    normalized["createdAt"] = created_at
    normalized["updatedAt"] = normalized.get("updatedAt") or created_at
    return normalized


def _load() -> List[Dict]:
    if _using_mysql():
        rows = mysql_client.fetch_all("SELECT * FROM sales_reps")
        return [_row_to_rep(row) for row in rows]
    return [_ensure_defaults(rep) for rep in _get_store().read()]


def _save(reps: List[Dict]) -> None:
    if _using_mysql():
        raise RuntimeError("Direct save not available with MySQL backend")
    _get_store().write([_ensure_defaults(rep) for rep in reps])


def get_all() -> List[Dict]:
    return _load()


def find_by_id(rep_id: str) -> Optional[Dict]:
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM sales_reps WHERE id = %(id)s", {"id": rep_id})
        return _row_to_rep(row)
    return next((rep for rep in _load() if rep.get("id") == rep_id), None)


def find_by_email(email: str) -> Optional[Dict]:
    email = (email or "").strip().lower()
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM sales_reps WHERE email = %(email)s", {"email": email})
        return _row_to_rep(row)
    return next((rep for rep in _load() if (rep.get("email") or "") == email), None)


def find_by_initials(initials: str) -> Optional[Dict]:
    candidate = _normalize_initials(initials)
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM sales_reps WHERE initials = %(initials)s", {"initials": candidate})
        return _row_to_rep(row)
    return next((rep for rep in _load() if rep.get("initials") == candidate), None)


def find_by_sales_code(code: str) -> Optional[Dict]:
    candidate = _normalize_sales_code(code)
    if not candidate:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM sales_reps WHERE sales_code = %(sales_code)s", {"sales_code": candidate})
        return _row_to_rep(row)
    return next(
        (
            rep
            for rep in _load()
            if _normalize_sales_code(rep.get("salesCode")) == candidate
        ),
        None,
    )


def insert(rep: Dict) -> Dict:
    if _using_mysql():
        record = _ensure_defaults(rep)
        params = _to_db_params(record)
        mysql_client.execute(
            """
            INSERT INTO sales_reps (
                id, name, email, phone, territory, initials, sales_code, status, created_at, updated_at
            ) VALUES (
                %(id)s, %(name)s, %(email)s, %(phone)s, %(territory)s, %(initials)s, %(sales_code)s, %(status)s, %(created_at)s, %(updated_at)s
            )
            ON DUPLICATE KEY UPDATE
                name = VALUES(name),
                email = VALUES(email),
                phone = VALUES(phone),
                territory = VALUES(territory),
                initials = VALUES(initials),
                sales_code = VALUES(sales_code),
                status = VALUES(status),
                updated_at = VALUES(updated_at)
            """,
            params,
        )
        return find_by_id(record["id"])

    reps = _load()
    normalized = _ensure_defaults(rep)
    normalized["updatedAt"] = _now()
    reps.append(normalized)
    _save(reps)
    return normalized


def update(rep: Dict) -> Optional[Dict]:
    if _using_mysql():
        existing = find_by_id(rep.get("id"))
        if not existing:
            return None
        merged = _ensure_defaults({**existing, **rep, "updatedAt": _now()})
        params = _to_db_params(merged)
        mysql_client.execute(
            """
            UPDATE sales_reps
            SET
                name = %(name)s,
                email = %(email)s,
                phone = %(phone)s,
                territory = %(territory)s,
                initials = %(initials)s,
                sales_code = %(sales_code)s,
                status = %(status)s,
                updated_at = %(updated_at)s
            WHERE id = %(id)s
            """,
            params,
        )
        return find_by_id(merged["id"])

    reps = _load()
    for index, existing in enumerate(reps):
        if existing.get("id") == rep.get("id"):
            merged = _ensure_defaults({**existing, **rep, "updatedAt": _now()})
            reps[index] = merged
            _save(reps)
            return merged
    return None


def _row_to_rep(row: Optional[Dict]) -> Optional[Dict]:
    if not row:
        return None

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    return _ensure_defaults(
        {
            "id": row.get("id"),
            "name": row.get("name"),
            "email": row.get("email"),
            "phone": row.get("phone"),
            "territory": row.get("territory"),
            "initials": row.get("initials"),
            "salesCode": row.get("sales_code") or row.get("salesCode"),
            "status": row.get("status"),
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
    )


def _to_db_params(rep: Dict) -> Dict:
    def parse_dt(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=None)
        value = str(value)
        if value.endswith("Z"):
            value = value[:-1]
        value = value.replace("T", " ")
        return value[:26]

    return {
        "id": rep.get("id"),
        "name": rep.get("name"),
        "email": rep.get("email"),
        "phone": rep.get("phone"),
        "territory": rep.get("territory"),
        "initials": rep.get("initials"),
        "sales_code": rep.get("salesCode"),
        "status": rep.get("status"),
        "created_at": parse_dt(rep.get("createdAt")),
        "updated_at": parse_dt(rep.get("updatedAt")),
    }


def _generate_id() -> str:
    from time import time

    return str(int(time() * 1000))


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()
