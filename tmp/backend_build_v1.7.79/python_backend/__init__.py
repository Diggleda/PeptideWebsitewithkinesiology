from flask import Flask

from .config import load_config
from .logging_config import configure_logging
from .storage import init_storage
from .routes import register_blueprints
from .services import configure_services
from .database import init_database
from .middleware.request_logging import init_request_logging


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

    # Ensure JSON storage files exist before serving requests.
    init_storage(config)

    init_request_logging(app)
    register_blueprints(app, config)

    return app
