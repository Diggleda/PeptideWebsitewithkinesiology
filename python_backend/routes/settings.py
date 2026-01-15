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
from ..services import get_config
from ..services import presence_service
from ..services import settings_service  # type: ignore[attr-defined]
from ..utils.http import handle_action

blueprint = Blueprint("settings", __name__, url_prefix="/api/settings")

_USER_ACTIVITY_CACHE_LOCK = threading.Lock()
_USER_ACTIVITY_CACHE: dict[str, dict] = {}
_USER_ACTIVITY_LONGPOLL_CONCURRENCY = int(os.environ.get("USER_ACTIVITY_LONGPOLL_CONCURRENCY") or 4)
_USER_ACTIVITY_LONGPOLL_CONCURRENCY = max(1, min(_USER_ACTIVITY_LONGPOLL_CONCURRENCY, 20))
_USER_ACTIVITY_LONGPOLL_SEMAPHORE = threading.BoundedSemaphore(_USER_ACTIVITY_LONGPOLL_CONCURRENCY)

def _is_admin() -> bool:
    role = str((getattr(g, "current_user", None) or {}).get("role") or "").lower()
    return role == "admin"


def _require_admin():
    if not _is_admin():
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
        return {"ok": True}

    return handle_action(action)


@blueprint.get("/users/<user_id>")
@require_auth
def get_user_profile(user_id: str):
    def action():
        _require_admin()
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
        return {"user": _public_user_profile(user)}

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
        return {
            "salesBySalesRepCsvDownloadedAt": downloaded_at if isinstance(downloaded_at, str) else None
        }

    return handle_action(action)


@blueprint.put("/reports")
@require_auth
def update_reports():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        raw = payload.get("salesBySalesRepCsvDownloadedAt") or payload.get("downloadedAt")
        parsed = _parse_iso_datetime(raw if isinstance(raw, str) else None)
        stamp = (
            parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            if parsed
            else datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        )
        updated = settings_service.update_settings({"salesBySalesRepCsvDownloadedAt": stamp})
        return {"salesBySalesRepCsvDownloadedAt": updated.get("salesBySalesRepCsvDownloadedAt")}

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
    idle_threshold_s = float(os.environ.get("USER_PRESENCE_IDLE_SECONDS") or 60)
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
        presence_entry = presence.get(str(user.get("id") or ""))
        presence_public = presence_service.to_public_fields(presence_entry)
        last_interaction_epoch = None
        last_seen_epoch = None
        try:
            if presence_entry and presence_entry.get("lastInteractionAt"):
                last_interaction_epoch = float(presence_entry.get("lastInteractionAt"))
        except Exception:
            last_interaction_epoch = None
        try:
            if presence_entry and presence_entry.get("lastHeartbeatAt"):
                last_seen_epoch = float(presence_entry.get("lastHeartbeatAt"))
        except Exception:
            last_seen_epoch = None
        is_idle_flag = (
            bool(presence_entry.get("isIdle"))
            if presence_entry and isinstance(presence_entry.get("isIdle"), bool)
            else None
        )
        basis_epoch = None
        if isinstance(last_interaction_epoch, (int, float)) and last_interaction_epoch > 0:
            basis_epoch = last_interaction_epoch
        elif isinstance(last_seen_epoch, (int, float)) and last_seen_epoch > 0:
            basis_epoch = last_seen_epoch
        else:
            last_login_dt = _parse_iso_datetime(user.get("lastLoginAt") or None)
            if last_login_dt:
                try:
                    basis_epoch = float(last_login_dt.timestamp())
                except Exception:
                    basis_epoch = None

        computed_idle = bool(is_idle_flag)
        if not computed_idle and isinstance(basis_epoch, (int, float)) and basis_epoch > 0:
            computed_idle = (now_epoch - basis_epoch) >= idle_threshold_s
        entry = {
            "id": user.get("id"),
            "name": user.get("name") or None,
            "email": user.get("email") or None,
            "role": str(user.get("role") or "").strip().lower() or "unknown",
            "isOnline": bool(user.get("isOnline")),
            "lastLoginAt": user.get("lastLoginAt") or None,
            "profileImageUrl": user.get("profileImageUrl") or None,
            **presence_public,
        }
        if entry["isOnline"]:
            entry["isIdle"] = computed_idle if isinstance(computed_idle, bool) else False

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
