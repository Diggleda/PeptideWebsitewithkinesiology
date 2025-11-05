from __future__ import annotations

from datetime import datetime, timezone
from typing import Callable, Dict, List, Optional

from ..services import get_config
from ..database import mysql_client

from .. import storage


def _get_store():
    store = storage.user_store
    if store is None:
        raise RuntimeError("user_store is not initialised")
    return store


def _ensure_defaults(user: Dict) -> Dict:
    normalized = dict(user)
    normalized.setdefault("role", "doctor")
    normalized.setdefault("status", "active")
    normalized.setdefault("salesRepId", None)
    normalized.setdefault("referrerDoctorId", None)
    normalized.setdefault("phone", None)
    normalized["mustResetPassword"] = bool(normalized.get("mustResetPassword", False))
    normalized.setdefault("firstOrderBonusGrantedAt", None)
    normalized.setdefault("createdAt", normalized.get("createdAt") or None)
    if isinstance(normalized.get("visits"), (int, float)):
        normalized["visits"] = int(normalized["visits"])
    else:
        normalized["visits"] = 1 if normalized.get("createdAt") else 0
    normalized.setdefault("lastLoginAt", normalized.get("createdAt") or None)
    referral_credits = normalized.get("referralCredits", 0)
    normalized["referralCredits"] = float(referral_credits or 0)
    normalized["totalReferrals"] = int(normalized.get("totalReferrals", 0) or 0)
    return normalized


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _load() -> List[Dict]:
    if _using_mysql():
        return _mysql_get_all()
    return [_ensure_defaults(u) for u in _get_store().read()]


def _save(users: List[Dict]) -> None:
    if _using_mysql():
        raise RuntimeError("Direct save not supported with MySQL backend")
    _get_store().write([_ensure_defaults(user) for user in users])


def get_all() -> List[Dict]:
    return _load()


def find_by_email(email: str) -> Optional[Dict]:
    email = (email or "").strip().lower()
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM users WHERE email = %(email)s", {"email": email})
        return _row_to_user(row)
    return next((user for user in _load() if user.get("email") == email), None)


def find_by_id(user_id: str) -> Optional[Dict]:
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM users WHERE id = %(id)s", {"id": user_id})
        return _row_to_user(row)
    return next((user for user in _load() if user.get("id") == user_id), None)


def find_by_referral_code(code: str) -> Optional[Dict]:
    normalized = (code or "").strip().upper()
    if _using_mysql():
        row = mysql_client.fetch_one(
            """
            SELECT u.*
            FROM referral_codes rc
            JOIN users u ON u.id = rc.referrer_doctor_id
            WHERE rc.code = %(code)s
              AND rc.referrer_doctor_id IS NOT NULL
            """,
            {"code": normalized},
        )
        return _row_to_user(row)
    return next((user for user in _load() if (user.get("referralCode") or "").upper() == normalized), None)


def insert(user: Dict) -> Dict:
    if _using_mysql():
        return _mysql_insert(user)
    users = _load()
    normalized = _ensure_defaults(dict(user))
    normalized.setdefault("id", str(user.get("id") or _generate_id()))
    users.append(normalized)
    _save(users)
    return normalized


def update(user: Dict) -> Optional[Dict]:
    if _using_mysql():
        return _mysql_update(user)
    users = _load()
    for index, existing in enumerate(users):
        if existing.get("id") == user.get("id"):
            merged = _ensure_defaults({**existing, **user})
            users[index] = merged
            _save(users)
            return merged
    return None


def replace(predicate: Callable[[Dict], bool], updater: Callable[[Dict], Dict]) -> Optional[Dict]:
    if _using_mysql():
        candidates = get_all()
        for existing in candidates:
            if predicate(existing):
                updated = updater(existing)
                return update(updated)
        return None
    users = _load()
    for index, existing in enumerate(users):
        if predicate(existing):
            updated = _ensure_defaults(updater(existing))
            users[index] = updated
            _save(users)
            return updated
    return None


def _generate_id() -> str:
    from time import time

    return str(int(time() * 1000))


# MySQL helpers ---------------------------------------------------------------

def _mysql_get_all() -> List[Dict]:
    rows = mysql_client.fetch_all("SELECT * FROM users")
    return [_row_to_user(row) for row in rows]


def _mysql_insert(user: Dict) -> Dict:
    payload = _ensure_defaults(dict(user))
    payload.setdefault("id", payload.get("id") or _generate_id())
    params = _to_db_params(payload)
    mysql_client.execute(
        """
        INSERT INTO users (
            id, name, email, password, role, status, sales_rep_id, referrer_doctor_id,
            phone, referral_credits, total_referrals, visits,
            created_at, last_login_at, must_reset_password, first_order_bonus_granted_at
        ) VALUES (
            %(id)s, %(name)s, %(email)s, %(password)s, %(role)s, %(status)s, %(sales_rep_id)s,
            %(referrer_doctor_id)s, %(phone)s, %(referral_credits)s,
            %(total_referrals)s, %(visits)s, %(created_at)s, %(last_login_at)s,
            %(must_reset_password)s, %(first_order_bonus_granted_at)s
        )
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            password = VALUES(password),
            role = VALUES(role),
            status = VALUES(status),
            sales_rep_id = VALUES(sales_rep_id),
            referrer_doctor_id = VALUES(referrer_doctor_id),
            phone = VALUES(phone),
            referral_credits = VALUES(referral_credits),
            total_referrals = VALUES(total_referrals),
            visits = VALUES(visits),
            created_at = VALUES(created_at),
            last_login_at = VALUES(last_login_at),
            must_reset_password = VALUES(must_reset_password),
            first_order_bonus_granted_at = VALUES(first_order_bonus_granted_at)
        """,
        params,
    )
    return find_by_id(payload["id"])


def _mysql_update(user: Dict) -> Optional[Dict]:
    existing = find_by_id(user.get("id"))
    if not existing:
        return None
    merged = _ensure_defaults({**existing, **user})
    params = _to_db_params(merged)
    mysql_client.execute(
        """
        UPDATE users
        SET
            name = %(name)s,
            email = %(email)s,
            password = %(password)s,
            role = %(role)s,
            status = %(status)s,
            sales_rep_id = %(sales_rep_id)s,
            referrer_doctor_id = %(referrer_doctor_id)s,
            phone = %(phone)s,
            referral_credits = %(referral_credits)s,
            total_referrals = %(total_referrals)s,
            visits = %(visits)s,
            created_at = %(created_at)s,
            last_login_at = %(last_login_at)s,
            must_reset_password = %(must_reset_password)s,
            first_order_bonus_granted_at = %(first_order_bonus_granted_at)s
        WHERE id = %(id)s
        """,
        params,
    )
    return find_by_id(merged["id"])


def _row_to_user(row: Dict) -> Dict:
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
            "password": row.get("password"),
            "role": row.get("role"),
            "status": row.get("status"),
            "salesRepId": row.get("sales_rep_id"),
            "referrerDoctorId": row.get("referrer_doctor_id"),
            "phone": row.get("phone"),
            "referralCode": row.get("referral_code"),
            "referralCredits": float(row.get("referral_credits") or 0),
            "totalReferrals": int(row.get("total_referrals") or 0),
            "visits": int(row.get("visits") or 0),
            "createdAt": fmt_datetime(row.get("created_at")),
            "lastLoginAt": fmt_datetime(row.get("last_login_at")),
            "mustResetPassword": bool(row.get("must_reset_password")),
            "firstOrderBonusGrantedAt": fmt_datetime(row.get("first_order_bonus_granted_at")),
        }
    )


def _to_db_params(user: Dict) -> Dict:
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
        "id": user.get("id"),
        "name": user.get("name"),
        "email": user.get("email"),
        "password": user.get("password"),
        "role": user.get("role"),
        "status": user.get("status"),
        "sales_rep_id": user.get("salesRepId"),
        "referrer_doctor_id": user.get("referrerDoctorId"),
        "phone": user.get("phone"),
        "referral_credits": float(user.get("referralCredits") or 0),
        "total_referrals": int(user.get("totalReferrals") or 0),
        "visits": int(user.get("visits") or 0),
        "created_at": parse_dt(user.get("createdAt")),
        "last_login_at": parse_dt(user.get("lastLoginAt")),
        "must_reset_password": 1 if user.get("mustResetPassword") else 0,
        "first_order_bonus_granted_at": parse_dt(user.get("firstOrderBonusGrantedAt")),
    }
