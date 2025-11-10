from __future__ import annotations

from flask import Blueprint, request

from ..integrations import woo_commerce
from ..utils.http import handle_action


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
