from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Dict, Tuple

import bcrypt
import jwt

from ..repositories import user_repository, sales_rep_repository
from . import get_config
from . import referral_service


def _sanitize_name(value: str) -> str:
    if not value:
        return ""
    return re.sub(r"[\r\n\t]+", " ", str(value).strip())[:190]


def _normalize_email(value: str) -> str:
    if not value:
        return ""
    return str(value).strip().lower()


def _create_auth_token(payload: Dict) -> str:
    config = get_config()
    now = datetime.now(timezone.utc)
    claims = {
        **payload,
        "exp": now + timedelta(days=7),
        "iat": now,
    }
    return jwt.encode(claims, config.jwt_secret, algorithm="HS256")


_CODE_PATTERN = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}$")
_BCRYPT_PREFIX = re.compile(r"^\$2[abxy]\$")


def _safe_check_password(password: str, hashed: str) -> bool:
    encoded = (hashed or "").strip()
    if not _BCRYPT_PREFIX.match(encoded):
        return False
    try:
        return bcrypt.checkpw(password.encode("utf-8"), encoded.encode("utf-8"))
    except ValueError as exc:
        if "Invalid salt" in str(exc):
            return False
        raise


def register(data: Dict) -> Dict:
    name = _sanitize_name(data.get("name"))
    email = _normalize_email(data.get("email"))
    password = (data.get("password") or "").strip()
    code = (data.get("code") or "").strip().upper()
    phone = data.get("phone") or None

    if not name or not email:
        raise _bad_request("NAME_EMAIL_REQUIRED")
    if not password:
        raise _bad_request("PASSWORD_REQUIRED")
    if not _CODE_PATTERN.fullmatch(code):
        raise _bad_request("INVALID_REFERRAL_CODE")

    if user_repository.find_by_email(email):
        raise _conflict("EMAIL_EXISTS")

    onboarding_record = referral_service.get_onboarding_code(code)
    sales_rep = None

    if onboarding_record:
        if onboarding_record.get("status") != "available":
            raise _conflict("REFERRAL_CODE_UNAVAILABLE")
    else:
        sales_rep = sales_rep_repository.find_by_sales_code(code)
        if not sales_rep:
            raise _not_found("REFERRAL_CODE_NOT_FOUND")

    hashed_password = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    now = datetime.now(timezone.utc).isoformat()

    if onboarding_record:
        sales_rep_id = onboarding_record.get("salesRepId")
        referrer_doctor_id = onboarding_record.get("referrerDoctorId")
    else:
        sales_rep_id = sales_rep.get("id") if sales_rep else None
        referrer_doctor_id = None

    if not sales_rep_id:
        raise _conflict("REFERRAL_CODE_UNAVAILABLE")

    user = user_repository.insert(
        {
            "id": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
            "name": name,
            "email": email,
            "phone": phone,
            "password": hashed_password,
            "role": "doctor",
            "salesRepId": sales_rep_id,
            "referrerDoctorId": referrer_doctor_id,
            "referralCredits": 0,
            "totalReferrals": 0,
            "visits": 1,
            "createdAt": now,
            "lastLoginAt": now,
            "mustResetPassword": False,
        }
    )

    if onboarding_record:
        referral_service.redeem_onboarding_code({"code": code, "doctorId": user["id"]})

    token = _create_auth_token({"id": user["id"], "email": user["email"]})

    return {"token": token, "user": _sanitize_user(user)}


def login(data: Dict) -> Dict:
    email = _normalize_email(data.get("email"))
    password = data.get("password")
    if not email or not password:
        raise _bad_request("Email and password required")

    user = user_repository.find_by_email(email)
    if user:
        if not _safe_check_password(password, str(user.get("password", ""))):
            raise _unauthorized("INVALID_PASSWORD")

        updated = user_repository.update(
            {
                **user,
                "visits": int(user.get("visits") or 1) + 1,
                "lastLoginAt": datetime.now(timezone.utc).isoformat(),
                "mustResetPassword": False,
            }
        ) or user

        token = _create_auth_token({"id": updated["id"], "email": updated["email"]})
        return {"token": token, "user": _sanitize_user(updated)}

    sales_rep = sales_rep_repository.find_by_email(email)
    if not sales_rep:
        raise _not_found("EMAIL_NOT_FOUND")

    if not _safe_check_password(password, str(sales_rep.get("password", ""))):
        raise _unauthorized("INVALID_PASSWORD")

    updated_rep = sales_rep_repository.update(
        {
            **sales_rep,
            "visits": int(sales_rep.get("visits") or 1) + 1,
            "lastLoginAt": datetime.now(timezone.utc).isoformat(),
            "mustResetPassword": False,
        }
    ) or sales_rep

    token = _create_auth_token({"id": updated_rep["id"], "email": updated_rep.get("email"), "role": "sales_rep"})
    return {"token": token, "user": _sanitize_sales_rep(updated_rep)}


def check_email(email: str) -> Dict:
    normalized = _normalize_email(email)
    if not normalized:
        raise _bad_request("EMAIL_REQUIRED")
    exists = user_repository.find_by_email(normalized) is not None or sales_rep_repository.find_by_email(normalized) is not None
    return {"exists": exists}


def get_profile(user_id: str) -> Dict:
    user = user_repository.find_by_id(user_id)
    if not user:
        raise _not_found("User not found")
    return _sanitize_user(user)


def _sanitize_user(user: Dict) -> Dict:
    sanitized = dict(user)
    sanitized.pop("password", None)
    rep_id = sanitized.get("salesRepId")
    if rep_id:
        sales_rep = sales_rep_repository.find_by_id(rep_id)
        if sales_rep:
            sanitized["salesRep"] = {
                "id": sales_rep.get("id"),
                "name": sales_rep.get("name"),
                "email": sales_rep.get("email"),
                "phone": sales_rep.get("phone"),
            }
        else:
            sanitized["salesRep"] = None
    else:
        sanitized["salesRep"] = None
    return sanitized


def _sanitize_sales_rep(rep: Dict) -> Dict:
    sanitized = dict(rep)
    sanitized.pop("password", None)
    sanitized.setdefault("role", "sales_rep")
    sanitized.setdefault("salesRepId", sanitized.get("id"))
    sanitized.setdefault("salesRep", None)
    return sanitized


def _bad_request(message: str) -> Exception:
    err = ValueError(message)
    setattr(err, "status", 400)
    return err


def _conflict(message: str) -> Exception:
    err = ValueError(message)
    setattr(err, "status", 409)
    return err


def _not_found(message: str) -> Exception:
    err = ValueError(message)
    setattr(err, "status", 404)
    return err


def _unauthorized(message: str) -> Exception:
    err = ValueError(message)
    setattr(err, "status", 401)
    return err
