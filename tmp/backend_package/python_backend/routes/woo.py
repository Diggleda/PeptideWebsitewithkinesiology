from __future__ import annotations

from flask import Blueprint, request, abort, Response, stream_with_context

import requests
from urllib.parse import urlparse, urlunparse, quote

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


def _allowed_media_hosts() -> set[str]:
    config = get_config()
    store_url = (config.woo_commerce.get("store_url") or "").strip()
    if not store_url:
        return set()
    try:
        parsed = urlparse(store_url)
        if parsed.hostname:
            return {parsed.hostname}
    except ValueError:
        return set()
    return set()


def _sanitize_media_url(raw: str | None) -> str | None:
    if not raw:
        return None
    candidate = raw.strip()
    if not candidate:
        return None
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return None

    if parsed.scheme not in ("http", "https"):
        return None
    if parsed.hostname not in _allowed_media_hosts():
        return None

    encoded_path = "/".join(quote(part, safe="") for part in parsed.path.split("/"))
    sanitized = parsed._replace(scheme="https", path=encoded_path)
    return urlunparse(sanitized)


@blueprint.route("/media", methods=["GET"])
def proxy_media():
    source = _sanitize_media_url(request.args.get("src"))
    if not source:
        abort(400, "Invalid media source")

    try:
        upstream = requests.get(source, stream=True, timeout=15)
    except requests.RequestException:
        abort(502, "Failed to fetch media")

    if upstream.status_code == 404:
        abort(404)
    if upstream.status_code >= 400:
        abort(upstream.status_code)

    def _generate():
        try:
            for chunk in upstream.iter_content(chunk_size=8192):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    response = Response(stream_with_context(_generate()), status=upstream.status_code)
    content_type = upstream.headers.get("Content-Type")
    if content_type:
        response.headers["Content-Type"] = content_type
    response.headers["Cache-Control"] = "public, max-age=300"
    return response
