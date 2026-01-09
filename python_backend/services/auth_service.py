from __future__ import annotations

import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

import bcrypt
import html as _html
import jwt
import requests

from ..repositories import user_repository, sales_rep_repository
from ..utils import http_client
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

def _new_session_id() -> str:
    return secrets.token_urlsafe(24)


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

        new_session_id = _new_session_id()
        updated = user_repository.update(
            {
                **user,
                "visits": int(user.get("visits") or 1) + 1,
                "lastLoginAt": datetime.now(timezone.utc).isoformat(),
                "isOnline": True,
                "mustResetPassword": False,
                "sessionId": new_session_id,
            }
        ) or user

        token_role = (updated.get("role") or "doctor").lower()
        token = _create_auth_token(
            {"id": updated["id"], "email": updated["email"], "role": token_role, "sid": updated.get("sessionId")}
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
            "lastLoginAt": datetime.now(timezone.utc).isoformat(),
            "mustResetPassword": False,
            "sessionId": new_session_id,
        }
    ) or sales_rep

    token = _create_auth_token(
        {"id": updated_rep["id"], "email": updated_rep.get("email"), "role": "sales_rep", "sid": updated_rep.get("sessionId")}
    )
    return {"token": token, "user": _sanitize_sales_rep(updated_rep)}


def logout(user_id: str, role: Optional[str] = None) -> Dict:
    normalized_role = (role or "").strip().lower()
    new_session_id = _new_session_id()

    if normalized_role == "sales_rep":
        rep = sales_rep_repository.find_by_id(user_id) if user_id else None
        if rep:
            sales_rep_repository.update({**rep, "sessionId": new_session_id})
        user = user_repository.find_by_id(user_id) if user_id else None
        if user:
            user_repository.update({**user, "isOnline": False, "sessionId": new_session_id})
        return {"ok": True}

    user = user_repository.find_by_id(user_id) if user_id else None
    if user:
        user_repository.update({**user, "isOnline": False, "sessionId": new_session_id})
        return {"ok": True}

    rep = sales_rep_repository.find_by_id(user_id) if user_id else None
    if rep:
        sales_rep_repository.update({**rep, "sessionId": new_session_id})
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


def request_password_reset(email: Optional[str]) -> Dict:
    normalized = _normalize_email(email or "")
    if not normalized:
        raise _bad_request("EMAIL_REQUIRED")

    # Prefer WooCommerce / WordPress native reset emails (customer accounts) when configured.
    if _dispatch_woo_password_reset(normalized):
        response: Dict[str, Any] = {"status": "ok"}
        if not get_config().is_production:
            response["debug"] = {"mode": "woo"}
        return response

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
        new_session_id = _new_session_id()
        sales_rep_repository.update(
            {**rep, "password": hashed_password, "mustResetPassword": False, "sessionId": new_session_id}
        )
        legacy_id = rep.get("legacyUserId")
        if legacy_id:
            linked_user = user_repository.find_by_id(str(legacy_id))
            if linked_user:
                user_repository.update(
                    {**linked_user, "password": hashed_password, "mustResetPassword": False, "sessionId": new_session_id}
                )
    else:
        user = user_repository.find_by_id(str(account_id))
        if not user:
            _PASSWORD_RESET_TOKENS.pop(token, None)
            raise _not_found("USER_NOT_FOUND")
        user_repository.update(
            {**user, "password": hashed_password, "mustResetPassword": False, "sessionId": _new_session_id()}
        )

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
