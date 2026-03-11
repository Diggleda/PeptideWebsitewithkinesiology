from __future__ import annotations

import json
import re
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


def _normalize_npi(value: Optional[str]) -> str:
    return re.sub(r"[^0-9]", "", str(value or ""))[:10]


def _normalize_identifier(value: Optional[str]) -> Optional[str]:
    text = str(value or "").strip()
    return text or None


def _normalize_bool(value) -> bool:
    if value is True or value is False:
        return value
    if isinstance(value, (int, float)):
        try:
            return float(value) != 0.0
        except Exception:
            return False
    text = str(value or "").strip().lower()
    return text in ("1", "true", "yes", "y", "on")


def _normalize_cart_items(value) -> List[Dict]:
    if not isinstance(value, list):
        return []
    normalized: List[Dict] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        product_id = str(item.get("productId") or "").strip()
        try:
            quantity = max(1, int(float(item.get("quantity") or 0) or 0))
        except Exception:
            quantity = 1
        if not product_id or quantity <= 0:
            continue
        product_woo_id = item.get("productWooId")
        variant_woo_id = item.get("variantWooId")
        try:
            normalized_product_woo_id = int(float(product_woo_id)) if product_woo_id is not None else None
        except Exception:
            normalized_product_woo_id = None
        try:
            normalized_variant_woo_id = int(float(variant_woo_id)) if variant_woo_id is not None else None
        except Exception:
            normalized_variant_woo_id = None
        normalized.append(
            {
                "productId": product_id,
                "productWooId": normalized_product_woo_id,
                "variantId": _normalize_identifier(item.get("variantId")),
                "variantWooId": normalized_variant_woo_id,
                "quantity": quantity,
                "note": _normalize_identifier(item.get("note")),
            }
        )
    return normalized


def _ensure_defaults(user: Dict) -> Dict:
    normalized = dict(user)
    normalized.setdefault("role", "doctor")
    normalized.setdefault("status", "active")
    normalized.setdefault("isOnline", bool(normalized.get("isOnline", False)))
    normalized.setdefault("sessionId", normalized.get("sessionId") or None)
    normalized.setdefault("lastSeenAt", normalized.get("lastSeenAt") or None)
    normalized.setdefault("lastInteractionAt", normalized.get("lastInteractionAt") or None)
    normalized.setdefault("salesRepId", None)
    normalized.setdefault("referrerDoctorId", None)
    normalized["leadType"] = (normalized.get("leadType") or None)
    normalized["leadTypeSource"] = (normalized.get("leadTypeSource") or None)
    normalized["leadTypeLockedAt"] = (normalized.get("leadTypeLockedAt") or None)
    normalized.setdefault("phone", None)
    normalized["officeAddressLine1"] = (normalized.get("officeAddressLine1") or None)
    normalized["officeAddressLine2"] = (normalized.get("officeAddressLine2") or None)
    normalized["officeCity"] = (normalized.get("officeCity") or None)
    normalized["officeState"] = (normalized.get("officeState") or None)
    normalized["officePostalCode"] = (normalized.get("officePostalCode") or None)
    normalized["officeCountry"] = (normalized.get("officeCountry") or None)
    normalized.setdefault("profileImageUrl", None)
    normalized.setdefault("delegateLogoUrl", normalized.get("delegateLogoUrl") or None)
    normalized.setdefault("zelleContact", normalized.get("zelleContact") or None)
    cart = normalized.get("cart")
    if isinstance(cart, str):
        try:
            cart = json.loads(cart)
        except json.JSONDecodeError:
            cart = None
    normalized["cart"] = _normalize_cart_items(cart)
    downloads = normalized.get("downloads")
    if isinstance(downloads, str):
        try:
            downloads = json.loads(downloads)
        except json.JSONDecodeError:
            downloads = None
    if downloads is None:
        downloads = []
    if not isinstance(downloads, list):
        downloads = []
    normalized["downloads"] = downloads
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
    try:
        normalized["markupPercent"] = float(normalized.get("markupPercent") or 0.0)
    except Exception:
        normalized["markupPercent"] = 0.0
    npi_number = _normalize_npi(normalized.get("npiNumber"))
    normalized["npiNumber"] = npi_number or None
    normalized.setdefault("npiLastVerifiedAt", normalized.get("npiLastVerifiedAt") or None)
    normalized.setdefault("npiStatus", normalized.get("npiStatus") or None)
    normalized.setdefault("npiCheckError", normalized.get("npiCheckError") or None)
    verification = normalized.get("npiVerification")
    if isinstance(verification, str):
        try:
            verification = json.loads(verification)
        except json.JSONDecodeError:
            verification = None
    if verification is not None and not isinstance(verification, dict):
        verification = None
    normalized["npiVerification"] = verification
    if "devCommission" in normalized:
        normalized["devCommission"] = _normalize_bool(normalized.get("devCommission"))
    else:
        normalized["devCommission"] = _normalize_bool(normalized.get("dev_commission"))
    if "receiveClientOrderUpdateEmails" in normalized:
        normalized["receiveClientOrderUpdateEmails"] = _normalize_bool(
            normalized.get("receiveClientOrderUpdateEmails")
        )
    else:
        normalized["receiveClientOrderUpdateEmails"] = _normalize_bool(
            normalized.get("receive_client_order_update_emails")
        )
    if "handDelivered" in normalized:
        normalized["handDelivered"] = _normalize_bool(normalized.get("handDelivered"))
    else:
        normalized["handDelivered"] = _normalize_bool(normalized.get("hand_delivered"))
    normalized["hand_delivered"] = 1 if normalized.get("handDelivered") else 0
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


def list_sales_tracking_users_for_admin() -> List[Dict]:
    """
    Lightweight projection for admin sales tracking.

    This avoids loading heavyweight fields like password/cart/download payloads when the
    dashboard only needs identity, attribution, and display metadata.
    """
    if not _using_mysql():
        return [
            user
            for user in _load()
            if str(user.get("role") or "").strip().lower() in ("doctor", "test_doctor", "sales_rep", "rep")
        ]

    rows = mysql_client.fetch_all(
        """
        SELECT
            id,
            name,
            email,
            role,
            status,
            sales_rep_id,
            referrer_doctor_id,
            lead_type,
            lead_type_source,
            lead_type_locked_at,
            phone,
            office_address_line1,
            office_address_line2,
            office_city,
            office_state,
            office_postal_code,
            office_country,
            profile_image_url
        FROM users
        WHERE LOWER(COALESCE(role, '')) IN ('doctor', 'test_doctor', 'sales_rep', 'rep')
        """
    )
    return [_row_to_user(row) for row in rows or []]


def list_recent_users_since(cutoff: datetime) -> List[Dict]:
    """
    Lightweight user activity projection used by admin dashboards.
    Returns users that are either currently online or have lastLoginAt >= cutoff and includes
    only fields needed for activity reporting.
    """
    if _using_mysql():
        cutoff_sql = cutoff.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        rows = mysql_client.fetch_all(
            """
            SELECT id, name, email, role, is_online, session_id, last_login_at, last_seen_at, last_interaction_at, profile_image_url
            FROM users
            WHERE is_online = 1
               OR (last_login_at IS NOT NULL AND last_login_at >= %(cutoff)s)
            """,
            {"cutoff": cutoff_sql},
        )
        result: List[Dict] = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            last_login_at = row.get("last_login_at")
            last_login_iso = None
            if isinstance(last_login_at, datetime):
                dt = last_login_at if last_login_at.tzinfo else last_login_at.replace(tzinfo=timezone.utc)
                last_login_iso = dt.astimezone(timezone.utc).isoformat()
            elif isinstance(last_login_at, str) and last_login_at.strip():
                last_login_iso = last_login_at.strip()
            last_seen_at = row.get("last_seen_at")
            last_seen_iso = None
            if isinstance(last_seen_at, datetime):
                dt = last_seen_at if last_seen_at.tzinfo else last_seen_at.replace(tzinfo=timezone.utc)
                last_seen_iso = dt.astimezone(timezone.utc).isoformat()
            elif isinstance(last_seen_at, str) and last_seen_at.strip():
                last_seen_iso = last_seen_at.strip()
            last_interaction_at = row.get("last_interaction_at")
            last_interaction_iso = None
            if isinstance(last_interaction_at, datetime):
                dt = last_interaction_at if last_interaction_at.tzinfo else last_interaction_at.replace(tzinfo=timezone.utc)
                last_interaction_iso = dt.astimezone(timezone.utc).isoformat()
            elif isinstance(last_interaction_at, str) and last_interaction_at.strip():
                last_interaction_iso = last_interaction_at.strip()
            result.append(
                {
                    "id": row.get("id"),
                    "name": row.get("name") or None,
                    "email": row.get("email") or None,
                    "role": row.get("role") or None,
                    "isOnline": bool(row.get("is_online")),
                    "sessionId": row.get("session_id") or None,
                    "profileImageUrl": row.get("profile_image_url") or None,
                    "lastLoginAt": last_login_iso,
                    "lastSeenAt": last_seen_iso,
                    "lastInteractionAt": last_interaction_iso,
                }
            )
        return result

    # JSON-store fallback.
    result = []
    for user in _load():
        last_login_at = user.get("lastLoginAt") or None
        is_online = bool(user.get("isOnline"))
        if not last_login_at and not is_online:
            continue
        try:
            if last_login_at:
                parsed = datetime.fromisoformat(str(last_login_at).replace("Z", "+00:00"))
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                if parsed.astimezone(timezone.utc) < cutoff.astimezone(timezone.utc) and not is_online:
                    continue
        except Exception:
            if not is_online:
                continue
        result.append(
            {
                "id": user.get("id"),
                "name": user.get("name") or None,
                "email": user.get("email") or None,
                "role": user.get("role") or None,
                "isOnline": is_online,
                "profileImageUrl": user.get("profileImageUrl") or None,
                "lastLoginAt": user.get("lastLoginAt") or None,
                "lastSeenAt": user.get("lastSeenAt") or None,
                "lastInteractionAt": user.get("lastInteractionAt") or None,
            }
        )
    return result


def mark_contact_form_origin_for_email(
    email: str,
    *,
    source: Optional[str] = None,
    locked_at: Optional[str] = None,
) -> Optional[Dict]:
    normalized_email = str(email or "").strip().lower()
    if not normalized_email:
        return None
    user = find_by_email(normalized_email)
    if not user:
        return None
    role = str(user.get("role") or "").strip().lower()
    if role not in ("doctor", "test_doctor"):
        return user
    if str(user.get("referrerDoctorId") or "").strip():
        return user
    existing_lead_type = str(user.get("leadType") or "").strip().lower()
    if existing_lead_type:
        return user
    update_payload = {
        "id": user.get("id"),
        "leadType": "contact_form",
        "leadTypeSource": source or user.get("leadTypeSource") or "contact_form",
        "leadTypeLockedAt": locked_at or user.get("leadTypeLockedAt") or datetime.now(timezone.utc).isoformat(),
    }
    return update(update_payload) or {**user, **update_payload}


def backfill_contact_form_lead_types() -> int:
    if _using_mysql():
        try:
            result = mysql_client.execute(
                """
                UPDATE users u
                JOIN (
                    SELECT LOWER(email) AS email_normalized, MIN(id) AS contact_form_id
                    FROM contact_forms
                    WHERE email IS NOT NULL AND TRIM(email) <> ''
                    GROUP BY LOWER(email)
                ) cf ON LOWER(TRIM(u.email)) = cf.email_normalized
                SET
                    u.lead_type = 'contact_form',
                    u.lead_type_source = CONCAT('contact_form:', cf.contact_form_id),
                    u.lead_type_locked_at = COALESCE(u.lead_type_locked_at, UTC_TIMESTAMP())
                WHERE
                    (u.lead_type IS NULL OR TRIM(u.lead_type) = '')
                    AND LOWER(COALESCE(u.role, '')) IN ('doctor', 'test_doctor')
                    AND (u.referrer_doctor_id IS NULL OR TRIM(u.referrer_doctor_id) = '')
                """
            )
            return int(result or 0)
        except Exception:
            return 0

    try:
        from ..storage import contact_form_store

        forms = contact_form_store.read() if contact_form_store else []
    except Exception:
        forms = []

    first_contact_form_id_by_email: Dict[str, str] = {}
    for idx, row in enumerate(forms or []):
        if not isinstance(row, dict):
            continue
        email = str(row.get("email") or "").strip().lower()
        if not email or email in first_contact_form_id_by_email:
            continue
        record_id = str(row.get("id") or f"contact_form:{idx + 1}").strip()
        first_contact_form_id_by_email[email] = record_id

    updated_count = 0
    for user in get_all():
        if not isinstance(user, dict):
            continue
        role = str(user.get("role") or "").strip().lower()
        if role not in ("doctor", "test_doctor"):
            continue
        if str(user.get("referrerDoctorId") or "").strip():
            continue
        if str(user.get("leadType") or "").strip():
            continue
        email = str(user.get("email") or "").strip().lower()
        source = first_contact_form_id_by_email.get(email)
        if not source:
            continue
        if update(
            {
                "id": user.get("id"),
                "leadType": "contact_form",
                "leadTypeSource": source,
                "leadTypeLockedAt": datetime.now(timezone.utc).isoformat(),
            }
        ):
            updated_count += 1
    return updated_count


def find_by_email(email: str) -> Optional[Dict]:
    email = (email or "").strip()
    if email.lower().startswith("mailto:"):
        email = email.split(":", 1)[-1].strip()
    angle_match = re.search(r"<([^>]+)>", email)
    if angle_match and angle_match.group(1):
        email = angle_match.group(1).strip()
    email = re.sub(r"\s+", "", email).lower()
    if not email or "@" not in email:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one(
            "SELECT * FROM users WHERE LOWER(TRIM(email)) = %(email)s",
            {"email": email},
        )
        return _row_to_user(row)
    return next(
        (
            user
            for user in _load()
            if (user.get("email") or "").strip().lower() == email
        ),
        None,
    )


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
            existing_sales_rep_id = _normalize_identifier(existing.get("salesRepId") or existing.get("sales_rep_id"))
            if existing_sales_rep_id:
                merged["salesRepId"] = existing_sales_rep_id
            users[index] = merged
            _save(users)
            return merged
    return None


def remove_by_id(user_id: str) -> bool:
    target = str(user_id or "").strip()
    if not target:
        return False

    if _using_mysql():
        rows = mysql_client.execute(
            "DELETE FROM users WHERE id = %(id)s",
            {"id": target},
        )
        return int(rows or 0) > 0

    users = _load()
    next_users = [entry for entry in users if str(entry.get("id") or "") != target]
    if len(next_users) == len(users):
        return False
    _save(next_users)
    return True


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
            existing_sales_rep_id = _normalize_identifier(existing.get("salesRepId") or existing.get("sales_rep_id"))
            if existing_sales_rep_id:
                updated["salesRepId"] = existing_sales_rep_id
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
            id, name, email, password, role, status, is_online, sales_rep_id, referrer_doctor_id,
            hand_delivered,
            session_id,
            last_seen_at, last_interaction_at,
            lead_type, lead_type_source, lead_type_locked_at,
            phone, office_address_line1, office_address_line2, office_city, office_state,
            office_postal_code, office_country, profile_image_url, delegate_logo_url, zelle_contact, cart, downloads,
            referral_credits, total_referrals, visits,
            receive_client_order_update_emails,
            markup_percent,
            created_at, last_login_at, must_reset_password, first_order_bonus_granted_at,
            npi_number, npi_last_verified_at, npi_verification, npi_status, npi_check_error
        ) VALUES (
            %(id)s, %(name)s, %(email)s, %(password)s, %(role)s, %(status)s, %(is_online)s, %(sales_rep_id)s,
            %(referrer_doctor_id)s, %(hand_delivered)s, %(session_id)s, %(last_seen_at)s, %(last_interaction_at)s,
            %(lead_type)s, %(lead_type_source)s, %(lead_type_locked_at)s,
            %(phone)s, %(office_address_line1)s, %(office_address_line2)s,
            %(office_city)s, %(office_state)s, %(office_postal_code)s, %(office_country)s,
            %(profile_image_url)s, %(delegate_logo_url)s, %(zelle_contact)s, %(cart)s, %(downloads)s, %(referral_credits)s,
            %(total_referrals)s, %(visits)s, %(receive_client_order_update_emails)s, %(markup_percent)s, %(created_at)s, %(last_login_at)s,
            %(must_reset_password)s, %(first_order_bonus_granted_at)s,
            %(npi_number)s, %(npi_last_verified_at)s, %(npi_verification)s, %(npi_status)s, %(npi_check_error)s
        )
        ON DUPLICATE KEY UPDATE
            name = VALUES(name),
            password = VALUES(password),
            role = VALUES(role),
            status = VALUES(status),
            is_online = VALUES(is_online),
            hand_delivered = VALUES(hand_delivered),
            sales_rep_id = CASE
                WHEN sales_rep_id IS NULL OR TRIM(sales_rep_id) = '' THEN VALUES(sales_rep_id)
                ELSE sales_rep_id
            END,
            referrer_doctor_id = VALUES(referrer_doctor_id),
            session_id = VALUES(session_id),
            last_seen_at = VALUES(last_seen_at),
            last_interaction_at = VALUES(last_interaction_at),
            lead_type = VALUES(lead_type),
            lead_type_source = VALUES(lead_type_source),
            lead_type_locked_at = VALUES(lead_type_locked_at),
            phone = VALUES(phone),
            office_address_line1 = VALUES(office_address_line1),
            office_address_line2 = VALUES(office_address_line2),
            office_city = VALUES(office_city),
            office_state = VALUES(office_state),
            office_postal_code = VALUES(office_postal_code),
            office_country = VALUES(office_country),
            profile_image_url = VALUES(profile_image_url),
            delegate_logo_url = VALUES(delegate_logo_url),
            zelle_contact = VALUES(zelle_contact),
            cart = VALUES(cart),
            downloads = VALUES(downloads),
            referral_credits = VALUES(referral_credits),
            total_referrals = VALUES(total_referrals),
            visits = VALUES(visits),
            receive_client_order_update_emails = VALUES(receive_client_order_update_emails),
            markup_percent = VALUES(markup_percent),
            created_at = VALUES(created_at),
            last_login_at = VALUES(last_login_at),
            must_reset_password = VALUES(must_reset_password),
            first_order_bonus_granted_at = VALUES(first_order_bonus_granted_at),
            npi_number = VALUES(npi_number),
            npi_last_verified_at = VALUES(npi_last_verified_at),
            npi_verification = VALUES(npi_verification),
            npi_status = VALUES(npi_status),
            npi_check_error = VALUES(npi_check_error)
        """,
        params,
    )
    return find_by_id(payload["id"])


def _mysql_update(user: Dict) -> Optional[Dict]:
    existing = find_by_id(user.get("id"))
    if not existing:
        return None
    merged = _ensure_defaults({**existing, **user})
    existing_sales_rep_id = _normalize_identifier(existing.get("salesRepId") or existing.get("sales_rep_id"))
    if existing_sales_rep_id:
        merged["salesRepId"] = existing_sales_rep_id
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
            is_online = %(is_online)s,
            hand_delivered = %(hand_delivered)s,
            sales_rep_id = %(sales_rep_id)s,
            referrer_doctor_id = %(referrer_doctor_id)s,
            session_id = %(session_id)s,
            last_seen_at = %(last_seen_at)s,
            last_interaction_at = %(last_interaction_at)s,
            lead_type = %(lead_type)s,
            lead_type_source = %(lead_type_source)s,
            lead_type_locked_at = %(lead_type_locked_at)s,
            phone = %(phone)s,
            office_address_line1 = %(office_address_line1)s,
            office_address_line2 = %(office_address_line2)s,
            office_city = %(office_city)s,
            office_state = %(office_state)s,
            office_postal_code = %(office_postal_code)s,
            office_country = %(office_country)s,
            profile_image_url = %(profile_image_url)s,
            delegate_logo_url = %(delegate_logo_url)s,
            zelle_contact = %(zelle_contact)s,
            cart = %(cart)s,
            downloads = %(downloads)s,
            referral_credits = %(referral_credits)s,
            total_referrals = %(total_referrals)s,
            visits = %(visits)s,
            receive_client_order_update_emails = %(receive_client_order_update_emails)s,
            markup_percent = %(markup_percent)s,
            created_at = %(created_at)s,
            last_login_at = %(last_login_at)s,
            must_reset_password = %(must_reset_password)s,
            first_order_bonus_granted_at = %(first_order_bonus_granted_at)s,
            npi_number = %(npi_number)s,
            npi_last_verified_at = %(npi_last_verified_at)s,
            npi_verification = %(npi_verification)s,
            npi_status = %(npi_status)s,
            npi_check_error = %(npi_check_error)s
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

    verification = row.get("npi_verification")
    if isinstance(verification, str):
        try:
            verification = json.loads(verification)
        except json.JSONDecodeError:
            verification = None

    downloads = row.get("downloads")
    if isinstance(downloads, str):
        try:
            downloads = json.loads(downloads)
        except json.JSONDecodeError:
            downloads = None

    return _ensure_defaults(
        {
            "id": row.get("id"),
            "name": row.get("name"),
            "email": row.get("email"),
            "password": row.get("password"),
            "role": row.get("role"),
            "status": row.get("status"),
            "handDelivered": bool(row.get("hand_delivered")),
            "isOnline": bool(row.get("is_online")),
            "salesRepId": row.get("sales_rep_id"),
            "referrerDoctorId": row.get("referrer_doctor_id"),
            "sessionId": row.get("session_id"),
            "lastSeenAt": fmt_datetime(row.get("last_seen_at")),
            "lastInteractionAt": fmt_datetime(row.get("last_interaction_at")),
            "leadType": row.get("lead_type"),
            "leadTypeSource": row.get("lead_type_source"),
            "leadTypeLockedAt": fmt_datetime(row.get("lead_type_locked_at")),
            "phone": row.get("phone"),
            "officeAddressLine1": row.get("office_address_line1"),
            "officeAddressLine2": row.get("office_address_line2"),
            "officeCity": row.get("office_city"),
            "officeState": row.get("office_state"),
            "officePostalCode": row.get("office_postal_code"),
            "officeCountry": row.get("office_country"),
            "profileImageUrl": row.get("profile_image_url"),
            "delegateLogoUrl": row.get("delegate_logo_url"),
            "zelleContact": row.get("zelle_contact") or None,
            "cart": row.get("cart"),
            "downloads": downloads,
            "referralCode": row.get("referral_code"),
            "referralCredits": float(row.get("referral_credits") or 0),
            "totalReferrals": int(row.get("total_referrals") or 0),
            "visits": int(row.get("visits") or 0),
            "markupPercent": float(row.get("markup_percent") or 0.0),
            "createdAt": fmt_datetime(row.get("created_at")),
            "lastLoginAt": fmt_datetime(row.get("last_login_at")),
            "mustResetPassword": bool(row.get("must_reset_password")),
            "firstOrderBonusGrantedAt": fmt_datetime(row.get("first_order_bonus_granted_at")),
            "npiNumber": _normalize_npi(row.get("npi_number")),
            "npiLastVerifiedAt": fmt_datetime(row.get("npi_last_verified_at")),
            "npiVerification": verification,
            "npiStatus": row.get("npi_status"),
            "npiCheckError": row.get("npi_check_error"),
            "devCommission": row.get("dev_commission"),
            "receiveClientOrderUpdateEmails": row.get("receive_client_order_update_emails"),
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
        "is_online": 1 if user.get("isOnline") else 0,
        "hand_delivered": 1 if _normalize_bool(user.get("handDelivered")) else 0,
        "sales_rep_id": user.get("salesRepId"),
        "referrer_doctor_id": user.get("referrerDoctorId"),
        "session_id": user.get("sessionId"),
        "last_seen_at": parse_dt(user.get("lastSeenAt")),
        "last_interaction_at": parse_dt(user.get("lastInteractionAt")),
        "lead_type": user.get("leadType"),
        "lead_type_source": user.get("leadTypeSource"),
        "lead_type_locked_at": parse_dt(user.get("leadTypeLockedAt")),
        "phone": user.get("phone"),
        "office_address_line1": user.get("officeAddressLine1"),
        "office_address_line2": user.get("officeAddressLine2"),
        "office_city": user.get("officeCity"),
        "office_state": user.get("officeState"),
        "office_postal_code": user.get("officePostalCode"),
        "office_country": user.get("officeCountry"),
        "profile_image_url": user.get("profileImageUrl"),
        "delegate_logo_url": user.get("delegateLogoUrl"),
        "zelle_contact": user.get("zelleContact"),
        "cart": json.dumps(_normalize_cart_items(user.get("cart"))),
        "downloads": json.dumps(user.get("downloads") or []),
        "referral_credits": float(user.get("referralCredits") or 0),
        "total_referrals": int(user.get("totalReferrals") or 0),
        "visits": int(user.get("visits") or 0),
        "receive_client_order_update_emails": 1 if _normalize_bool(user.get("receiveClientOrderUpdateEmails")) else 0,
        "markup_percent": float(user.get("markupPercent") or 0.0),
        "created_at": parse_dt(user.get("createdAt")),
        "last_login_at": parse_dt(user.get("lastLoginAt")),
        "must_reset_password": 1 if user.get("mustResetPassword") else 0,
        "first_order_bonus_granted_at": parse_dt(user.get("firstOrderBonusGrantedAt")),
        "npi_number": _normalize_npi(user.get("npiNumber")) or None,
        "npi_last_verified_at": parse_dt(user.get("npiLastVerifiedAt")),
        "npi_verification": json.dumps(user.get("npiVerification")) if user.get("npiVerification") else None,
        "npi_status": user.get("npiStatus"),
        "npi_check_error": user.get("npiCheckError"),
    }


def adjust_referral_credits(user_id: str, delta: float) -> Optional[Dict]:
    if not user_id or not isinstance(delta, (int, float)):
        return None
    amount = round(float(delta), 2)
    if abs(amount) < 1e-9:
        return find_by_id(user_id)

    if _using_mysql():
        rows = mysql_client.execute(
            """
            UPDATE users
            SET referral_credits = ROUND(COALESCE(referral_credits, 0) + %(delta)s, 2)
            WHERE id = %(id)s
            """,
            {"id": user_id, "delta": amount},
        )
        if rows == 0:
            return None
        return find_by_id(user_id)

    users = _load()
    for index, existing in enumerate(users):
        if existing.get("id") == user_id:
            new_balance = round(float(existing.get("referralCredits") or 0) + amount, 2)
            updated = _ensure_defaults({**existing, "referralCredits": new_balance})
            users[index] = updated
            _save(users)
            return updated
    return None


def find_by_npi_number(npi_number: str) -> Optional[Dict]:
    normalized = _normalize_npi(npi_number)
    if not normalized:
        return None
    if _using_mysql():
        row = mysql_client.fetch_one("SELECT * FROM users WHERE npi_number = %(npi_number)s", {"npi_number": normalized})
        return _row_to_user(row)
    return next(
        (user for user in _load() if _normalize_npi(user.get("npiNumber")) == normalized),
        None,
    )
