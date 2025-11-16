from __future__ import annotations

from flask import Flask
from flask_cors import CORS

from . import auth, integrations, orders, payments, referrals, system, woo


def register_blueprints(app: Flask, config) -> None:
    origins = config.cors_allow_list or ["*"]
    cors_config = {
        r"/api/*": {
            "origins": "*" if "*" in origins else origins,
            "supports_credentials": True,
        }
    }
    CORS(app, resources=cors_config)

    app.register_blueprint(auth.blueprint)
    app.register_blueprint(orders.blueprint)
    app.register_blueprint(referrals.blueprint)
    app.register_blueprint(payments.blueprint)
    app.register_blueprint(integrations.blueprint)
    app.register_blueprint(woo.blueprint)
    app.register_blueprint(system.blueprint)
