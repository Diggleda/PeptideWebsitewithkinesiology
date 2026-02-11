from __future__ import annotations

from flask import Flask
from flask_cors import CORS

from . import auth, integrations, orders, payments, referrals, system, woo, shipping, quotes, password_reset, contact, settings, catalog, forum, tracking, delegation, discount_codes, moderation


def register_blueprints(app: Flask, config) -> None:
    origins = config.cors_allow_list or ["*"]
    cors_config = {
        r"/api/*": {
            "origins": "*" if "*" in origins else origins,
            "supports_credentials": True,
            # Cache preflight responses in browsers to reduce OPTIONS load.
            # Especially important when the frontend polls auth endpoints frequently.
            "max_age": 600,
        }
    }
    CORS(app, resources=cors_config)

    app.register_blueprint(auth.blueprint)
    app.register_blueprint(orders.blueprint)
    app.register_blueprint(referrals.blueprint)
    app.register_blueprint(payments.blueprint)
    app.register_blueprint(integrations.blueprint)
    app.register_blueprint(woo.blueprint)
    app.register_blueprint(catalog.blueprint)
    app.register_blueprint(shipping.blueprint)
    app.register_blueprint(quotes.blueprint)
    app.register_blueprint(system.blueprint)
    app.register_blueprint(password_reset.blueprint)
    app.register_blueprint(contact.blueprint)
    app.register_blueprint(settings.blueprint)
    app.register_blueprint(forum.blueprint)
    app.register_blueprint(tracking.blueprint)
    app.register_blueprint(delegation.blueprint)
    app.register_blueprint(discount_codes.blueprint)
    app.register_blueprint(moderation.blueprint)
