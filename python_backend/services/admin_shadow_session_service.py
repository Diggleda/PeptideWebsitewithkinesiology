from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional
from urllib.parse import quote

from ..repositories import user_repository
from ..repositories import admin_shadow_session_repository
from ..services import auth_service, get_config
from ..utils.http import service_error


ALLOWED_TARGET_ROLES = {
    "doctor",
    "test_doctor",
    "sales_rep",
    "sales_partner",
    "sales_lead",
}


def _normalize_role(value: Any) -> str:
    return str(value or "").strip().lower().replace("-", "_").replace(" ", "_")


def _parse_iso(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _require_admin_actor(actor: Optional[Dict]) -> Dict:
    if not isinstance(actor, dict):
        raise service_error("Admin access required", 403)
    if _normalize_role(actor.get("role")) != "admin":
        raise service_error("Admin access required", 403)
    actor_id = str(actor.get("id") or "").strip()
    if not actor_id:
        raise service_error("Admin access required", 403)
    admin_user = user_repository.find_by_id(actor_id)
    if not admin_user or _normalize_role(admin_user.get("role")) != "admin":
        raise service_error("Admin access required", 403)
    return admin_user


def _get_target_user(target_user_id: str) -> Dict:
    normalized = str(target_user_id or "").strip()
    if not normalized:
        raise service_error("TARGET_USER_ID_REQUIRED", 400)
    target_user = user_repository.find_by_id(normalized)
    if not isinstance(target_user, dict):
        raise service_error("TARGET_USER_NOT_FOUND", 404)
    role = _normalize_role(target_user.get("role"))
    if role == "admin":
        raise service_error("ADMIN_TARGET_NOT_ALLOWED", 403)
    if role not in ALLOWED_TARGET_ROLES:
        raise service_error("TARGET_ROLE_NOT_SUPPORTED", 403)
    return target_user


def _build_launch_url(launch_token: str) -> str:
    config = get_config()
    base = (config.frontend_base_url or "http://localhost:3000").rstrip("/")
    return f"{base}/?shadow={quote(launch_token)}"


def _build_shadow_context(
    *,
    session_record: Dict,
    admin_user: Dict,
    target_user: Dict,
) -> Dict:
    return {
        "active": True,
        "mode": "maintenance",
        "readOnly": True,
        "adminUserId": str(admin_user.get("id") or ""),
        "adminName": str(admin_user.get("name") or "").strip() or None,
        "targetUserId": str(target_user.get("id") or ""),
        "startedAt": session_record.get("createdAt"),
        "expiresAt": session_record.get("sessionExpiresAt"),
    }


def create_shadow_session(actor: Optional[Dict], target_user_id: str) -> Dict:
    admin_user = _require_admin_actor(actor)
    target_user = _get_target_user(target_user_id)
    target_role = _normalize_role(target_user.get("role"))
    session_record, launch_token = admin_shadow_session_repository.create_session(
        admin_user_id=str(admin_user.get("id") or ""),
        target_user_id=str(target_user.get("id") or ""),
        target_role=target_role,
    )
    return {
        "shadowSessionId": session_record.get("id"),
        "targetUserId": target_user.get("id"),
        "targetRole": target_role,
        "launchToken": launch_token,
        "launchUrl": _build_launch_url(launch_token),
        "launchExpiresAt": session_record.get("launchExpiresAt"),
        "sessionExpiresAt": session_record.get("sessionExpiresAt"),
    }


def exchange_shadow_session(launch_token: str) -> Dict:
    session_record = admin_shadow_session_repository.consume_launch_token(launch_token)
    if not session_record:
        raise service_error("SHADOW_LAUNCH_TOKEN_INVALID", 403)
    admin_user = _require_admin_actor(user_repository.find_by_id(str(session_record.get("adminUserId") or "")))
    target_user = _get_target_user(str(session_record.get("targetUserId") or ""))
    shadow_context = _build_shadow_context(
        session_record=session_record,
        admin_user=admin_user,
        target_user=target_user,
    )
    token = auth_service._create_auth_token(
        {
            "id": str(target_user.get("id") or ""),
            "email": target_user.get("email"),
            "role": _normalize_role(target_user.get("role")),
            "shadow": True,
            "shadowMode": "maintenance",
            "shadowAdminId": str(admin_user.get("id") or ""),
            "shadowSessionId": str(session_record.get("id") or ""),
            "readOnly": True,
        },
        expires_in_seconds=admin_shadow_session_repository.DEFAULT_SESSION_TTL_SECONDS,
    )
    profile = auth_service.get_profile(str(target_user.get("id") or ""), target_user.get("role"))
    if isinstance(profile, dict):
        profile["shadowContext"] = shadow_context
    return {
        "token": token,
        "user": profile,
        "shadowContext": shadow_context,
    }


def resolve_shadow_session(payload: Dict) -> Dict:
    if not isinstance(payload, dict) or payload.get("shadow") is not True:
        raise service_error("TOKEN_INVALID", 403)
    session_id = str(payload.get("shadowSessionId") or "").strip()
    admin_user_id = str(payload.get("shadowAdminId") or "").strip()
    target_user_id = str(payload.get("id") or "").strip()
    if not session_id or not admin_user_id or not target_user_id:
        raise service_error("TOKEN_INVALID", 403)

    session_record = admin_shadow_session_repository.find_by_id(session_id)
    if not session_record:
        raise service_error("TOKEN_REVOKED", 403)

    expires_at = _parse_iso(session_record.get("sessionExpiresAt"))
    ended_at = _parse_iso(session_record.get("endedAt"))
    if ended_at or not expires_at or expires_at <= datetime.now(timezone.utc):
        raise service_error("TOKEN_REVOKED", 403)

    admin_user = _require_admin_actor(user_repository.find_by_id(admin_user_id))
    target_user = _get_target_user(target_user_id)
    if str(session_record.get("adminUserId") or "") != str(admin_user.get("id") or ""):
        raise service_error("TOKEN_REVOKED", 403)
    if str(session_record.get("targetUserId") or "") != str(target_user.get("id") or ""):
        raise service_error("TOKEN_REVOKED", 403)

    touched = admin_shadow_session_repository.touch_last_seen(session_id) or session_record
    return {
        "session": touched,
        "adminUser": admin_user,
        "targetUser": target_user,
        "shadowContext": _build_shadow_context(
            session_record=touched,
            admin_user=admin_user,
            target_user=target_user,
        ),
    }


def end_shadow_session_from_payload(payload: Dict) -> Dict:
    if not isinstance(payload, dict) or payload.get("shadow") is not True:
        return {"ok": True}
    session_id = str(payload.get("shadowSessionId") or "").strip()
    if session_id:
        admin_shadow_session_repository.end_session(session_id)
    return {"ok": True}
