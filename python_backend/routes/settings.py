from __future__ import annotations

from datetime import datetime, timedelta, timezone
import logging

from flask import Blueprint, request, g

from ..middleware.auth import require_auth
from ..repositories import user_repository
from ..services import get_config
from ..services import settings_service  # type: ignore[attr-defined]
from ..utils.http import handle_action

blueprint = Blueprint("settings", __name__, url_prefix="/api/settings")

def _is_admin() -> bool:
    role = str((getattr(g, "current_user", None) or {}).get("role") or "").lower()
    return role == "admin"


def _require_admin():
    if not _is_admin():
        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err


@blueprint.get("/shop")
def get_shop():
    def action():
        settings = settings_service.get_settings()
        return {"shopEnabled": bool(settings.get("shopEnabled", True))}

    return handle_action(action)


@blueprint.put("/shop")
@require_auth
def update_shop():
    def action():
        _require_admin()
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        settings_service.update_settings({"shopEnabled": enabled})
        return {"shopEnabled": enabled}

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


@blueprint.get("/user-activity")
@require_auth
def get_user_activity():
    def action():
        _require_admin()
        logger = logging.getLogger("peppro.user_activity")

        raw_window = request.args.get("window")
        window_key = _parse_activity_window(raw_window)
        cutoff = datetime.now(timezone.utc) - _window_delta(window_key)

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

        users = user_repository.get_all()
        recent: list[dict] = []
        for user in users:
            last_login = _parse_iso_datetime(user.get("lastLoginAt"))
            if not last_login or last_login < cutoff:
                continue
            recent.append(
                {
                    "id": user.get("id"),
                    "name": user.get("name") or None,
                    "email": user.get("email") or None,
                    "role": str(user.get("role") or "").strip().lower() or "unknown",
                    "lastLoginAt": user.get("lastLoginAt") or None,
                }
            )

        recent.sort(
            key=lambda entry: _parse_iso_datetime(entry.get("lastLoginAt")) or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )

        by_role: dict[str, int] = {}
        for entry in recent:
            role = entry.get("role") or "unknown"
            by_role[role] = int(by_role.get(role, 0)) + 1

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
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "cutoff": cutoff.isoformat(),
            "total": len(recent),
            "byRole": by_role,
            "users": recent,
        }

    return handle_action(action)
