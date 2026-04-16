from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from flask import Flask


_LOGGER = logging.getLogger(__name__)


def _resolve_web_background_jobs_mode() -> str:
    raw = str(os.environ.get("PEPPRO_WEB_BACKGROUND_JOBS_MODE") or "").strip().lower()
    if raw in {"", "thread", "threads", "web", "inprocess", "1", "true", "yes", "on", "enabled"}:
        return "thread"
    if raw in {"external", "off", "false", "no", "disabled"}:
        return "external"
    return "thread"


def _build_app(*, route_set: str) -> "Flask":
    """
    Shared application factory used by the full API and the long-poll presence app.
    """
    from .config import load_config
    from .database import init_database
    from .logging_config import configure_logging
    from .middleware.rate_limit import init_rate_limit
    from .middleware.request_logging import init_request_logging
    from .middleware.shadow_mode import init_shadow_mode
    from .repositories import sales_prospect_repository, user_repository
    from .routes import register_blueprints, register_presence_blueprints
    from .services import configure_services
    from .services.patient_links_sweep_service import start_patient_links_sweep
    from .services.presence_sweep_service import start_presence_sweep
    from .services.product_document_sync_service import start_product_document_sync
    from .services.shipstation_status_sync_service import start_shipstation_status_sync
    from .services.ups_status_sync_service import start_ups_status_sync
    from .storage import init_storage

    config = load_config()

    configure_logging(config)

    from flask import Flask

    app = Flask(__name__)
    app.config.update(config.flask_settings)
    app.config["PORT"] = config.port
    app.config["DEBUG"] = not config.is_production
    app.config["APP_CONFIG"] = config
    app.config["APP_ROUTE_SET"] = route_set
    app.config["WEB_BACKGROUND_JOBS_MODE"] = _resolve_web_background_jobs_mode()

    configure_services(config)
    init_database(config)
    if route_set == "full":
        try:
            sales_prospect_repository.ensure_house_sales_rep_for_contact_forms()
        except Exception:
            pass
        try:
            user_repository.backfill_contact_form_lead_types()
        except Exception:
            pass
        if app.config["WEB_BACKGROUND_JOBS_MODE"] == "thread":
            start_product_document_sync()
            start_shipstation_status_sync()
            start_ups_status_sync()
            start_presence_sweep()
            start_patient_links_sweep()
            _LOGGER.info("Web process background jobs enabled")
        else:
            _LOGGER.info("Web process background jobs disabled; use python -m python_backend.background_jobs")
    else:
        app.config["WEB_BACKGROUND_JOBS_MODE"] = "external"
        _LOGGER.info("Presence app booting with dedicated long-poll routes only")

    # Ensure JSON storage files exist before serving requests.
    init_storage(config)

    init_request_logging(app)
    init_rate_limit(app)
    init_shadow_mode(app)
    if route_set == "presence":
        register_presence_blueprints(app, config)
    else:
        register_blueprints(app, config)

    return app


def create_app() -> "Flask":
    """
    Full application factory used by the main API service.
    """
    return _build_app(route_set="full")


def create_presence_app() -> "Flask":
    """
    Lightweight application factory used by the long-poll presence service.
    """
    return _build_app(route_set="presence")
