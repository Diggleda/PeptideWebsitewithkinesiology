from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services.catalog_snapshot_service import (
    get_catalog_categories,
    get_catalog_product,
    get_catalog_product_variations,
    get_catalog_products,
)
from ..services import product_recommendation_service
from ..utils.http import handle_action


blueprint = Blueprint("catalog", __name__, url_prefix="/api/catalog")


@blueprint.get("/products")
def list_catalog_products():
    def action():
        page = request.args.get("page", "1")
        per_page = request.args.get("per_page", request.args.get("perPage", "100"))
        return get_catalog_products(page=int(page), per_page=int(per_page))

    return handle_action(action)


@blueprint.get("/recommendations")
@require_auth
def list_catalog_recommendations():
    def action():
        raw_limit = request.args.get("limit") or "100"
        try:
            limit = int(raw_limit)
        except Exception:
            limit = 100
        return product_recommendation_service.get_recommendations(
            getattr(g, "current_user", None) or {},
            limit=limit,
            shadow_active=bool(getattr(g, "shadow_context", None)),
        )

    return handle_action(action)


@blueprint.post("/events")
@require_auth
def track_catalog_product_event():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        return product_recommendation_service.track_product_event(
            getattr(g, "current_user", None) or {},
            payload if isinstance(payload, dict) else {},
            shadow_active=bool(getattr(g, "shadow_context", None)),
        )

    return handle_action(action, status=201)


@blueprint.get("/products/<int:product_id>")
def get_catalog_product_detail(product_id: int):
    def action():
        return get_catalog_product(product_id)

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
