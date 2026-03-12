from __future__ import annotations

from flask import Blueprint, request

from ..services.catalog_snapshot_service import (
    get_catalog_categories,
    get_catalog_product_variations,
    get_catalog_products,
)
from ..utils.http import handle_action


blueprint = Blueprint("catalog", __name__, url_prefix="/api/catalog")


@blueprint.get("/products")
def list_catalog_products():
    def action():
        page = request.args.get("page", "1")
        per_page = request.args.get("per_page", request.args.get("perPage", "100"))
        return get_catalog_products(page=int(page), per_page=int(per_page))

    return handle_action(action)


@blueprint.get("/categories")
def list_catalog_categories():
    def action():
        return get_catalog_categories()

    return handle_action(action)


@blueprint.get("/products/<int:product_id>/variations")
def list_catalog_variations(product_id: int):
    def action():
        return get_catalog_product_variations(product_id)

    return handle_action(action)
