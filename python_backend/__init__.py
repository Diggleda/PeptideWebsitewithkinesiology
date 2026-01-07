from flask import Flask

from .config import load_config
from .logging_config import configure_logging
from .storage import init_storage
from .routes import register_blueprints
from .services import configure_services
from .services.product_document_sync_service import start_product_document_sync
from .database import init_database
from .middleware.request_logging import init_request_logging
from .middleware.rate_limit import init_rate_limit
from .repositories import sales_prospect_repository


def create_app() -> Flask:
    """
    Application factory used by both local development and cPanel's WSGI loader.
    """
    config = load_config()

    configure_logging(config)

    app = Flask(__name__)
    app.config.update(config.flask_settings)
    app.config["PORT"] = config.port
    app.config["DEBUG"] = not config.is_production
    app.config["APP_CONFIG"] = config

    configure_services(config)
    init_database(config)
    try:
        sales_prospect_repository.ensure_house_sales_rep_for_contact_forms()
    except Exception:
        pass
    start_product_document_sync()

    # Ensure JSON storage files exist before serving requests.
    init_storage(config)

    init_request_logging(app)
    init_rate_limit(app)
    register_blueprints(app, config)

    return app
