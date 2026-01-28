from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import os
import time
import threading

from flask import Blueprint, request, g

from ..middleware.auth import require_auth
from ..repositories import user_repository
from ..repositories import sales_rep_repository
from ..repositories import sales_prospect_repository
from ..services import get_config
from ..services import auth_service
from ..services import presence_service
from ..services import settings_service  # type: ignore[attr-defined]
from ..utils.http import handle_action

blueprint = Blueprint("settings", __name__, url_prefix="/api/settings")

_USER_ACTIVITY_CACHE_LOCK = threading.Lock()
_USER_ACTIVITY_CACHE: dict[str, dict] = {}
_USER_ACTIVITY_LONGPOLL_CONCURRENCY = int(os.environ.get("USER_ACTIVITY_LONGPOLL_CONCURRENCY") or 4)
_USER_ACTIVITY_LONGPOLL_CONCURRENCY = max(1, min(_USER_ACTIVITY_LONGPOLL_CONCURRENCY, 20))
_USER_ACTIVITY_LONGPOLL_SEMAPHORE = threading.BoundedSemaphore(_USER_ACTIVITY_LONGPOLL_CONCURRENCY)

_LIVE_CLIENTS_CACHE_LOCK = threading.Lock()
_LIVE_CLIENTS_CACHE: dict[str, dict] = {}
_LIVE_CLIENTS_LONGPOLL_CONCURRENCY = int(os.environ.get("LIVE_CLIENTS_LONGPOLL_CONCURRENCY") or 4)
_LIVE_CLIENTS_LONGPOLL_CONCURRENCY = max(1, min(_LIVE_CLIENTS_LONGPOLL_CONCURRENCY, 20))
_LIVE_CLIENTS_LONGPOLL_SEMAPHORE = threading.BoundedSemaphore(_LIVE_CLIENTS_LONGPOLL_CONCURRENCY)

_LIVE_USERS_CACHE_LOCK = threading.Lock()
_LIVE_USERS_CACHE: dict[str, dict] = {"payload": None, "expiresAt": 0.0}
_LIVE_USERS_LONGPOLL_CONCURRENCY = int(os.environ.get("LIVE_USERS_LONGPOLL_CONCURRENCY") or 4)
_LIVE_USERS_LONGPOLL_CONCURRENCY = max(1, min(_LIVE_USERS_LONGPOLL_CONCURRENCY, 20))
_LIVE_USERS_LONGPOLL_SEMAPHORE = threading.BoundedSemaphore(_LIVE_USERS_LONGPOLL_CONCURRENCY)

def _is_admin() -> bool:
    role = str((getattr(g, "current_user", None) or {}).get("role") or "").lower()
    return role == "admin"

def _is_sales_lead() -> bool:
    role = str((getattr(g, "current_user", None) or {}).get("role") or "").strip().lower()
    return role in ("sales_lead", "saleslead", "sales-lead")


def _require_admin():
    if not _is_admin():
        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err

def _require_admin_or_sales_lead():
    if not (_is_admin() or _is_sales_lead()):
        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err


def _public_user_profile(user: dict) -> dict:
    if not isinstance(user, dict):
        return {}
    return {
        "id": user.get("id"),
        "name": user.get("name") or None,
        "email": user.get("email") or None,
        "role": user.get("role") or None,
        "status": user.get("status") or None,
        "isOnline": bool(user.get("isOnline")),
        "lastLoginAt": user.get("lastLoginAt") or None,
        "createdAt": user.get("createdAt") or None,
        "profileImageUrl": user.get("profileImageUrl") or None,
        "phone": user.get("phone") or None,
        "officeAddressLine1": user.get("officeAddressLine1") or None,
        "officeAddressLine2": user.get("officeAddressLine2") or None,
        "officeCity": user.get("officeCity") or None,
        "officeState": user.get("officeState") or None,
        "officePostalCode": user.get("officePostalCode") or None,
        "officeCountry": user.get("officeCountry") or None,
        "salesRepId": user.get("salesRepId") or None,
        "leadType": user.get("leadType") or None,
        "leadTypeSource": user.get("leadTypeSource") or None,
        "leadTypeLockedAt": user.get("leadTypeLockedAt") or None,
        "referralCredits": user.get("referralCredits"),
        "totalReferrals": user.get("totalReferrals"),
        "npiNumber": user.get("npiNumber") or None,
        "npiStatus": user.get("npiStatus") or None,
        "npiLastVerifiedAt": user.get("npiLastVerifiedAt") or None,
    }

def _normalize_role(value: object) -> str:
    return str(value or "").strip().lower()

def _is_admin_role(role: str) -> bool:
    return _normalize_role(role) == "admin"

def _is_sales_rep_role(role: str) -> bool:
    normalized = _normalize_role(role)
    return normalized in ("sales_rep", "rep")

def _is_sales_lead_role(role: str) -> bool:
    normalized = _normalize_role(role)
    return normalized in ("sales_lead", "saleslead", "sales-lead")

def _compute_allowed_sales_rep_ids(sales_rep_id: str) -> set[str]:
    """
    Sales-rep references can be stored under multiple ids over time:
    - sales_reps.id
    - sales_reps.legacyUserId (older user-based reps)
    - users.id (role=sales_rep)
    Match all reasonable equivalents so reps see their assigned doctors.
    """
    normalized_sales_rep_id = str(sales_rep_id or "").strip()
    allowed: set[str] = {normalized_sales_rep_id} if normalized_sales_rep_id else set()

    try:
        reps = sales_rep_repository.get_all() or []
    except Exception:
        reps = []
    rep_records: dict[str, dict] = {}
    for rep in reps:
        if not isinstance(rep, dict):
            continue
        rep_id = str(rep.get("id") or "").strip()
        if rep_id:
            rep_records[rep_id] = rep

    legacy_map = {
        str(rep.get("legacyUserId")).strip(): rep_id
        for rep_id, rep in rep_records.items()
        if rep.get("legacyUserId")
    }

    rep_record_id = legacy_map.get(normalized_sales_rep_id)
    if rep_record_id:
        allowed.add(str(rep_record_id))

    def add_legacy_user_id(rep: dict | None) -> None:
        if not isinstance(rep, dict):
            return
        legacy_user_id = str(rep.get("legacyUserId") or "").strip()
        if legacy_user_id:
            allowed.add(legacy_user_id)

    direct_rep_record = rep_records.get(normalized_sales_rep_id) if normalized_sales_rep_id else None
    add_legacy_user_id(direct_rep_record if isinstance(direct_rep_record, dict) else None)
    add_legacy_user_id(rep_records.get(str(rep_record_id)) if rep_record_id else None)

    # Cross-link via email when the sales rep has both a `users` row and a `sales_reps` row.
    try:
        users = user_repository.get_all() or []
    except Exception:
        users = []

    rep_user = next((u for u in users if str((u or {}).get("id") or "") == normalized_sales_rep_id), None)
    rep_user_email = (rep_user.get("email") or "").strip().lower() if isinstance(rep_user, dict) else ""
    if rep_user_email:
        for rep_id, rep in rep_records.items():
            if (rep.get("email") or "").strip().lower() == rep_user_email:
                allowed.add(str(rep_id))
                add_legacy_user_id(rep)

    rep_email_candidates = set()
    if rep_user_email:
        rep_email_candidates.add(rep_user_email)
    for record in (
        direct_rep_record if isinstance(direct_rep_record, dict) else None,
        rep_records.get(str(rep_record_id)) if rep_record_id else None,
    ):
        if isinstance(record, dict):
            email = (record.get("email") or "").strip().lower()
            if email:
                rep_email_candidates.add(email)

    if rep_email_candidates:
        for user in users:
            if not isinstance(user, dict):
                continue
            email = (user.get("email") or "").strip().lower()
            if not email or email not in rep_email_candidates:
                continue
            role = (user.get("role") or "").lower()
            if role in ("sales_rep", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
                allowed.add(str(user.get("id")))

    return {value for value in allowed if str(value or "").strip()}

def _compute_presence_snapshot(user: dict, *, now_epoch: float, online_threshold_s: float, idle_threshold_s: float, presence: dict) -> dict:
    user_id = str(user.get("id") or "")
    presence_entry = presence.get(user_id)
    presence_public = presence_service.to_public_fields(presence_entry)

    last_login_dt = _parse_iso_datetime(user.get("lastLoginAt") or None)
    last_seen_dt = _parse_iso_datetime(user.get("lastSeenAt") or None)
    last_interaction_dt = _parse_iso_datetime(user.get("lastInteractionAt") or None)

    last_seen_epoch = None
    try:
        raw_seen = presence_entry.get("lastHeartbeatAt") if isinstance(presence_entry, dict) else None
        if isinstance(raw_seen, (int, float)) and float(raw_seen) > 0:
            last_seen_epoch = float(raw_seen)
    except Exception:
        last_seen_epoch = None
    if last_seen_epoch is None and last_seen_dt:
        last_seen_epoch = float(last_seen_dt.timestamp())

    derived_online = presence_service.is_recent_epoch(
        last_seen_epoch,
        now_epoch=now_epoch,
        threshold_s=online_threshold_s,
    )
    if derived_online and not bool(user.get("isOnline")):
        derived_online = False

    idle_anchor_epoch = None
    try:
        raw_interaction = presence_entry.get("lastInteractionAt") if isinstance(presence_entry, dict) else None
        if isinstance(raw_interaction, (int, float)) and float(raw_interaction) > 0:
            idle_anchor_epoch = float(raw_interaction)
    except Exception:
        idle_anchor_epoch = None
    if idle_anchor_epoch is None and last_interaction_dt:
        idle_anchor_epoch = float(last_interaction_dt.timestamp())
    if idle_anchor_epoch is None and last_login_dt:
        idle_anchor_epoch = float(last_login_dt.timestamp())
    if idle_anchor_epoch is None and last_seen_epoch is not None:
        idle_anchor_epoch = float(last_seen_epoch)

    computed_idle = None
    if derived_online and isinstance(idle_anchor_epoch, (int, float)) and float(idle_anchor_epoch) > 0:
        computed_idle = (now_epoch - float(idle_anchor_epoch)) >= idle_threshold_s

    idle_minutes = None
    if isinstance(idle_anchor_epoch, (int, float)) and float(idle_anchor_epoch) > 0:
        idle_minutes = max(0, int((now_epoch - float(idle_anchor_epoch)) // 60))

    online_minutes = None
    if last_login_dt:
        online_minutes = max(0, int((now_epoch - float(last_login_dt.timestamp())) // 60))

    last_seen_at = presence_public.get("lastSeenAt") or user.get("lastSeenAt") or None
    last_interaction_at = presence_public.get("lastInteractionAt") or user.get("lastInteractionAt") or None

    return {
        "isOnline": derived_online,
        "isIdle": computed_idle,
        "lastLoginAt": user.get("lastLoginAt") or None,
        "lastSeenAt": last_seen_at,
        "lastInteractionAt": last_interaction_at,
        "idleMinutes": idle_minutes,
        "onlineMinutes": online_minutes,
    }

def _compute_live_clients_payload(
    *,
    target_sales_rep_id: str,
) -> dict:
    all_users = user_repository.get_all()

    allowed_rep_ids = _compute_allowed_sales_rep_ids(target_sales_rep_id)
    prospects = sales_prospect_repository.find_by_sales_rep(target_sales_rep_id)
    doctor_ids = {
        str(p.get("doctorId")).strip()
        for p in (prospects or [])
        if p and p.get("doctorId")
    }
    contact_emails = {
        str(p.get("contactEmail") or "").strip().lower()
        for p in (prospects or [])
        if p and p.get("contactEmail")
    }
    contact_emails = {e for e in contact_emails if e and "@" in e}

    candidate_by_id: dict[str, dict] = {}
    for user in all_users or []:
        if not isinstance(user, dict):
            continue
        user_role = _normalize_role(user.get("role"))
        if user_role not in ("doctor", "test_doctor"):
            continue
        uid = str(user.get("id") or "").strip()
        if not uid:
            continue
        email = str(user.get("email") or "").strip().lower()
        doctor_sales_rep_id = str(user.get("salesRepId") or user.get("sales_rep_id") or "").strip()
        if doctor_sales_rep_id and doctor_sales_rep_id in allowed_rep_ids:
            candidate_by_id[uid] = user
            continue
        if uid in doctor_ids:
            candidate_by_id[uid] = user
            continue
        if email and email in contact_emails:
            candidate_by_id[uid] = user

    now_epoch = time.time()
    online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
    online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
    idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
    idle_threshold_s = max(60.0, min(idle_threshold_s, 6 * 60 * 60))
    presence = presence_service.snapshot()

    clients = []
    for user in candidate_by_id.values():
        snapshot = _compute_presence_snapshot(
            user,
            now_epoch=now_epoch,
            online_threshold_s=online_threshold_s,
            idle_threshold_s=idle_threshold_s,
            presence=presence,
        )
        clients.append(
            {
                "id": user.get("id"),
                "name": user.get("name") or None,
                "email": user.get("email") or None,
                "role": _normalize_role(user.get("role")) or "unknown",
                "profileImageUrl": user.get("profileImageUrl") or None,
                **snapshot,
            }
        )

    # Sort online+active, online+idle, then offline.
    clients.sort(
        key=lambda entry: (
            0 if bool(entry.get("isOnline")) and not bool(entry.get("isIdle"))
            else 1 if bool(entry.get("isOnline"))
            else 2,
            str(entry.get("name") or entry.get("email") or entry.get("id") or "").lower(),
        )
    )

    sig = [
        {
            "id": entry.get("id"),
            "isOnline": bool(entry.get("isOnline")),
            "isIdle": bool(entry.get("isIdle")),
            "lastLoginAt": entry.get("lastLoginAt") or None,
            "lastSeenAt": entry.get("lastSeenAt") or None,
            "lastInteractionAt": entry.get("lastInteractionAt") or None,
            "profileImageUrl": entry.get("profileImageUrl") or None,
        }
        for entry in clients
    ]
    sig.sort(key=lambda entry: str(entry.get("id") or ""))
    etag = hashlib.sha256(
        json.dumps({"salesRepId": target_sales_rep_id, "clients": sig}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    return {
        "etag": etag,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "salesRepId": target_sales_rep_id,
        "clients": clients,
        "total": len(clients),
    }

def _compute_live_clients_cached(*, target_sales_rep_id: str) -> dict:
    now = time.monotonic()
    ttl_s = float(os.environ.get("LIVE_CLIENTS_CACHE_TTL_SECONDS") or 1.0)
    ttl_s = max(0.25, min(ttl_s, 5.0))

    cache_key = str(target_sales_rep_id or "").strip()
    with _LIVE_CLIENTS_CACHE_LOCK:
        cached = _LIVE_CLIENTS_CACHE.get(cache_key) or {}
        cached_at = float(cached.get("at") or 0.0)
        if cached and cached_at > 0 and (now - cached_at) < ttl_s:
            payload = cached.get("payload")
            if isinstance(payload, dict):
                return payload

    payload = _compute_live_clients_payload(target_sales_rep_id=cache_key)
    with _LIVE_CLIENTS_CACHE_LOCK:
        _LIVE_CLIENTS_CACHE[cache_key] = {"at": now, "payload": payload}
    return payload


def _compute_live_users_payload() -> dict:
    users = user_repository.get_all()
    users_by_id: dict[str, dict] = {}

    for user in users or []:
        if not isinstance(user, dict):
            continue
        uid = str(user.get("id") or "").strip()
        if not uid:
            continue
        users_by_id[uid] = user

    # Admin Live Users should only reflect the canonical `users` table to avoid duplicates.

    def normalize_user_role(value: object) -> str:
        normalized = _normalize_role(value)
        return normalized or "unknown"

    now_epoch = time.time()
    online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
    online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
    idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
    idle_threshold_s = max(10.0, min(idle_threshold_s, 6 * 60 * 60))
    presence = presence_service.snapshot()

    entries = []
    for user in users_by_id.values():
        snapshot = _compute_presence_snapshot(
            user,
            now_epoch=now_epoch,
            online_threshold_s=online_threshold_s,
            idle_threshold_s=idle_threshold_s,
            presence=presence,
        )
        entries.append(
            {
                "id": user.get("id"),
                "name": user.get("name") or None,
                "email": user.get("email") or None,
                "role": normalize_user_role(user.get("role")),
                "profileImageUrl": user.get("profileImageUrl") or None,
                **snapshot,
            }
        )

    entries.sort(
        key=lambda entry: (
            0 if bool(entry.get("isOnline")) and not bool(entry.get("isIdle"))
            else 1 if bool(entry.get("isOnline"))
            else 2,
            str(entry.get("name") or entry.get("email") or entry.get("id") or "").lower(),
        )
    )

    sig = [
        {
            "id": entry.get("id"),
            "role": entry.get("role") or "unknown",
            "isOnline": bool(entry.get("isOnline")),
            "isIdle": bool(entry.get("isIdle")),
            "lastLoginAt": entry.get("lastLoginAt") or None,
            "profileImageUrl": entry.get("profileImageUrl") or None,
        }
        for entry in entries
    ]
    sig.sort(key=lambda entry: str(entry.get("id") or ""))
    etag = hashlib.sha256(
        json.dumps({"users": sig}, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    return {
        "etag": etag,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "users": entries,
        "total": len(entries),
    }


def _compute_live_users_cached() -> dict:
    now = time.monotonic()
    ttl_s = float(os.environ.get("LIVE_USERS_CACHE_TTL_SECONDS") or 1.0)
    ttl_s = max(0.25, min(ttl_s, 5.0))

    with _LIVE_USERS_CACHE_LOCK:
        cached = _LIVE_USERS_CACHE.get("payload")
        expires_at = float(_LIVE_USERS_CACHE.get("expiresAt") or 0.0)
        if cached and expires_at > now:
            return cached

    payload = _compute_live_users_payload()
    with _LIVE_USERS_CACHE_LOCK:
        _LIVE_USERS_CACHE["payload"] = payload
        _LIVE_USERS_CACHE["expiresAt"] = now + ttl_s
    return payload


@blueprint.get("/shop")
def get_shop():
    def action():
        settings = settings_service.get_settings()
        return {"shopEnabled": bool(settings.get("shopEnabled", True))}

    return handle_action(action)

@blueprint.get("/forum")
def get_forum():
    def action():
        settings = settings_service.get_settings()
        config = get_config()
        return {
            "peptideForumEnabled": bool(settings.get("peptideForumEnabled", True)),
            "mysqlEnabled": bool(getattr(config, "mysql", {}).get("enabled")),
        }

    return handle_action(action)

@blueprint.get("/research")
def get_research():
    def action():
        settings = settings_service.get_settings()
        config = get_config()
        return {
            "researchDashboardEnabled": bool(settings.get("researchDashboardEnabled", False)),
            "mysqlEnabled": bool(getattr(config, "mysql", {}).get("enabled")),
        }

    return handle_action(action)


@blueprint.put("/shop")
@require_auth
def update_shop():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"shopEnabled": enabled})
        config = get_config()
        return {
            "shopEnabled": bool(updated.get("shopEnabled", True)),
            "mysqlEnabled": bool(getattr(config, "mysql", {}).get("enabled")),
        }

    return handle_action(action)

@blueprint.put("/forum")
@require_auth
def update_forum():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"peptideForumEnabled": enabled})
        config = get_config()
        return {
            "peptideForumEnabled": bool(updated.get("peptideForumEnabled", True)),
            "mysqlEnabled": bool(getattr(config, "mysql", {}).get("enabled")),
        }

    return handle_action(action)

@blueprint.put("/research")
@require_auth
def update_research():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"researchDashboardEnabled": enabled})
        config = get_config()
        return {
            "researchDashboardEnabled": bool(updated.get("researchDashboardEnabled", False)),
            "mysqlEnabled": bool(getattr(config, "mysql", {}).get("enabled")),
        }

    return handle_action(action)

@blueprint.get("/test-payments-override")
@require_auth
def get_test_payments_override():
    def action():
        _require_admin()
        settings = settings_service.get_settings()
        return {
            "testPaymentsOverrideEnabled": bool(settings.get("testPaymentsOverrideEnabled", False)),
        }

    return handle_action(action)


@blueprint.put("/test-payments-override")
@require_auth
def update_test_payments_override():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        updated = settings_service.update_settings({"testPaymentsOverrideEnabled": enabled})
        return {
            "testPaymentsOverrideEnabled": bool(updated.get("testPaymentsOverrideEnabled", False)),
        }

    return handle_action(action)


@blueprint.post("/presence")
@require_auth
def record_presence():
    def action():
        current_user = getattr(g, "current_user", None) or {}
        user_id = current_user.get("id")
        if not user_id:
            err = RuntimeError("Authenticated user required")
            setattr(err, "status", 401)
            raise err
        payload = request.get_json(silent=True) or {}
        kind = str(payload.get("kind") or "heartbeat").strip().lower()
        is_idle_raw = payload.get("isIdle")
        is_idle = is_idle_raw if isinstance(is_idle_raw, bool) else None
        presence_service.record_ping(str(user_id), kind=kind, is_idle=is_idle)
        # Persist the heartbeat into MySQL so "online" isn't a sticky flag.
        # This also enables server-side idle/session enforcement in `require_auth`.
        try:
            existing = user_repository.find_by_id(str(user_id)) or {}
            now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            should_bump_interaction = kind == "interaction" or (kind == "heartbeat" and is_idle is False)
            next_user = {
                **existing,
                "id": str(user_id),
                "isOnline": True,
                "lastSeenAt": now_iso,
                "lastInteractionAt": now_iso if should_bump_interaction else (existing.get("lastInteractionAt") or None),
            }
            if existing:
                user_repository.update(next_user)
        except Exception:
            pass
        return {"ok": True}

    return handle_action(action)

@blueprint.get("/live-clients")
@require_auth
def get_live_clients():
    def action():
        current_user = getattr(g, "current_user", None) or {}
        role = _normalize_role(current_user.get("role"))
        if not (_is_admin_role(role) or _is_sales_rep_role(role)):
            err = RuntimeError("Sales rep access required")
            setattr(err, "status", 403)
            raise err

        requested_sales_rep_id = request.args.get("salesRepId") if _is_admin_role(role) else None
        target_sales_rep_id = str(requested_sales_rep_id or current_user.get("id") or "").strip()
        if not target_sales_rep_id:
            err = RuntimeError("salesRepId is required")
            setattr(err, "status", 400)
            raise err

        return _compute_live_clients_payload(target_sales_rep_id=target_sales_rep_id)

    return handle_action(action)

@blueprint.get("/live-clients/longpoll")
@require_auth
def longpoll_live_clients():
    def action():
        current_user = getattr(g, "current_user", None) or {}
        role = _normalize_role(current_user.get("role"))
        if not (_is_admin_role(role) or _is_sales_rep_role(role)):
            err = RuntimeError("Sales rep access required")
            setattr(err, "status", 403)
            raise err

        requested_sales_rep_id = request.args.get("salesRepId") if _is_admin_role(role) else None
        target_sales_rep_id = str(requested_sales_rep_id or current_user.get("id") or "").strip()
        if not target_sales_rep_id:
            err = RuntimeError("salesRepId is required")
            setattr(err, "status", 400)
            raise err

        client_etag = str(request.args.get("etag") or "").strip() or None
        try:
            timeout_ms = int(request.args.get("timeoutMs") or 25000)
        except Exception:
            timeout_ms = 25000
        timeout_ms = max(1000, min(timeout_ms, 30000))

        acquired = _LIVE_CLIENTS_LONGPOLL_SEMAPHORE.acquire(blocking=False)
        if not acquired:
            return _compute_live_clients_cached(target_sales_rep_id=target_sales_rep_id)

        try:
            started = time.monotonic()
            payload = _compute_live_clients_cached(target_sales_rep_id=target_sales_rep_id)
            etag = str(payload.get("etag") or "").strip() or None
            if not etag or etag != client_etag:
                return payload

            poll_interval_s = float(os.environ.get("LIVE_CLIENTS_LONGPOLL_INTERVAL_SECONDS") or 1.0)
            poll_interval_s = max(0.25, min(poll_interval_s, 2.0))
            while (time.monotonic() - started) * 1000 < timeout_ms:
                time.sleep(poll_interval_s)
                payload = _compute_live_clients_cached(target_sales_rep_id=target_sales_rep_id)
                etag = str(payload.get("etag") or "").strip() or None
                if not etag or etag != client_etag:
                    return payload

            return payload
        finally:
            try:
                _LIVE_CLIENTS_LONGPOLL_SEMAPHORE.release()
            except ValueError:
                pass

    return handle_action(action)


@blueprint.get("/live-users")
@require_auth
def get_live_users():
    def action():
        _require_admin_or_sales_lead()
        return _compute_live_users_cached()

    return handle_action(action)


@blueprint.get("/live-users/longpoll")
@require_auth
def longpoll_live_users():
    def action():
        _require_admin_or_sales_lead()

        client_etag = str(request.args.get("etag") or "").strip() or None
        try:
            timeout_ms = int(request.args.get("timeoutMs") or 25000)
        except Exception:
            timeout_ms = 25000
        timeout_ms = max(1000, min(timeout_ms, 30000))

        acquired = _LIVE_USERS_LONGPOLL_SEMAPHORE.acquire(blocking=False)
        if not acquired:
            return _compute_live_users_cached()

        try:
            started = time.monotonic()
            payload = _compute_live_users_cached()
            etag = str(payload.get("etag") or "").strip() or None
            if not etag or etag != client_etag:
                return payload

            poll_interval_s = float(os.environ.get("LIVE_USERS_LONGPOLL_INTERVAL_SECONDS") or 1.0)
            poll_interval_s = max(0.25, min(poll_interval_s, 2.0))
            while (time.monotonic() - started) * 1000 < timeout_ms:
                time.sleep(poll_interval_s)
                payload = _compute_live_users_cached()
                etag = str(payload.get("etag") or "").strip() or None
                if not etag or etag != client_etag:
                    return payload

            return payload
        finally:
            try:
                _LIVE_USERS_LONGPOLL_SEMAPHORE.release()
            except ValueError:
                pass

    return handle_action(action)


@blueprint.get("/users/<user_id>")
@require_auth
def get_user_profile(user_id: str):
    def action():
        _require_admin_or_sales_lead()
        target_id = (user_id or "").strip()
        if not target_id:
            err = RuntimeError("user_id is required")
            setattr(err, "status", 400)
            raise err
        user = user_repository.find_by_id(target_id)
        if not user:
            err = RuntimeError("User not found")
            setattr(err, "status", 404)
            raise err
        profile = _public_user_profile(user)
        try:
            now_epoch = time.time()
            online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
            online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
            idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
            idle_threshold_s = max(60.0, min(idle_threshold_s, 6 * 60 * 60))
            presence = presence_service.snapshot()
            snapshot = _compute_presence_snapshot(
                user,
                now_epoch=now_epoch,
                online_threshold_s=online_threshold_s,
                idle_threshold_s=idle_threshold_s,
                presence=presence,
            )
            profile["isOnline"] = bool(snapshot.get("isOnline"))
        except Exception:
            pass
        return {"user": profile}

    return handle_action(action)

@blueprint.patch("/users/<user_id>")
@require_auth
def patch_user_profile(user_id: str):
    def action():
        current_user = getattr(g, "current_user", None) or {}
        role = _normalize_role(current_user.get("role"))
        target_id = (user_id or "").strip()
        if not target_id:
            err = RuntimeError("user_id is required")
            setattr(err, "status", 400)
            raise err

        payload = request.get_json(silent=True) or {}
        if _is_admin_role(role):
            return {"user": auth_service.update_profile(target_id, payload)}

        if _is_sales_rep_role(role):
            # Sales reps may only edit phone for their assigned doctors.
            target = user_repository.find_by_id(target_id) or {}
            target_role = _normalize_role((target or {}).get("role"))
            if target_role not in ("doctor", "test_doctor"):
                err = RuntimeError("Doctor access required")
                setattr(err, "status", 403)
                raise err
            allowed = _compute_allowed_sales_rep_ids(str(current_user.get("id") or ""))
            doctor_rep_id = str((target or {}).get("salesRepId") or (target or {}).get("sales_rep_id") or "").strip()
            if not doctor_rep_id or doctor_rep_id not in allowed:
                err = RuntimeError("Not authorized to edit this user")
                setattr(err, "status", 403)
                raise err
            phone = payload.get("phone")
            return {"user": auth_service.update_profile(target_id, {"phone": phone})}

        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err

    return handle_action(action)


@blueprint.get("/stripe")
def get_stripe():
    def action():
        mode = settings_service.get_effective_stripe_mode()
        config = get_config()
        mysql_enabled = bool(config.mysql.get("enabled"))
        settings_logger = __import__("logging").getLogger("peppro.settings")
        settings_logger.debug("Stripe settings requested", extra={"mode": mode, "mysqlEnabled": mysql_enabled})
        try:
            resolved = settings_service.resolve_stripe_publishable_key(mode)
            live_key = str(config.stripe.get("publishable_key_live") or "").strip()
            test_key = str(config.stripe.get("publishable_key_test") or "").strip()
            print(
                f"[payments] settings publishable: mode={mode} resolved_prefix={(resolved or '')[:8]} live_present={bool(live_key)} test_present={bool(test_key)}",
                flush=True,
            )
        except Exception:
            pass
        return {
            "stripeMode": mode,
            "stripeTestMode": mode == "test",
            "onsiteEnabled": bool(config.stripe.get("onsite_enabled")),
            "publishableKey": settings_service.resolve_stripe_publishable_key(mode),
            "publishableKeyLive": str(config.stripe.get("publishable_key_live") or "").strip(),
            "publishableKeyTest": str(config.stripe.get("publishable_key_test") or "").strip(),
            "mysqlEnabled": mysql_enabled,
        }

    return handle_action(action)


@blueprint.put("/stripe")
@require_auth
def update_stripe():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        raw_mode = payload.get("mode")
        raw_test_mode = payload.get("testMode")
        if isinstance(raw_mode, str):
            mode = raw_mode.strip().lower()
        else:
            mode = "test" if bool(raw_test_mode) else "live"
        if mode not in ("test", "live"):
            mode = "test"
        config = get_config()
        mysql_enabled = bool(config.mysql.get("enabled"))
        settings_logger = __import__("logging").getLogger("peppro.settings")
        settings_logger.info("Stripe mode update requested", extra={"requestedMode": mode, "mysqlEnabled": mysql_enabled, "userId": (getattr(g, "current_user", None) or {}).get("id")})
        settings_service.update_settings({"stripeMode": mode})
        resolved_mode = settings_service.get_effective_stripe_mode()
        return {
            "stripeMode": resolved_mode,
            "stripeTestMode": resolved_mode == "test",
            "onsiteEnabled": bool(config.stripe.get("onsite_enabled")),
            "publishableKey": settings_service.resolve_stripe_publishable_key(resolved_mode),
            "publishableKeyLive": str(config.stripe.get("publishable_key_live") or "").strip(),
            "publishableKeyTest": str(config.stripe.get("publishable_key_test") or "").strip(),
            "mysqlEnabled": mysql_enabled,
        }

    return handle_action(action)


@blueprint.get("/reports")
@require_auth
def get_reports():
    def action():
        _require_admin()
        settings = settings_service.get_settings()
        downloaded_at = settings.get("salesBySalesRepCsvDownloadedAt")
        taxes_downloaded_at = settings.get("taxesByStateCsvDownloadedAt")
        products_downloaded_at = settings.get("productsCommissionCsvDownloadedAt")
        return {
            "salesBySalesRepCsvDownloadedAt": downloaded_at if isinstance(downloaded_at, str) else None,
            "taxesByStateCsvDownloadedAt": taxes_downloaded_at if isinstance(taxes_downloaded_at, str) else None,
            "productsCommissionCsvDownloadedAt": products_downloaded_at if isinstance(products_downloaded_at, str) else None,
        }

    return handle_action(action)


@blueprint.put("/reports")
@require_auth
def update_reports():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        patch = {}
        if "salesBySalesRepCsvDownloadedAt" in payload or "downloadedAt" in payload:
            raw = payload.get("salesBySalesRepCsvDownloadedAt") or payload.get("downloadedAt")
            parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
            stamp = (
                parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if parsed
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            patch["salesBySalesRepCsvDownloadedAt"] = stamp

        if "taxesByStateCsvDownloadedAt" in payload:
            raw = payload.get("taxesByStateCsvDownloadedAt")
            parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
            stamp = (
                parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if parsed
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            patch["taxesByStateCsvDownloadedAt"] = stamp

        if "productsCommissionCsvDownloadedAt" in payload:
            raw = payload.get("productsCommissionCsvDownloadedAt")
            parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
            stamp = (
                parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
                if parsed
                else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            )
            patch["productsCommissionCsvDownloadedAt"] = stamp

        if patch:
            updated = settings_service.update_settings(patch)
        else:
            updated = settings_service.get_settings()
        return {
            "salesBySalesRepCsvDownloadedAt": updated.get("salesBySalesRepCsvDownloadedAt"),
            "taxesByStateCsvDownloadedAt": updated.get("taxesByStateCsvDownloadedAt"),
            "productsCommissionCsvDownloadedAt": updated.get("productsCommissionCsvDownloadedAt"),
        }

    return handle_action(action)


def _parse_activity_window(raw: str | None) -> str:
    normalized = str(raw or "").strip().lower()
    if normalized in ("hour", "1h", "last_hour"):
        return "hour"
    if normalized in ("day", "1d", "last_day"):
        return "day"
    if normalized in ("3days", "3d", "3_days"):
        return "3days"
    if normalized in ("week", "7d", "last_week"):
        return "week"
    if normalized in ("month", "30d", "last_month"):
        return "month"
    if normalized in ("6months", "6mo", "half_year"):
        return "6months"
    if normalized in ("year", "12mo", "365d", "last_year"):
        return "year"
    return "day"


def _window_delta(window_key: str) -> timedelta:
    if window_key == "hour":
        return timedelta(hours=1)
    if window_key == "day":
        return timedelta(days=1)
    if window_key == "3days":
        return timedelta(days=3)
    if window_key == "week":
        return timedelta(days=7)
    if window_key == "month":
        return timedelta(days=30)
    if window_key == "6months":
        return timedelta(days=182)
    if window_key == "year":
        return timedelta(days=365)
    return timedelta(days=1)


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


@blueprint.post("/downloads/track")
@require_auth
def track_download_event():
    def action():
        payload = request.get_json(silent=True) or {}
        user_id = str((getattr(g, "current_user", None) or {}).get("id") or "").strip()
        if not user_id:
            err = RuntimeError("Authentication required")
            setattr(err, "status", 401)
            raise err

        kind = payload.get("kind") or payload.get("type") or payload.get("event")
        kind = str(kind or "").strip().lower()
        if not kind:
            err = RuntimeError("Download kind required")
            setattr(err, "status", 400)
            raise err

        raw_at = payload.get("at") if isinstance(payload.get("at"), str) else None
        at = (
            _parse_iso_datetime(raw_at).isoformat().replace("+00:00", "Z")
            if raw_at and _parse_iso_datetime(raw_at)
            else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        )

        event = {
            "kind": kind,
            "at": at,
            "wooProductId": payload.get("wooProductId") or payload.get("woo_product_id") or payload.get("wooId"),
            "productId": payload.get("productId") or payload.get("product_id"),
            "filename": payload.get("filename"),
        }

        user = user_repository.find_by_id(user_id) or {}
        downloads = user.get("downloads")
        if not isinstance(downloads, list):
            downloads = []
        downloads.append(event)
        # Keep the list bounded so the users table doesn't grow unbounded.
        max_events = int(os.environ.get("USER_DOWNLOAD_EVENTS_MAX") or 5000)
        max_events = max(100, min(max_events, 50000))
        if len(downloads) > max_events:
            downloads = downloads[-max_events:]

        user_repository.update({**user, "id": user_id, "downloads": downloads})
        return {"ok": True}

    return handle_action(action)


@blueprint.get("/user-activity")
@require_auth
def get_user_activity():
    def action():
        _require_admin()
        raw_window = request.args.get("window")
        window_key = _parse_activity_window(raw_window)
        return _compute_user_activity(window_key, raw_window=raw_window)

    return handle_action(action)


@blueprint.get("/user-activity/longpoll")
@require_auth
def longpoll_user_activity():
    def action():
        _require_admin()

        raw_window = request.args.get("window")
        window_key = _parse_activity_window(raw_window)
        client_etag = str(request.args.get("etag") or "").strip() or None
        try:
            timeout_ms = int(request.args.get("timeoutMs") or 25000)
        except Exception:
            timeout_ms = 25000
        timeout_ms = max(1000, min(timeout_ms, 30000))

        acquired = _USER_ACTIVITY_LONGPOLL_SEMAPHORE.acquire(blocking=False)
        if not acquired:
            report = _compute_user_activity_cached(window_key, raw_window=raw_window, include_logs=False)
            report["longpollSkipped"] = True
            return report

        try:
            started = time.monotonic()
            report = _compute_user_activity_cached(window_key, raw_window=raw_window, include_logs=False)
            etag = str(report.get("etag") or "").strip() or None
            if not etag or etag != client_etag:
                return report

            poll_interval_s = float(os.environ.get("USER_ACTIVITY_LONGPOLL_INTERVAL_SECONDS") or 1.0)
            poll_interval_s = max(0.25, min(poll_interval_s, 2.0))
            while (time.monotonic() - started) * 1000 < timeout_ms:
                time.sleep(poll_interval_s)
                report = _compute_user_activity_cached(window_key, raw_window=raw_window, include_logs=False)
                etag = str(report.get("etag") or "").strip() or None
                if not etag or etag != client_etag:
                    return report

            return report
        finally:
            try:
                _USER_ACTIVITY_LONGPOLL_SEMAPHORE.release()
            except ValueError:
                pass

    return handle_action(action)

def _compute_user_activity_cached(
    window_key: str,
    *,
    raw_window: str | None = None,
    include_logs: bool = True,
) -> dict:
    """
    User activity reports are polled frequently. Recomputing the report every ~150ms
    per request can overload small VPS instances and lead to upstream 502/504s.
    Cache for a short TTL so concurrent longpolls share work.
    """
    now = time.monotonic()
    ttl_s = float(os.environ.get("USER_ACTIVITY_CACHE_TTL_SECONDS") or 1.0)
    ttl_s = max(0.25, min(ttl_s, 5.0))

    cache_key = window_key
    with _USER_ACTIVITY_CACHE_LOCK:
        cached = _USER_ACTIVITY_CACHE.get(cache_key) or {}
        cached_at = float(cached.get("at") or 0.0)
        if cached and cached_at > 0 and (now - cached_at) < ttl_s:
            payload = cached.get("payload")
            if isinstance(payload, dict):
                return payload

    payload = _compute_user_activity(window_key, raw_window=raw_window, include_logs=include_logs)
    with _USER_ACTIVITY_CACHE_LOCK:
        _USER_ACTIVITY_CACHE[cache_key] = {"at": now, "payload": payload}
    return payload


def _compute_user_activity(window_key: str, *, raw_window: str | None = None, include_logs: bool = True) -> dict:
    logger = logging.getLogger("peppro.user_activity")
    cutoff = datetime.now(timezone.utc) - _window_delta(window_key)
    presence = presence_service.snapshot()
    # "Online right now" should reflect recent heartbeats (not a 45-minute window).
    online_threshold_s = float(os.environ.get("USER_PRESENCE_ONLINE_SECONDS") or 300)
    online_threshold_s = max(15.0, min(online_threshold_s, 60 * 60))
    # Match the frontend's default idle threshold (10 minutes), but keep it configurable.
    idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or (10 * 60))
    idle_threshold_s = max(60.0, min(idle_threshold_s, 6 * 60 * 60))
    now_epoch = time.time()

    if include_logs:
        print(
            f"[user-activity] window_raw={raw_window!r} window={window_key} cutoff={cutoff.isoformat()}",
            flush=True,
        )
        logger.info(
            "User activity requested",
            extra={
                "windowRaw": raw_window,
                "window": window_key,
                "cutoff": cutoff.isoformat(),
                "userId": (getattr(g, "current_user", None) or {}).get("id"),
            },
        )

    users = user_repository.list_recent_users_since(cutoff)
    recent: list[dict] = []
    live_users: list[dict] = []
    for user in users:
        user_id = str(user.get("id") or "").strip()
        if not user_id:
            continue
        presence_entry = presence.get(user_id)
        presence_public = presence_service.to_public_fields(presence_entry)
        persisted_seen_dt = _parse_iso_datetime(user.get("lastSeenAt") or None)
        persisted_interaction_dt = _parse_iso_datetime(user.get("lastInteractionAt") or None)
        persisted_login_dt = _parse_iso_datetime(user.get("lastLoginAt") or None)

        last_seen_epoch = None
        try:
            raw_seen = presence_entry.get("lastHeartbeatAt") if isinstance(presence_entry, dict) else None
            if isinstance(raw_seen, (int, float)) and float(raw_seen) > 0:
                last_seen_epoch = float(raw_seen)
        except Exception:
            last_seen_epoch = None
        if last_seen_epoch is None and persisted_seen_dt:
            last_seen_epoch = float(persisted_seen_dt.timestamp())

        last_interaction_epoch = None
        try:
            raw_interaction = presence_entry.get("lastInteractionAt") if isinstance(presence_entry, dict) else None
            if isinstance(raw_interaction, (int, float)) and float(raw_interaction) > 0:
                last_interaction_epoch = float(raw_interaction)
        except Exception:
            last_interaction_epoch = None
        if last_interaction_epoch is None and persisted_interaction_dt:
            last_interaction_epoch = float(persisted_interaction_dt.timestamp())

        is_online_db = bool(user.get("isOnline"))
        derived_online = bool(
            is_online_db
            and presence_service.is_recent_epoch(
                last_seen_epoch,
                now_epoch=now_epoch,
                threshold_s=online_threshold_s,
            )
        )

        session_start_epoch = float(persisted_login_dt.timestamp()) if persisted_login_dt else None
        session_age_s = (now_epoch - session_start_epoch) if session_start_epoch else None
        is_idle_flag = (
            bool(presence_entry.get("isIdle"))
            if isinstance(presence_entry, dict) and isinstance(presence_entry.get("isIdle"), bool)
            else None
        )

        idle_anchor_epoch = None
        if isinstance(last_interaction_epoch, (int, float)) and float(last_interaction_epoch) > 0:
            idle_anchor_epoch = float(last_interaction_epoch)
        elif isinstance(last_seen_epoch, (int, float)) and float(last_seen_epoch) > 0:
            idle_anchor_epoch = float(last_seen_epoch)
        elif session_start_epoch:
            idle_anchor_epoch = float(session_start_epoch)

        idle_age_s = (
            (now_epoch - float(idle_anchor_epoch))
            if isinstance(idle_anchor_epoch, (int, float)) and float(idle_anchor_epoch) > 0
            else None
        )

        computed_idle = False
        if derived_online:
            computed_idle = bool(is_idle_flag) or bool(idle_age_s is not None and idle_age_s >= idle_threshold_s)

        entry = {
            "id": user.get("id"),
            "name": user.get("name") or None,
            "email": user.get("email") or None,
            "role": str(user.get("role") or "").strip().lower() or "unknown",
            "isOnline": derived_online,
            "lastLoginAt": user.get("lastLoginAt") or None,
            "profileImageUrl": user.get("profileImageUrl") or None,
            **{
                "lastSeenAt": presence_public.get("lastSeenAt") or (user.get("lastSeenAt") or None),
                "lastInteractionAt": presence_public.get("lastInteractionAt") or (user.get("lastInteractionAt") or None),
                "isIdle": computed_idle if derived_online else False,
            },
        }

        if entry["isOnline"]:
            live_users.append(entry)

        last_login = _parse_iso_datetime(entry.get("lastLoginAt"))
        if not last_login or last_login < cutoff:
            continue
        recent.append(entry)

    recent.sort(
        key=lambda entry: _parse_iso_datetime(entry.get("lastLoginAt"))
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )

    live_users.sort(
        key=lambda entry: str(entry.get("name") or entry.get("email") or entry.get("id") or "").lower()
    )

    by_role: dict[str, int] = {}
    sig_recent: list[dict] = []
    for entry in recent:
        role = entry.get("role") or "unknown"
        by_role[role] = int(by_role.get(role, 0)) + 1
        sig_recent.append(
            {
                "id": entry.get("id"),
                "role": role,
                "isOnline": bool(entry.get("isOnline")),
                "isIdle": entry.get("isIdle") if isinstance(entry.get("isIdle"), bool) else None,
                "lastLoginAt": entry.get("lastLoginAt") or None,
                "profileImageUrl": entry.get("profileImageUrl") or None,
            }
        )

    # ETag should only reflect meaningful state changes (online/offline + logins),
    # not the moving cutoff timestamp.
    sig_live = [
        {
            "id": entry.get("id"),
            "role": entry.get("role") or "unknown",
            "isOnline": bool(entry.get("isOnline")),
            "isIdle": entry.get("isIdle") if isinstance(entry.get("isIdle"), bool) else None,
            "lastLoginAt": entry.get("lastLoginAt") or None,
            "profileImageUrl": entry.get("profileImageUrl") or None,
        }
        for entry in live_users
    ]
    sig_recent.sort(key=lambda entry: str(entry.get("id") or ""))
    sig_live.sort(key=lambda entry: str(entry.get("id") or ""))
    sig_payload = {"window": window_key, "recent": sig_recent, "live": sig_live}
    etag = hashlib.sha256(
        json.dumps(sig_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()

    if include_logs:
        print(
            f"[user-activity] matched={len(recent)} by_role={by_role}",
            flush=True,
        )
        logger.info(
            "User activity computed",
            extra={"matched": len(recent), "byRole": by_role, "window": window_key},
        )

    return {
        "window": window_key,
        "etag": etag,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "cutoff": cutoff.isoformat(),
        "liveUsers": live_users,
        "total": len(recent),
        "byRole": by_role,
        "users": recent,
    }
