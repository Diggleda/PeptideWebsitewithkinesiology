from __future__ import annotations

from flask import Blueprint, request, abort, Response, stream_with_context, jsonify, g
import base64
import os
import re

import requests
from urllib.parse import urlparse, urlunparse, quote

from ..middleware.auth import require_auth
from ..config import get_config
from ..integrations import woo_commerce, woo_commerce_webhook
from ..repositories import product_document_repository
from ..utils.http import json_error
from ..utils.security import verify_woocommerce_webhook_signature


blueprint = Blueprint("woo", __name__, url_prefix="/api/woo")

# Certificate uploads are sent as base64 (data URL) via JSON; base64 adds ~33% overhead.
# Keep the binary limit reasonably high for scanned COAs while still preventing abuse.
_COA_MAX_BYTES = int(os.environ.get("COA_MAX_BYTES", str(20 * 1024 * 1024)))  # 20MB default

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


@blueprint.get("/certificates/missing")
@require_auth
def list_missing_certificates():
    from ..utils.http import handle_action

    def action():
        _require_admin()
        rows = product_document_repository.list_missing_documents(
            kind=product_document_repository.DEFAULT_KIND_COA,
            limit=5000,
        )
        products = [
            {
                "wooProductId": int(row.get("woo_product_id")),
                "name": row.get("product_name") or None,
                "sku": row.get("product_sku") or None,
            }
            for row in rows
            if row and row.get("woo_product_id") is not None
        ]
        return {"products": products, "count": len(products)}

    return handle_action(action)

@blueprint.get("/certificates/products")
@require_auth
def list_certificate_products():
    from ..utils.http import handle_action

    def action():
        _require_admin()
        rows = product_document_repository.list_documents(
            kind=product_document_repository.DEFAULT_KIND_COA,
            limit=20000,
        )
        products = []
        missing_count = 0
        for row in rows:
            if not row or row.get("woo_product_id") is None:
                continue
            sha256 = str(row.get("sha256") or "").strip()
            data_bytes = row.get("data_bytes")
            bytes_value = int(data_bytes) if isinstance(data_bytes, (int, float)) else None
            has_certificate = bool(sha256 and isinstance(bytes_value, int) and bytes_value > 0)
            if not has_certificate:
                missing_count += 1
            products.append(
                {
                    "wooProductId": int(row.get("woo_product_id")),
                    "name": row.get("product_name") or None,
                    "sku": row.get("product_sku") or None,
                    "hasCertificate": has_certificate,
                    "filename": row.get("filename") or None,
                    "bytes": bytes_value,
                    "updatedAt": row.get("updated_at") or None,
                }
            )
        return {
            "products": products,
            "count": len(products),
            "missingCount": missing_count,
        }

    return handle_action(action)


def _is_admin() -> bool:
    role = str((getattr(g, "current_user", None) or {}).get("role") or "").lower()
    return role == "admin"


def _require_admin():
    if not _is_admin():
        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err


def _parse_data_url_or_base64(value: str) -> tuple[bytes, str | None]:
    raw = str(value or "").strip()
    if not raw:
        err = ValueError("Document payload is required")
        setattr(err, "status", 400)
        raise err

    if raw.startswith("data:"):
        match = re.match(r"^data:([^;]+);base64,(.+)$", raw, re.IGNORECASE | re.DOTALL)
        if not match:
            err = ValueError("Invalid data URL")
            setattr(err, "status", 400)
            raise err
        mime = match.group(1).strip() or None
        b64 = match.group(2).strip()
    else:
        mime = None
        b64 = raw

    try:
        decoded = base64.b64decode(b64, validate=True)
    except Exception:
        err = ValueError("Invalid base64 document payload")
        setattr(err, "status", 400)
        raise err

    return decoded, mime


@blueprint.get("/products/<int:product_id>/certificate-of-analysis")
@require_auth
def get_certificate_of_analysis(product_id: int):
    from ..utils.http import handle_action

    def action():
        row = product_document_repository.get_document(
            int(product_id),
            kind=product_document_repository.DEFAULT_KIND_COA,
        )
        if not row:
            err = RuntimeError("Certificate of analysis not found")
            setattr(err, "status", 404)
            raise err

        sha256 = str(row.get("sha256") or "").strip()
        etag = f"\"{sha256}\"" if sha256 else None
        if etag and request.headers.get("If-None-Match") == etag:
            return Response(status=304)

        data = row.get("data") or b""
        if not isinstance(data, (bytes, bytearray)) or len(data) == 0:
            err = RuntimeError("Certificate of analysis not found")
            setattr(err, "status", 404)
            raise err

        filename = row.get("filename") or "certificate-of-analysis.png"
        mime_type = row.get("mime_type") or "image/png"

        response = Response(bytes(data), status=200)
        response.headers["Content-Type"] = mime_type
        response.headers["Content-Disposition"] = f'inline; filename="{filename}"'
        response.headers["Cache-Control"] = "private, max-age=300"
        if etag:
            response.headers["ETag"] = etag
        return response

    return handle_action(action)


@blueprint.get("/products/<int:product_id>/certificate-of-analysis/info")
@require_auth
def get_certificate_of_analysis_info(product_id: int):
    from ..utils.http import handle_action

    def action():
        row = product_document_repository.get_document_metadata(
            int(product_id),
            kind=product_document_repository.DEFAULT_KIND_COA,
        )
        if not row:
            return {
                "wooProductId": int(product_id),
                "exists": False,
                "filename": None,
                "mimeType": None,
                "bytes": None,
                "updatedAt": None,
                "sha256": None,
            }

        sha256 = str(row.get("sha256") or "").strip() or None
        data_bytes = row.get("data_bytes")
        bytes_value = int(data_bytes) if isinstance(data_bytes, (int, float)) else None
        exists = bool(bytes_value and bytes_value > 0 and sha256)
        return {
            "wooProductId": int(row.get("woo_product_id") or product_id),
            "exists": exists,
            "filename": row.get("filename") or None,
            "mimeType": row.get("mime_type") or None,
            "bytes": bytes_value,
            "updatedAt": row.get("updated_at") or None,
            "sha256": sha256,
        }

    return handle_action(action)


@blueprint.post("/products/<int:product_id>/certificate-of-analysis")
@require_auth
def upsert_certificate_of_analysis(product_id: int):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        _require_admin()
        data_raw = payload.get("data") or payload.get("dataBase64") or payload.get("dataUrl")
        decoded, mime_from_payload = _parse_data_url_or_base64(str(data_raw or ""))
        if len(decoded) > _COA_MAX_BYTES:
            max_mb = round(_COA_MAX_BYTES / (1024 * 1024), 2)
            err = ValueError(f"Document is too large (max {max_mb} MB). Please upload a smaller PNG.")
            setattr(err, "status", 413)
            raise err

        filename = payload.get("filename") if isinstance(payload.get("filename"), str) else None
        mime_type = payload.get("mimeType") if isinstance(payload.get("mimeType"), str) else None
        mime = (mime_type or mime_from_payload or "image/png").strip()
        if not mime:
            mime = "image/png"

        saved = product_document_repository.upsert_document(
            woo_product_id=int(product_id),
            data=decoded,
            kind=product_document_repository.DEFAULT_KIND_COA,
            mime_type=mime,
            filename=filename,
        )
        return {"ok": True, "document": saved}

    from ..utils.http import handle_action

    return handle_action(action, status=201)


@blueprint.delete("/products/<int:product_id>/certificate-of-analysis")
@require_auth
def delete_certificate_of_analysis(product_id: int):
    def action():
        _require_admin()
        meta = product_document_repository.get_document_metadata(
            int(product_id),
            kind=product_document_repository.DEFAULT_KIND_COA,
        )
        sha256 = str((meta or {}).get("sha256") or "").strip()
        data_bytes = (meta or {}).get("data_bytes")
        had_payload = bool(sha256 and isinstance(data_bytes, (int, float)) and int(data_bytes) > 0)
        if meta:
            product_document_repository.clear_document_payload(
                int(product_id),
                kind=product_document_repository.DEFAULT_KIND_COA,
            )
        return {"ok": True, "deleted": bool(had_payload)}

    from ..utils.http import handle_action

    return handle_action(action)
