from __future__ import annotations

from flask import Blueprint, request, abort, Response, stream_with_context, jsonify

import requests
from urllib.parse import urlparse, urlunparse, quote

from ..config import get_config
from ..integrations import woo_commerce, woo_commerce_webhook
from ..utils.http import json_error
from ..utils.security import verify_woocommerce_webhook_signature


blueprint = Blueprint("woo", __name__, url_prefix="/api/woo")

def _json_with_cache_headers(data, *, cache: str, ttl_seconds: int, no_store: bool = False) -> Response:
    response = jsonify(data)
    if no_store:
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers["Cache-Control"] = f"public, max-age={ttl_seconds}"
    response.headers["X-PepPro-Cache"] = cache
    return response


@blueprint.get("/products")
def list_products():
    try:
        data, meta = woo_commerce.fetch_catalog_proxy("products", request.args)
        return _json_with_cache_headers(
            data,
            cache=str(meta.get("cache") or "MISS"),
            ttl_seconds=int(meta.get("ttlSeconds") or 60),
            no_store=bool(meta.get("noStore")),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return json_error(exc)


@blueprint.get("/products/categories")
def list_categories():
    try:
        data, meta = woo_commerce.fetch_catalog_proxy("products/categories", request.args)
        return _json_with_cache_headers(
            data,
            cache=str(meta.get("cache") or "MISS"),
            ttl_seconds=int(meta.get("ttlSeconds") or 60),
            no_store=bool(meta.get("noStore")),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return json_error(exc)


@blueprint.get("/products/<int:product_id>/variations")
def list_product_variations(product_id: int):
    try:
        endpoint = f"products/{product_id}/variations"
        data, meta = woo_commerce.fetch_catalog_proxy(endpoint, request.args)
        return _json_with_cache_headers(
            data,
            cache=str(meta.get("cache") or "MISS"),
            ttl_seconds=int(meta.get("ttlSeconds") or 60),
            no_store=bool(meta.get("noStore")),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return json_error(exc)


@blueprint.get("/products/<int:product_id>")
def get_product(product_id: int):
    try:
        endpoint = f"products/{product_id}"
        data, meta = woo_commerce.fetch_catalog_proxy(endpoint, request.args)
        return _json_with_cache_headers(
            data,
            cache=str(meta.get("cache") or "MISS"),
            ttl_seconds=int(meta.get("ttlSeconds") or 60),
            no_store=bool(meta.get("noStore")),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return json_error(exc)


@blueprint.get("/products/<int:product_id>/variations/<int:variation_id>")
def get_product_variation(product_id: int, variation_id: int):
    try:
        endpoint = f"products/{product_id}/variations/{variation_id}"
        data, meta = woo_commerce.fetch_catalog_proxy(endpoint, request.args)
        return _json_with_cache_headers(
            data,
            cache=str(meta.get("cache") or "MISS"),
            ttl_seconds=int(meta.get("ttlSeconds") or 60),
            no_store=bool(meta.get("noStore")),
        )
    except Exception as exc:  # pragma: no cover - defensive
        return json_error(exc)


@blueprint.post("/webhook")
def handle_webhook():
    try:
        signature = request.headers.get("X-WC-Webhook-Signature")
        secret = get_config().woo_commerce.get("webhook_secret")

        if not secret:
            abort(500, "Webhook secret is not configured")

        if not verify_woocommerce_webhook_signature(request.data, signature, secret):
            abort(401, "Invalid webhook signature")

        payload = woo_commerce_webhook.handle_event(request.get_json())
        return jsonify(payload)
    except Exception as exc:  # pragma: no cover - defensive
        return json_error(exc)


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

    # Force HTTPS and encode each path segment to avoid traversal quirks.
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
