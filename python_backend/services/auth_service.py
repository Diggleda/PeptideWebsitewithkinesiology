from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

import bcrypt
import jwt

from ..repositories import user_repository, sales_rep_repository
from . import email_service, get_config, npi_service, referral_service


def _sanitize_name(value: str) -> str:
    if not value:
        return ""
    return re.sub(r"[\r\n\t]+", " ", str(value).strip())[:190]


def _normalize_email(value: str) -> str:
    if not value:
        return ""
    return str(value).strip().lower()


def _build_reset_url(token: str) -> str:
    config = get_config()
    base = (config.frontend_base_url or "http://localhost:3000").rstrip("/")
    return f"{base}/reset-password?token={token}"


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

logger = logging.getLogger(__name__)
_PASSWORD_RESET_TOKENS: Dict[str, Dict[str, Any]] = {}


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
    raw_npi = data.get("npiNumber") or data.get("npi_number") or ""
    normalized_npi = npi_service.normalize_npi(raw_npi)
    npi_verification = None
    npi_last_verified_at = None
    npi_status = None

    if not name or not email:
        raise _bad_request("NAME_EMAIL_REQUIRED")
    if not password:
        raise _bad_request("PASSWORD_REQUIRED")
    if not _CODE_PATTERN.fullmatch(code):
        raise _bad_request("INVALID_REFERRAL_CODE")

    sales_rep_account = sales_rep_repository.find_by_email(email)
    if sales_rep_account:
        return _register_sales_rep_account(
            sales_rep_account,
            name=name,
            email=email,
            raw_password=password,
            code=code,
            phone=phone,
        )

    if user_repository.find_by_email(email):
        raise _conflict("EMAIL_EXISTS")

    if len(normalized_npi) != 10:
        raise _bad_request("NPI_INVALID")

    if user_repository.find_by_npi_number(normalized_npi):
        raise _conflict("NPI_ALREADY_REGISTERED")

    try:
        npi_verification = npi_service.verify_npi(normalized_npi)
    except npi_service.NpiInvalidError:
        raise _bad_request("NPI_INVALID")
    except npi_service.NpiNotFoundError:
        raise _not_found("NPI_NOT_FOUND")
    except npi_service.NpiLookupError as exc:
        err = _bad_request("NPI_LOOKUP_FAILED")
        raise err from exc

    npi_last_verified_at = datetime.now(timezone.utc).isoformat()
    npi_status = "verified"

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
            "npiNumber": normalized_npi,
            "npiLastVerifiedAt": npi_last_verified_at,
            "npiVerification": npi_verification,
            "npiStatus": npi_status,
            "npiCheckError": None,
        }
    )

    if onboarding_record:
        referral_service.redeem_onboarding_code({"code": code, "doctorId": user["id"]})

    token_role = (user.get("role") or "doctor").lower()
    token = _create_auth_token({"id": user["id"], "email": user["email"], "role": token_role})

    return {"token": token, "user": _sanitize_user(user)}

def _register_sales_rep_account(
    sales_rep: Dict,
    *,
    name: str,
    email: str,
    raw_password: str,
    code: str,
    phone: Optional[str],
) -> Dict:
    expected_code = (sales_rep.get("salesCode") or "").upper()
    if expected_code and expected_code != code:
        raise _conflict("SALES_REP_EMAIL_MISMATCH")

    if sales_rep.get("password"):
        raise _conflict("EMAIL_EXISTS")

    hashed_password = bcrypt.hashpw(raw_password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    now = datetime.now(timezone.utc).isoformat()

    user_record = user_repository.find_by_email(email)
    if user_record:
        updated_user = user_repository.update(
            {
                **user_record,
                "name": name,
                "password": hashed_password,
                "role": "sales_rep",
                "status": "active",
                "phone": phone or user_record.get("phone"),
                "salesRepId": sales_rep.get("id"),
                "visits": int(user_record.get("visits") or 0) + 1,
                "lastLoginAt": now,
                "mustResetPassword": False,
            }
        )
        user_record = updated_user or user_record
    else:
        user_record = user_repository.insert(
            {
                "name": name,
                "email": email,
                "phone": phone or sales_rep.get("phone"),
                "password": hashed_password,
                "role": "sales_rep",
                "status": "active",
                "salesRepId": sales_rep.get("id"),
                "referralCredits": sales_rep.get("referralCredits") or 0,
                "totalReferrals": sales_rep.get("totalReferrals") or 0,
                "visits": 1,
                "createdAt": now,
                "lastLoginAt": now,
                "mustResetPassword": False,
            }
        )

    sales_rep_update = {
        **sales_rep,
        "name": name,
        "email": email,
        "phone": phone or sales_rep.get("phone"),
        "password": hashed_password,
        "role": "sales_rep",
        "legacyUserId": user_record.get("id") or sales_rep.get("legacyUserId"),
        "lastLoginAt": now,
        "visits": int(sales_rep.get("visits") or 0) + 1,
        "mustResetPassword": False,
        "status": "active",
        "updatedAt": now,
    }

    updated_sales_rep = sales_rep_repository.update(sales_rep_update)
    if not updated_sales_rep:
        updated_sales_rep = sales_rep_repository.insert(sales_rep_update)

    if updated_sales_rep.get("legacyUserId") != user_record.get("id"):
        updated_sales_rep = sales_rep_repository.update(
            {**updated_sales_rep, "legacyUserId": user_record.get("id")}
        ) or updated_sales_rep

    token = _create_auth_token(
        {"id": updated_sales_rep["id"], "email": updated_sales_rep.get("email"), "role": "sales_rep"}
    )

    return {"token": token, "user": _sanitize_sales_rep(updated_sales_rep)}


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

        token_role = (updated.get("role") or "doctor").lower()
        token = _create_auth_token({"id": updated["id"], "email": updated["email"], "role": token_role})
        return {"token": token, "user": _sanitize_user(updated)}

    sales_rep = sales_rep_repository.find_by_email(email)
    if not sales_rep:
        raise _not_found("EMAIL_NOT_FOUND")

    hashed_password = (sales_rep.get("password") or "").strip()
    if not hashed_password:
        raise _conflict("SALES_REP_ACCOUNT_REQUIRED")

    if not _safe_check_password(password, hashed_password):
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


def verify_npi(npi_number: Optional[str]) -> Dict:
    normalized = npi_service.normalize_npi(npi_number)
    if len(normalized) != 10:
        raise _bad_request("NPI_INVALID")
    try:
        verification = npi_service.verify_npi(normalized)
        return {
            "status": "verified",
            "npiNumber": verification.get("npiNumber"),
            "name": verification.get("name"),
            "credential": verification.get("credential"),
            "primaryTaxonomy": verification.get("primaryTaxonomy"),
            "organizationName": verification.get("organizationName"),
        }
    except npi_service.NpiInvalidError:
        raise _bad_request("NPI_INVALID")
    except npi_service.NpiNotFoundError:
        raise _not_found("NPI_NOT_FOUND")
    except npi_service.NpiLookupError as exc:
        err = _bad_request("NPI_LOOKUP_FAILED")
        raise err from exc


def update_profile(user_id: str, data: Dict) -> Dict:
    user = user_repository.find_by_id(user_id)
    if not user:
        raise _not_found("User not found")

    name = _sanitize_name(data.get("name") or user.get("name") or "")
    phone = (data.get("phone") or user.get("phone") or None)
    email = _normalize_email(data.get("email") or user.get("email") or "")
    profile_image_url = data.get("profileImageUrl") or user.get("profileImageUrl") or None

    if email and email != user.get("email"):
        existing = user_repository.find_by_email(email)
        if existing and existing.get("id") != user.get("id"):
            raise _conflict("EMAIL_EXISTS")

    updated = {
        **user,
        "name": name or user.get("name"),
        "phone": phone,
        "email": email or user.get("email"),
        "profileImageUrl": profile_image_url,
    }

    logger.info(
        {
            "userId": user_id,
            "hasProfileImage": bool(profile_image_url),
            "profileImageBytes": len(profile_image_url.encode("utf-8")) if isinstance(profile_image_url, str) else 0,
        },
        "Profile update requested (includes profile image)",
    )

    saved = user_repository.update(updated) or updated
    logger.info(
        {
            "userId": user_id,
            "hasProfileImage": bool(saved.get("profileImageUrl")),
        },
        "Profile update saved",
    )
    return _sanitize_user(saved)


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


def request_password_reset(email: Optional[str]) -> Dict:
    normalized = _normalize_email(email or "")
    if not normalized:
        raise _bad_request("EMAIL_REQUIRED")

    account: Optional[Dict[str, Any]] = user_repository.find_by_email(normalized)
    account_type = "user"
    account_id: Optional[str] = None
    recipient = normalized

    if account:
        account_id = account.get("id")
        recipient = account.get("email") or normalized
    else:
        account = sales_rep_repository.find_by_email(normalized)
        if account:
            account_type = "sales_rep"
            account_id = account.get("id")
            recipient = account.get("email") or normalized
        else:
            logger.info("Password reset requested for unknown email", extra={"email": normalized})
            return {"status": "ok"}

    token = secrets.token_hex(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=1)
    _PASSWORD_RESET_TOKENS[token] = {
        "account_type": account_type,
        "account_id": account_id,
        "expires": expires,
    }

    reset_url = _build_reset_url(token)
    try:
        email_service.send_password_reset_email(recipient, reset_url)
    except Exception as exc:  # pragma: no cover - email transport failures should not break flow
        logger.warning("Failed to dispatch password reset email", exc_info=exc)

    response: Dict[str, Any] = {"status": "ok"}
    if not get_config().is_production:
        response["debug"] = {"token": token, "resetUrl": reset_url}
    return response


def reset_password(data: Dict) -> Dict:
    token = (data.get("token") or "").strip()
    password = (data.get("password") or "").strip()
    if not token or not password:
        raise _bad_request("TOKEN_AND_PASSWORD_REQUIRED")

    token_details = _PASSWORD_RESET_TOKENS.get(token)
    if not token_details or token_details.get("expires") < datetime.now(timezone.utc):
        raise _bad_request("TOKEN_INVALID")

    hashed_password = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    account_type = token_details.get("account_type")
    account_id = token_details.get("account_id")

    if account_type == "sales_rep":
        rep = sales_rep_repository.find_by_id(str(account_id))
        if not rep:
            _PASSWORD_RESET_TOKENS.pop(token, None)
            raise _not_found("USER_NOT_FOUND")
        sales_rep_repository.update({**rep, "password": hashed_password, "mustResetPassword": False})
        legacy_id = rep.get("legacyUserId")
        if legacy_id:
            linked_user = user_repository.find_by_id(str(legacy_id))
            if linked_user:
                user_repository.update({**linked_user, "password": hashed_password, "mustResetPassword": False})
    else:
        user = user_repository.find_by_id(str(account_id))
        if not user:
            _PASSWORD_RESET_TOKENS.pop(token, None)
            raise _not_found("USER_NOT_FOUND")
        user_repository.update({**user, "password": hashed_password, "mustResetPassword": False})

    _PASSWORD_RESET_TOKENS.pop(token, None)
    return {"status": "ok"}


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
