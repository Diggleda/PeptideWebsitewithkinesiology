from __future__ import annotations

import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

import bcrypt
import html as _html
import jwt
import requests

from ..repositories import password_reset_token_repository, sales_rep_repository, user_repository
from ..repositories import sales_prospect_repository
from ..repositories import referral_repository
from ..utils import http_client
from . import email_service, get_config, npi_service, referral_service, presence_service


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
    base = (config.password_reset_public_base_url or config.frontend_base_url or "http://localhost:3000").rstrip("/")
    return f"{base}/reset-password?token={token}"


def _create_auth_token(payload: Dict) -> str:
    config = get_config()
    now = datetime.now(timezone.utc)
    claims = {
        **payload,
        "exp": now + timedelta(hours=24),
        "iat": now,
    }
    return jwt.encode(claims, config.jwt_secret, algorithm="HS256")


_CODE_PATTERN = re.compile(r"^[A-Z]{2}[A-Z0-9]{3}$")
_BCRYPT_PREFIX = re.compile(r"^\$2[abxy]\$")

logger = logging.getLogger(__name__)
audit_logger = logging.getLogger("peppro.auth_audit")
_PASSWORD_RESET_TOKENS: Dict[str, Dict[str, Any]] = {}

def _audit_enabled() -> bool:
    return str(os.environ.get("AUTH_AUDIT_LOGS") or "").strip().lower() in ("1", "true", "yes", "on")

def _audit(event: str, details: Dict[str, Any]) -> None:
    if not _audit_enabled():
        return
    payload = {"event": event, **(details or {})}
    try:
        audit_logger.info("auth_audit %s", payload)
    except Exception:
        # Never break auth flows due to logging.
        pass

def _new_session_id() -> str:
    return secrets.token_urlsafe(24)

def _is_multi_session_exempt(email: Optional[str]) -> bool:
    # Shared demo account: allow concurrent sessions across devices/users.
    # This disables single-session enforcement (session id rotation) for this one email.
    return (email or "").strip().lower() == "test@doctor.com"


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

    # Referral codes are typically sales-rep codes and are intentionally reusable
    # across multiple doctors (commission attribution). "Onboarding" codes (if
    # configured) may be one-time use.
    sales_rep = sales_rep_repository.find_by_sales_code(code)
    onboarding_record = None

    if not sales_rep:
        onboarding_record = referral_service.get_onboarding_code(code)
        if not onboarding_record:
            raise _not_found("REFERRAL_CODE_NOT_FOUND")
        if onboarding_record.get("status") != "available":
            raise _conflict("REFERRAL_CODE_UNAVAILABLE")

    hashed_password = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

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
            "lastSeenAt": now,
            "lastInteractionAt": now,
            "isOnline": True,
            "mustResetPassword": False,
            "npiNumber": normalized_npi,
            "npiLastVerifiedAt": npi_last_verified_at,
            "npiVerification": npi_verification,
            "npiStatus": npi_status,
            "npiCheckError": None,
            "sessionId": _new_session_id(),
        }
    )

    # Lock lead type once so commission tracking is stable.
    try:
        updated = referral_service.backfill_lead_types_for_doctors([user])
        if updated and isinstance(updated, list) and updated[0]:
            user = updated[0]
    except Exception:
        pass

    if onboarding_record:
        referral_service.redeem_onboarding_code({"code": code, "doctorId": user["id"]})

    token_role = (user.get("role") or "doctor").lower()
    token = _create_auth_token(
        {"id": user["id"], "email": user["email"], "role": token_role, "sid": user.get("sessionId")}
    )

    _audit(
        "REGISTER_SUCCESS",
        {
            "userId": user.get("id"),
            "role": token_role,
            "email": user.get("email"),
            "salesRepId": user.get("salesRepId"),
            "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
    )

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
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    user_record = user_repository.find_by_email(email)
    if user_record:
        new_session_id = _new_session_id()
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
                "lastSeenAt": now,
                "lastInteractionAt": now,
                "isOnline": True,
                "mustResetPassword": False,
                "sessionId": new_session_id,
            }
        )
        user_record = updated_user or user_record
    else:
        new_session_id = _new_session_id()
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
                "lastSeenAt": now,
                "lastInteractionAt": now,
                "isOnline": True,
                "mustResetPassword": False,
                "sessionId": new_session_id,
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
        "sessionId": new_session_id,
    }

    updated_sales_rep = sales_rep_repository.update(sales_rep_update)
    if not updated_sales_rep:
        updated_sales_rep = sales_rep_repository.insert(sales_rep_update)

    if updated_sales_rep.get("legacyUserId") != user_record.get("id"):
        updated_sales_rep = sales_rep_repository.update(
            {**updated_sales_rep, "legacyUserId": user_record.get("id")}
        ) or updated_sales_rep

    token = _create_auth_token(
        {
            "id": updated_sales_rep["id"],
            "email": updated_sales_rep.get("email"),
            "role": "sales_rep",
            "sid": updated_sales_rep.get("sessionId"),
        }
    )

    _audit(
        "REGISTER_SALES_REP_SUCCESS",
        {
            "salesRepId": updated_sales_rep.get("id"),
            "legacyUserId": updated_sales_rep.get("legacyUserId"),
            "email": updated_sales_rep.get("email"),
            "role": "sales_rep",
            "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
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

        # Rotate session id to invalidate other devices/sessions. For the shared demo
        # account, keep the existing session id so multiple reps can stay logged in.
        new_session_id = (
            user.get("sessionId") if _is_multi_session_exempt(user.get("email")) else _new_session_id()
        )
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        updated = user_repository.update(
            {
                **user,
                "visits": int(user.get("visits") or 1) + 1,
                "lastLoginAt": now_iso,
                "lastSeenAt": now_iso,
                "lastInteractionAt": now_iso,
                "isOnline": True,
                "mustResetPassword": False,
                "sessionId": new_session_id,
            }
        ) or user

        token_role = (updated.get("role") or "doctor").lower()
        token = _create_auth_token(
            {"id": updated["id"], "email": updated["email"], "role": token_role, "sid": updated.get("sessionId")}
        )
        _audit(
            "LOGIN_SUCCESS",
            {
                "userId": updated.get("id"),
                "role": token_role,
                "email": updated.get("email"),
                "sessionId": updated.get("sessionId"),
                "isOnline": bool(updated.get("isOnline")),
                "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            },
        )
        return {"token": token, "user": _sanitize_user(updated)}

    sales_rep = sales_rep_repository.find_by_email(email)
    if not sales_rep:
        raise _not_found("EMAIL_NOT_FOUND")

    hashed_password = (sales_rep.get("password") or "").strip()
    if not hashed_password:
        raise _conflict("SALES_REP_ACCOUNT_REQUIRED")

    if not _safe_check_password(password, hashed_password):
        raise _unauthorized("INVALID_PASSWORD")

    new_session_id = _new_session_id()
    updated_rep = sales_rep_repository.update(
        {
            **sales_rep,
            "visits": int(sales_rep.get("visits") or 1) + 1,
            "lastLoginAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "mustResetPassword": False,
            "sessionId": new_session_id,
        }
    ) or sales_rep

    token = _create_auth_token(
        {"id": updated_rep["id"], "email": updated_rep.get("email"), "role": "sales_rep", "sid": updated_rep.get("sessionId")}
    )
    _audit(
        "LOGIN_SALES_REP_SUCCESS",
        {
            "salesRepId": updated_rep.get("id"),
            "role": "sales_rep",
            "email": updated_rep.get("email"),
            "sessionId": updated_rep.get("sessionId"),
            "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        },
    )
    return {"token": token, "user": _sanitize_sales_rep(updated_rep)}


def logout(user_id: str, role: Optional[str] = None) -> Dict:
    normalized_role = (role or "").strip().lower()
    new_session_id = _new_session_id()
    now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    if normalized_role == "sales_rep":
        rep = sales_rep_repository.find_by_id(user_id) if user_id else None
        if rep:
            sales_rep_repository.update({**rep, "sessionId": new_session_id})
        user = user_repository.find_by_id(user_id) if user_id else None
        if user:
            user_repository.update(
                {
                    **user,
                    "isOnline": False,
                    "isIdle": False,
                    "lastSeenAt": now_iso,
                    "sessionId": new_session_id,
                }
            )
        _audit(
            "LOGOUT",
            {
                "userId": user_id,
                "role": normalized_role,
                "updatedUser": bool(user),
                "updatedSalesRep": bool(rep),
                "newSessionId": new_session_id,
                "at": now_iso,
            },
        )
        return {"ok": True}

    user = user_repository.find_by_id(user_id) if user_id else None
    if user:
        if _is_multi_session_exempt(user.get("email")):
            # Do not rotate session id or mark offline for the shared demo account;
            # one user's logout should not boot other demos.
            try:
                # Still mark offline for UI presence; another active session will
                # immediately flip it back via `/settings/presence` heartbeats.
                user_repository.update({**user, "isOnline": False, "isIdle": False, "lastSeenAt": now_iso})
            except Exception:
                pass
            _audit(
                "LOGOUT",
                {
                    "userId": user_id,
                    "role": normalized_role or (user.get("role") if isinstance(user, dict) else None),
                    "updatedUser": True,
                    "skippedReason": "MULTI_SESSION_EXEMPT",
                    "at": now_iso,
                },
            )
            return {"ok": True}
        user_repository.update(
            {
                **user,
                "isOnline": False,
                "isIdle": False,
                "lastSeenAt": now_iso,
                "sessionId": new_session_id,
            }
        )
        _audit(
            "LOGOUT",
            {
                "userId": user_id,
                "role": normalized_role or (user.get("role") if isinstance(user, dict) else None),
                "updatedUser": True,
                "newSessionId": new_session_id,
                "at": now_iso,
            },
        )
        return {"ok": True}

    rep = sales_rep_repository.find_by_id(user_id) if user_id else None
    if rep:
        sales_rep_repository.update(
            {
                **rep,
                "sessionId": new_session_id,
            }
        )
        _audit(
            "LOGOUT",
            {
                "userId": user_id,
                "role": normalized_role or "sales_rep",
                "updatedSalesRep": True,
                "newSessionId": new_session_id,
                "at": now_iso,
            },
        )
    return {"ok": True}


def check_email(email: str) -> Dict:
    normalized = _normalize_email(email)
    if not normalized:
        raise _bad_request("EMAIL_REQUIRED")
    exists = user_repository.find_by_email(normalized) is not None or sales_rep_repository.find_by_email(normalized) is not None
    return {"exists": exists}


def get_profile(user_id: str, role: Optional[str] = None) -> Dict:
    user = user_repository.find_by_id(user_id)
    if user:
        return _sanitize_user(user)

    normalized_role = (role or "").strip().lower()
    if normalized_role == "sales_rep":
        rep = sales_rep_repository.find_by_id(user_id)
        if rep:
            return _sanitize_sales_rep(rep)

    raise _not_found("User not found")


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
    shipping_fields = {
        "officeAddressLine1": data.get("officeAddressLine1") or user.get("officeAddressLine1"),
        "officeAddressLine2": data.get("officeAddressLine2") or user.get("officeAddressLine2"),
        "officeCity": data.get("officeCity") or user.get("officeCity"),
        "officeState": data.get("officeState") or user.get("officeState"),
        "officePostalCode": data.get("officePostalCode") or user.get("officePostalCode"),
        "officeCountry": data.get("officeCountry") or user.get("officeCountry"),
    }

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
        **shipping_fields,
    }

    logger.info(
        "Profile update requested (includes profile image) %s",
        {
            "userId": user_id,
            "hasProfileImage": bool(profile_image_url),
            "profileImageBytes": len(profile_image_url.encode("utf-8")) if isinstance(profile_image_url, str) else 0,
        },
    )

    saved = user_repository.update(updated) or updated
    try:
        role = (saved.get("role") or "").strip().lower()
        if role in ("doctor", "test_doctor"):
            sales_prospect_repository.sync_contact_for_doctor(
                doctor_id=str(saved.get("id") or ""),
                name=saved.get("name"),
                email=saved.get("email"),
                phone=saved.get("phone"),
                previous_email=user.get("email"),
            )
            referral_repository.sync_referred_contact_for_account(
                doctor_id=str(saved.get("id") or ""),
                name=saved.get("name"),
                email=saved.get("email"),
                phone=saved.get("phone"),
                previous_email=user.get("email"),
            )
        if role in ("sales_rep", "rep", "admin"):
            rep = sales_rep_repository.find_by_id(str(saved.get("id") or "")) if saved.get("id") else None
            if not rep and saved.get("email"):
                rep = sales_rep_repository.find_by_email(str(saved.get("email") or ""))
            if rep:
                sales_rep_repository.update(
                    {
                        **rep,
                        "name": saved.get("name") or rep.get("name"),
                        "email": saved.get("email") or rep.get("email"),
                        "phone": saved.get("phone") or rep.get("phone"),
                    }
                )
    except Exception:
        pass
    logger.info(
        "Profile update saved %s",
        {
            "userId": user_id,
            "hasProfileImage": bool(saved.get("profileImageUrl")),
        },
    )
    return _sanitize_user(saved)


def _sanitize_user(user: Dict) -> Dict:
    sanitized = dict(user)
    sanitized.pop("password", None)
    sanitized.pop("sessionId", None)
    sanitized.pop("downloads", None)
    rep_id = sanitized.get("salesRepId")
    sales_rep = None
    if rep_id:
        sales_rep = sales_rep_repository.find_by_id(rep_id)
        # Some environments store the sales rep in the main `users` table (role=sales_rep),
        # while doctors reference that id. Fall back to `user_repository` so the UI can
        # render "Representative" contact details reliably.
        if not sales_rep:
            rep_user = user_repository.find_by_id(str(rep_id))
            if rep_user and (rep_user.get("role") or "").lower() in ("sales_rep", "rep", "admin"):
                sales_rep = rep_user
    else:
        role = (sanitized.get("role") or "").lower()
        if role in ("admin", "sales_rep"):
            email = sanitized.get("email") or ""
            sales_rep = sales_rep_repository.find_by_email(email) if email else None
            if not sales_rep:
                sales_rep = sales_rep_repository.find_by_id(sanitized.get("id"))
            if sales_rep and not rep_id:
                sanitized["salesRepId"] = sales_rep.get("id") or sanitized.get("salesRepId")
    if sales_rep:
        sanitized["salesRep"] = {
            "id": sales_rep.get("id"),
            "name": sales_rep.get("name"),
            "email": sales_rep.get("email"),
            "phone": sales_rep.get("phone"),
        }
        if not sanitized.get("referralCode"):
            sales_code = sales_rep.get("salesCode")
            if sales_code:
                sanitized["referralCode"] = sales_code
    else:
        sanitized["salesRep"] = None

    # Presence: derive `isOnline` from recent heartbeats/lastSeenAt so it doesn't stick forever.
    # Keep the persisted `users.is_online` as a gate so explicit logout still forces offline.
    try:
        user_id = str(sanitized.get("id") or "").strip()
        if user_id:
            online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
            online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
            now_epoch = time.time()

            presence_entry = None
            try:
                presence_entry = presence_service.snapshot().get(user_id)
            except Exception:
                presence_entry = None

            last_seen_epoch = None
            if isinstance(presence_entry, dict):
                raw_seen = presence_entry.get("lastHeartbeatAt")
                if isinstance(raw_seen, (int, float)) and float(raw_seen) > 0:
                    last_seen_epoch = float(raw_seen)
                presence_public = presence_service.to_public_fields(presence_entry)
                if presence_public.get("lastSeenAt"):
                    sanitized["lastSeenAt"] = presence_public.get("lastSeenAt")
                if presence_public.get("lastInteractionAt"):
                    sanitized["lastInteractionAt"] = presence_public.get("lastInteractionAt")
            if last_seen_epoch is None:
                last_seen_epoch = _parse_utc_epoch(sanitized.get("lastSeenAt") or user.get("lastSeenAt"))

            stored_is_online = bool(user.get("isOnline"))
            sanitized["isOnline"] = bool(
                stored_is_online
                and presence_service.is_recent_epoch(
                    last_seen_epoch,
                    now_epoch=now_epoch,
                    threshold_s=online_threshold_s,
                )
            )
    except Exception:
        pass
    return sanitized


def _sanitize_sales_rep(rep: Dict) -> Dict:
    sanitized = dict(rep)
    sanitized.pop("password", None)
    sanitized.pop("sessionId", None)
    sanitized.setdefault("role", "sales_rep")
    sanitized.setdefault("salesRepId", sanitized.get("id"))
    sanitized.setdefault("salesRep", None)
    if sanitized.get("salesCode") and not sanitized.get("referralCode"):
        sanitized["referralCode"] = sanitized.get("salesCode")
    return sanitized


def _parse_utc_epoch(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            seconds = float(value)
        except Exception:
            return None
        if seconds > 10_000_000_000:
            seconds = seconds / 1000.0
        return seconds if seconds > 0 else None
    if isinstance(value, datetime):
        dt = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return float(dt.astimezone(timezone.utc).timestamp())
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        normalized = text.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return float(parsed.astimezone(timezone.utc).timestamp())
        except Exception:
            # Support MySQL DATETIME ("YYYY-MM-DD HH:MM:SS") and other common variants.
            try:
                candidate = text.replace("T", " ").replace("Z", "")
                parsed = datetime.strptime(candidate[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                return float(parsed.timestamp())
            except Exception:
                return None
    return None


def _dispatch_woo_password_reset(email: str) -> bool:
    """
    Trigger WordPress/WooCommerce's native password reset email.

    This avoids relying on PepPro's email transport for customer accounts.
    """
    config = get_config()
    store_url = (config.woo_commerce or {}).get("store_url") or ""
    store_url = str(store_url).strip()
    if not store_url:
        if (config.woo_commerce or {}).get("consumer_key"):
            logger.warning(
                "Woo password reset requested but WC_STORE_URL is not configured; falling back to PepPro email",
                extra={"email": email},
            )
        return False

    url = f"{store_url.rstrip('/')}/wp-login.php?action=lostpassword"
    headers = {
        "User-Agent": "PepPro-API/1.0 (+https://peppro.net)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }

    try:
        session = requests.Session()
        get_response = http_client.request_with_session(
            session,
            "GET",
            url,
            headers=headers,
            allow_redirects=True,
            timeout=(3.5, 8.0),
        )
    except Exception as exc:
        logger.warning("Woo password reset request failed", exc_info=exc, extra={"email": email})
        return False

    if get_response.status_code >= 500:
        logger.warning(
            "Woo password reset returned server error (GET form)",
            extra={"status": get_response.status_code, "email": email},
        )
        return False
    if get_response.status_code >= 400:
        logger.warning(
            "Woo password reset returned client error (GET form)",
            extra={"status": get_response.status_code, "email": email},
        )
        return False

    html = str(getattr(get_response, "text", "") or "")
    lowered_html = html.lower()

    def _parse_hidden_inputs(page_html: str) -> Dict[str, str]:
        hidden: Dict[str, str] = {}
        for tag_match in re.finditer(r"<input[^>]*>", page_html, re.I):
            tag = tag_match.group(0)
            if not re.search(r'\btype=["\\\']hidden["\\\']', tag, re.I):
                continue
            name_match = re.search(r'\bname=["\\\']([^"\\\']+)["\\\']', tag, re.I)
            if not name_match:
                continue
            value_match = re.search(r'\bvalue=["\\\']([^"\\\']*)["\\\']', tag, re.I)
            name = name_match.group(1)
            value = _html.unescape(value_match.group(1)) if value_match else ""
            hidden[name] = value
        return hidden

    hidden_inputs = _parse_hidden_inputs(html)
    # Some WP installs (or plugins/themes) use different names for the nonce field.
    # Prefer the canonical `_wpnonce`, but accept any `*nonce*` hidden field.
    nonce_value = hidden_inputs.get("_wpnonce", "")
    if not nonce_value:
        for key, value in hidden_inputs.items():
            if "nonce" in key.lower() and value:
                nonce_value = value
                break

    http_referer = hidden_inputs.get("_wp_http_referer", "")

    if "<form" not in lowered_html:
        logger.warning(
            "Woo password reset form not detected; falling back to PepPro email",
            extra={
                "email": email,
                "status": get_response.status_code,
                "htmlHint": lowered_html[:120],
            },
        )
        return False

    post_data: Dict[str, str] = dict(hidden_inputs)
    post_data["user_login"] = email
    post_data.setdefault("redirect_to", "")
    post_data.setdefault("wp-submit", "Get New Password")
    if nonce_value and "_wpnonce" not in post_data:
        # If a nonce exists but isn't named `_wpnonce`, we already included it via hidden inputs.
        # If a plugin/theme expects `_wpnonce` specifically, provide it as well.
        post_data["_wpnonce"] = nonce_value
    if http_referer:
        post_data["_wp_http_referer"] = http_referer

    try:
        response = http_client.request_with_session(
            session,
            "POST",
            url,
            data=post_data,
            headers={**headers, "Referer": url},
            allow_redirects=True,
            timeout=(3.5, 12.0),
        )
    except Exception as exc:
        logger.warning("Woo password reset request failed (POST form)", exc_info=exc, extra={"email": email})
        return False

    final_url = str(getattr(response, "url", "") or "")
    body = str(getattr(response, "text", "") or "")

    if response.status_code >= 500:
        logger.warning(
            "Woo password reset returned server error",
            extra={"status": response.status_code, "email": email},
        )
        return False
    if response.status_code >= 400:
        logger.warning(
            "Woo password reset returned client error",
            extra={"status": response.status_code, "email": email},
        )
        return False

    lowered = body.lower()
    if "invalid username" in lowered or "invalid email" in lowered or "unknown email" in lowered:
        # WP does not reveal whether an account exists, but some themes/plugins do; don't treat this as success.
        logger.warning(
            "Woo password reset returned an error response; falling back to PepPro email",
            extra={"status": response.status_code, "email": email, "finalUrl": final_url[:250]},
        )
        return False

    # WordPress typically redirects to `checkemail=confirm`. If we don't see that (or a similar
    # confirmation hint), assume the request didn't actually trigger the email (e.g. security
    # plugins / WAF / captcha / nonces) and fall back to PepPro email.
    looks_confirmed = ("checkemail=confirm" in final_url) or ("checkemail=confirm" in lowered)
    if not looks_confirmed:
        logger.warning(
            "Woo password reset response did not look confirmed; falling back to PepPro email",
            extra={"status": response.status_code, "email": email, "finalUrl": final_url[:250]},
        )
        return False

    logger.info("Woo password reset dispatched", extra={"email": email, "finalUrl": final_url[:250]})
    return True


def _dispatch_woo_mailer_password_reset(email: str, reset_url: str, display_name: str = "") -> bool:
    """
    Send a PepPro password reset email using WooCommerce/WordPress's mail system via a small bridge plugin.

    This supports PepPro-only accounts (not necessarily WordPress/Woo customers) and avoids scraping
    `wp-login.php?action=lostpassword`, which can be blocked by WAF/Cloudflare challenges.
    """
    config = get_config()
    woo_cfg = (config.woo_commerce or {}) if isinstance(config.woo_commerce, dict) else {}

    mailer_url = str(woo_cfg.get("mailer_url") or "").strip()
    mailer_secret = str(woo_cfg.get("mailer_secret") or "").strip()

    if not mailer_url or not mailer_secret:
        logger.warning(
            "Woo mailer not configured; falling back to PepPro email",
            extra={"hasUrl": bool(mailer_url), "hasSecret": bool(mailer_secret), "email": email},
        )
        return False

    payload: Dict[str, str] = {"email": email, "resetUrl": reset_url}
    safe_name = _sanitize_name(display_name)
    if safe_name:
        payload["displayName"] = safe_name

    headers = {
        "User-Agent": "PepPro-API/1.0 (+https://peppro.net)",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-PEPPR-SECRET": mailer_secret,
    }

    try:
        response = http_client.post(
            mailer_url,
            json=payload,
            headers=headers,
            # The WP/Woo mail system can take >8s under load (plugins, SMTP, Cloudflare, etc).
            # Keep connect timeout tight, but allow more time for the response so we don't log false failures.
            timeout=(3.5, 25.0),
        )
    except Exception as exc:
        logger.warning("Woo mailer password reset request failed", exc_info=exc, extra={"email": email})
        return False

    if response.status_code >= 500:
        logger.warning(
            "Woo mailer password reset returned server error",
            extra={
                "status": response.status_code,
                "contentType": response.headers.get("Content-Type", ""),
                "email": email,
            },
        )
        return False
    if response.status_code >= 400:
        logger.warning(
            "Woo mailer password reset returned client error",
            extra={
                "status": response.status_code,
                "contentType": response.headers.get("Content-Type", ""),
                "email": email,
            },
        )
        return False

    try:
        data = response.json() if response.content else {}
    except Exception:
        data = {}

    ok = bool(isinstance(data, dict) and (data.get("ok") is True or data.get("status") == "ok"))
    if not ok:
        body_snippet = ""
        try:
            body_snippet = (response.text or "")[:250]
        except Exception:
            body_snippet = ""

        logger.warning(
            "Woo mailer password reset response did not look confirmed",
            extra={
                "status": response.status_code,
                "contentType": response.headers.get("Content-Type", ""),
                "email": email,
                "body": str(data)[:250],
                "bodyText": body_snippet,
            },
        )
        return False

    logger.info("Woo mailer password reset dispatched", extra={"email": email})
    return True


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

    config = get_config()
    token = ""
    reset_url = ""

    if config.mysql.get("enabled") and account_id:
        token = password_reset_token_repository.create_token(
            account_type=account_type,
            account_id=str(account_id),
            recipient_email=recipient,
        )
        reset_url = _build_reset_url(token)
    else:
        token = secrets.token_hex(32)
        expires = datetime.now(timezone.utc) + timedelta(hours=1)
        _PASSWORD_RESET_TOKENS[token] = {
            "account_type": account_type,
            "account_id": account_id,
            "expires": expires,
        }
        reset_url = _build_reset_url(token)

    # Prefer Woo/WordPress mailer (via plugin endpoint) so PepPro-only users still get emails
    # from the same system as WooCommerce.
    display_name = str(account.get("name") or "") if account else ""
    if not _dispatch_woo_mailer_password_reset(recipient, reset_url, display_name):
        if not config.password_reset_fallback_email_enabled:
            logger.warning(
                "Woo mailer password reset failed; fallback email disabled",
                extra={"email": recipient},
            )
        else:
            try:
                email_service.send_password_reset_email(recipient, reset_url)
            except Exception as exc:  # pragma: no cover - email transport failures should not break flow
                logger.warning("Failed to dispatch password reset email", exc_info=exc)

    response: Dict[str, Any] = {"status": "ok"}
    if (not config.is_production) and bool(getattr(config, "password_reset_debug_response_enabled", False)):
        response["debug"] = {"token": token, "resetUrl": reset_url}
    return response


def reset_password(data: Dict) -> Dict:
    token = (data.get("token") or "").strip()
    password = (data.get("password") or "").strip()
    if not token or not password:
        raise _bad_request("TOKEN_AND_PASSWORD_REQUIRED")

    config = get_config()
    token_details: Optional[Dict[str, Any]] = None

    if config.mysql.get("enabled"):
        token_details = password_reset_token_repository.get_valid_token(token)
        if not token_details:
            raise _bad_request("TOKEN_INVALID")
    else:
        token_details = _PASSWORD_RESET_TOKENS.get(token)
        if not token_details or token_details.get("expires") < datetime.now(timezone.utc):
            raise _bad_request("TOKEN_INVALID")

    hashed_password = bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    account_type = token_details.get("account_type")
    account_id = token_details.get("account_id")

    try:
        if account_type == "sales_rep":
            rep = sales_rep_repository.find_by_id(str(account_id))
            if not rep:
                raise _not_found("USER_NOT_FOUND")
            new_session_id = _new_session_id()
            sales_rep_repository.update(
                {**rep, "password": hashed_password, "mustResetPassword": False, "sessionId": new_session_id}
            )
            legacy_id = rep.get("legacyUserId")
            if legacy_id:
                linked_user = user_repository.find_by_id(str(legacy_id))
                if linked_user:
                    user_repository.update(
                        {
                            **linked_user,
                            "password": hashed_password,
                            "mustResetPassword": False,
                            "sessionId": new_session_id,
                        }
                    )
        else:
            user = user_repository.find_by_id(str(account_id))
            if not user:
                raise _not_found("USER_NOT_FOUND")
            user_repository.update(
                {**user, "password": hashed_password, "mustResetPassword": False, "sessionId": _new_session_id()}
            )
    finally:
        if config.mysql.get("enabled"):
            try:
                password_reset_token_repository.consume_token(token)
            except Exception as exc:
                logger.warning("Failed to consume password reset token", exc_info=exc)
        else:
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
