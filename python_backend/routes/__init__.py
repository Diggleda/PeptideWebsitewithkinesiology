from __future__ import annotations

from flask import Flask
from flask_cors import CORS

from . import auth, integrations, orders, payments, referrals, system, woo, shipping, quotes, password_reset, contact, bugs, tool_requests, settings, catalog, forum, tracking, delegation, discount_codes, moderation, usage_tracking, presence, events


def _configure_cors(app: Flask, config) -> None:
    origins = config.cors_allow_list or ["*"]
    exposed_headers = [
        "Content-Disposition",
        "Content-Type",
        "Server-Timing",
        "X-TruFusion-Quote-Export-Ms",
        "X-TruFusion-Quote-Pdf-Ms",
        "X-TruFusion-Quote-Render-Ms",
        "X-TruFusion-Quote-Image-Ms",
        "X-TruFusion-Quote-Renderer",
        "X-TruFusion-Quote-Cache",
        "X-TruFusion-Quote-Pdf-Bytes",
        "X-TruFusion-Quote-Id",
        "X-Request-Id",
        "X-TruFusion-Route-Set",
    ]
    cors_config = {
        r"/api/*": {
            "origins": "*" if "*" in origins else origins,
            "supports_credentials": True,
            "expose_headers": exposed_headers,
            # Cache preflight responses in browsers to reduce OPTIONS load.
            # Especially important when the frontend polls auth endpoints frequently.
            "max_age": 600,
        }
    }
    CORS(app, resources=cors_config)


def register_blueprints(app: Flask, config) -> None:
    _configure_cors(app, config)

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
    app.register_blueprint(bugs.blueprint)
    app.register_blueprint(tool_requests.blueprint)
    app.register_blueprint(settings.blueprint)
    app.register_blueprint(forum.blueprint)
    app.register_blueprint(tracking.blueprint)
    app.register_blueprint(delegation.blueprint)
    app.register_blueprint(discount_codes.blueprint)
    app.register_blueprint(moderation.blueprint)
    app.register_blueprint(usage_tracking.blueprint)
    app.register_blueprint(events.blueprint)


def register_presence_blueprints(app: Flask, config) -> None:
    _configure_cors(app, config)

    app.register_blueprint(system.blueprint)
    app.register_blueprint(presence.blueprint)
    app.register_blueprint(events.blueprint)
