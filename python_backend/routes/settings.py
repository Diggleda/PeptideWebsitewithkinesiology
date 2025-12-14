from __future__ import annotations

from flask import Blueprint, request, g

from ..middleware.auth import require_auth
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
