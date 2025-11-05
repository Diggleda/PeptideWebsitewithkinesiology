from __future__ import annotations

from flask import Blueprint

from ..services import get_config
from ..services import news_service
from ..integrations import ship_engine, woo_commerce
from ..utils.http import handle_action

blueprint = Blueprint("system", __name__, url_prefix="/api")


@blueprint.get("/health")
def health():
    def action():
        config = get_config()
        return {
            "status": "ok",
            "message": "Server is running",
            "build": config.backend_build,
            "timestamp": _now(),
        }

    return handle_action(action)


@blueprint.get("/help")
def help_endpoint():
    def action():
        config = get_config()
        return {
            "ok": True,
            "service": "Protixa Backend",
            "build": config.backend_build,
            "integrations": {
                "wooCommerce": {"configured": woo_commerce.is_configured()},
                "shipEngine": {"configured": ship_engine.is_configured()},
            },
            "endpoints": [
                "/api/auth/login",
                "/api/auth/register",
                "/api/auth/me",
                "/api/auth/check-email",
                "/api/orders",
                "/api/referrals/doctor/summary",
                "/api/referrals/admin/dashboard",
                "/api/integrations/google-sheets/sales-reps",
                "/api/help",
                "/api/news/peptides",
                "/api/health",
            ],
            "timestamp": _now(),
        }

    return handle_action(action)


def _now():
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


@blueprint.get("/news/peptides")
def peptide_news():
    def action():
        items = news_service.fetch_peptide_news(limit=8)
        return {
            "items": [
                {
                    "title": item.title,
                    "url": item.url,
                    "summary": item.summary,
                    "imageUrl": item.image_url,
                    "date": item.date,
                }
                for item in items
            ],
            "count": len(items),
        }

    return handle_action(action)
