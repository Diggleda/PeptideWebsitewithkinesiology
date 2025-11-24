from __future__ import annotations

from flask import Blueprint, request, abort

from ..config import get_config
from ..integrations import woo_commerce, woo_commerce_webhook
from ..utils.http import handle_action
from ..utils.security import verify_woocommerce_webhook_signature


blueprint = Blueprint("woo", __name__, url_prefix="/api/woo")


@blueprint.get("/products")
def list_products():
    def action():
        # Forward selected query params to Woo (per_page, page, status, search, etc.)
        return woo_commerce.fetch_catalog("products", request.args)

    return handle_action(action)


@blueprint.get("/products/categories")
def list_categories():
    def action():
        return woo_commerce.fetch_catalog("products/categories", request.args)

    return handle_action(action)


@blueprint.get("/products/<int:product_id>/variations")
def list_product_variations(product_id: int):
    def action():
        endpoint = f"products/{product_id}/variations"
        return woo_commerce.fetch_catalog(endpoint, request.args)

    return handle_action(action)


@blueprint.post("/webhook")
def handle_webhook():
    def action():
        signature = request.headers.get("X-WC-Webhook-Signature")
        secret = get_config().woo_commerce.get("webhook_secret")

        if not secret:
            abort(500, "Webhook secret is not configured")

        if not verify_woocommerce_webhook_signature(request.data, signature, secret):
            abort(401, "Invalid webhook signature")

        return woo_commerce_webhook.handle_event(request.get_json())

    return handle_action(action)
