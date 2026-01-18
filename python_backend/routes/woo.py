from __future__ import annotations

from flask import Blueprint, request, abort, Response, stream_with_context, jsonify, g
import base64
import hashlib
import json
import os
import re
import threading
import time
from pathlib import Path
import hmac

import requests
from urllib.parse import urlparse, urlunparse, quote
from logging import getLogger

from ..middleware.auth import require_auth
from ..config import get_config
from ..integrations import woo_commerce, woo_commerce_webhook
from ..repositories import product_document_repository
from ..utils.http import handle_action, json_error
from ..utils.security import verify_woocommerce_webhook_signature


blueprint = Blueprint("woo", __name__, url_prefix="/api/woo")
logger = getLogger(__name__)

# Certificate uploads are sent as base64 (data URL) via JSON; base64 adds ~33% overhead.
# Keep the binary limit reasonably high for scanned COAs while still preventing abuse.
_COA_MAX_BYTES = int(os.environ.get("COA_MAX_BYTES", str(20 * 1024 * 1024)))  # 20MB default
_WOO_MEDIA_FETCH_CONCURRENCY = int(os.environ.get("WOO_MEDIA_FETCH_CONCURRENCY") or 6)
_WOO_MEDIA_FETCH_CONCURRENCY = max(1, min(_WOO_MEDIA_FETCH_CONCURRENCY, 32))
_WOO_MEDIA_FETCH_SEMAPHORE = threading.BoundedSemaphore(_WOO_MEDIA_FETCH_CONCURRENCY)


def _with_publish_status(args) -> dict:
    """
    The Woo REST API can return non-public products when authenticated.
    These `/api/woo/*` endpoints are exposed to the storefront; always constrain to published products.
    """
    params = dict(args or {})
    params["status"] = "publish"
    return params


def _reject_if_not_published(payload) -> None:
    if isinstance(payload, dict):
        status = str(payload.get("status") or "").strip().lower()
        if status and status != "publish":
            err = RuntimeError("NOT_FOUND")
            setattr(err, "status", 404)
            raise err


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
        data, meta = woo_commerce.fetch_catalog_proxy("products", _with_publish_status(request.args))
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
        data, meta = woo_commerce.fetch_catalog_proxy(endpoint, _with_publish_status(request.args))
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
        data, meta = woo_commerce.fetch_catalog_proxy(endpoint, _with_publish_status(request.args))
        _reject_if_not_published(data)
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
        data, meta = woo_commerce.fetch_catalog_proxy(endpoint, _with_publish_status(request.args))
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
    def action():
        signature = request.headers.get("X-WC-Webhook-Signature")
        secret = get_config().woo_commerce.get("webhook_secret")

        if not secret:
            abort(500, "Webhook secret is not configured")

        signature_verified = False
        if not signature:
            # Some proxies/CDNs can strip custom headers. As a fallback, allow a query token
            # (or header) that matches the configured webhook secret.
            token = (request.args.get("token") or "").strip()
            token_header = (request.headers.get("X-PepPro-Webhook-Token") or "").strip()
            if (token and hmac.compare_digest(token, secret)) or (token_header and hmac.compare_digest(token_header, secret)):
                logger.warning(
                    "Woo webhook accepted via token fallback (missing signature header)",
                    extra={"path": request.path},
                )
                signature_verified = True
            else:
                logger.warning("Woo webhook missing signature header", extra={"path": request.path})
                abort(400, "Missing webhook signature")

        if not signature_verified and not verify_woocommerce_webhook_signature(request.data, signature, secret):
            logger.warning(
                "Woo webhook signature verification failed",
                extra={
                    "path": request.path,
                    "signaturePrefix": str(signature)[:12] if signature else None,
                    "contentType": request.headers.get("Content-Type"),
                    "contentLength": request.headers.get("Content-Length"),
                },
            )
            abort(401, "Invalid webhook signature")

        event = request.get_json(silent=True)
        if event is None and request.data:
            try:
                event = json.loads(request.data.decode("utf-8"))
            except Exception:
                event = None
        if not isinstance(event, dict):
            # Some WooCommerce admin screens "ping" the Delivery URL without a JSON body.
            # Treat an empty/non-JSON payload as a no-op success so the webhook can be saved,
            # while still requiring auth (signature or token).
            if not request.data or len(request.data) == 0:
                logger.info(
                    "Woo webhook ping received (empty payload)",
                    extra={"path": request.path},
                )
                return {"status": "ok", "reason": "ping"}
            logger.warning(
                "Woo webhook payload not JSON object",
                extra={
                    "path": request.path,
                    "contentType": request.headers.get("Content-Type"),
                    "contentLength": request.headers.get("Content-Length"),
                },
            )
            abort(400, "Invalid webhook payload")

        billing_email = None
        try:
            billing_email = (event.get("billing") or {}).get("email")
            billing_email = billing_email.strip().lower() if isinstance(billing_email, str) else None
        except Exception:
            billing_email = None

        payload = woo_commerce_webhook.handle_event(event)
        try:
            logger.info(
                "Woo webhook processed",
                extra={
                    "path": request.path,
                    "topic": request.headers.get("X-WC-Webhook-Topic"),
                    "resource": request.headers.get("X-WC-Webhook-Resource"),
                    "event": request.headers.get("X-WC-Webhook-Event"),
                    "deliveryId": request.headers.get("X-WC-Webhook-Delivery-ID"),
                    "orderId": event.get("id"),
                    "orderStatus": event.get("status"),
                    "billingEmail": billing_email,
                    "result": payload,
                },
            )
        except Exception:
            pass

        # Keep webhook handler lightweight; do not trigger extra Woo API calls here.
        return payload

    # Use shared handler to ensure 4xx/5xx are logged with useful context.
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

    # Force HTTPS and encode each path segment to avoid traversal quirks.
    encoded_path = "/".join(quote(part, safe="") for part in parsed.path.split("/"))
    sanitized = parsed._replace(scheme="https", path=encoded_path)
    return urlunparse(sanitized)

def _media_cache_paths(source: str) -> tuple[Path, Path]:
    config = get_config()
    cache_root = Path(getattr(config, "data_dir", None) or "server-data") / "woo-media-cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(source.encode("utf-8")).hexdigest()
    return cache_root / f"{key}.bin", cache_root / f"{key}.json"

def _read_cached_media(meta_path: Path, data_path: Path) -> tuple[bytes, str | None] | None:
    try:
        if not meta_path.exists() or not data_path.exists():
            return None
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        expires_at = float(meta.get("expiresAt") or 0)
        if expires_at and expires_at < time.time():
            return None
        content_type = str(meta.get("contentType") or "").strip() or None
        return data_path.read_bytes(), content_type
    except Exception:
        return None

def _write_cached_media(
    meta_path: Path,
    data_path: Path,
    *,
    payload: bytes,
    content_type: str | None,
    ttl_seconds: int,
) -> None:
    try:
        tmp_data = data_path.with_suffix(".bin.tmp")
        tmp_meta = meta_path.with_suffix(".json.tmp")
        tmp_data.write_bytes(payload)
        tmp_meta.write_text(
            json.dumps(
                {
                    "contentType": content_type,
                    "bytes": len(payload),
                    "fetchedAt": int(time.time()),
                    "expiresAt": time.time() + float(ttl_seconds),
                }
            ),
            encoding="utf-8",
        )
        tmp_data.replace(data_path)
        tmp_meta.replace(meta_path)
    except Exception:
        return


@blueprint.route("/media", methods=["GET"])
def proxy_media():
    source = _sanitize_media_url(request.args.get("src"))
    if not source:
        abort(400, "Invalid media source")

    data_path, meta_path = _media_cache_paths(source)
    cached = _read_cached_media(meta_path, data_path)
    if cached is not None:
        payload, content_type = cached
        response = Response(payload, status=200)
        if content_type:
            response.headers["Content-Type"] = content_type
        response.headers["Cache-Control"] = "public, max-age=86400"
        response.headers["X-PepPro-Media-Cache"] = "HIT"
        return response

    acquired = _WOO_MEDIA_FETCH_SEMAPHORE.acquire(timeout=2)
    if not acquired:
        abort(503, "Media proxy is busy, please retry")

    try:
        try:
            upstream = requests.get(source, timeout=(4, 20), stream=True)
        except requests.RequestException:
            abort(502, "Failed to fetch media")

        if upstream.status_code == 404:
            abort(404)
        if upstream.status_code >= 400:
            abort(upstream.status_code)

        content_type = upstream.headers.get("Content-Type")
        max_cache_bytes = int(os.environ.get("WOO_MEDIA_CACHE_MAX_BYTES") or str(10 * 1024 * 1024))
        max_download_bytes = int(os.environ.get("WOO_MEDIA_DOWNLOAD_MAX_BYTES") or str(max_cache_bytes))
        max_download_bytes = max(256 * 1024, min(max_download_bytes, 50 * 1024 * 1024))

        body = bytearray()
        try:
            for chunk in upstream.iter_content(chunk_size=64 * 1024):
                if not chunk:
                    continue
                body.extend(chunk)
                if len(body) > max_download_bytes:
                    abort(413, "Media too large")
        finally:
            upstream.close()
        payload = bytes(body) if body else b""
    finally:
        try:
            _WOO_MEDIA_FETCH_SEMAPHORE.release()
        except ValueError:
            pass

    if payload and len(payload) <= max_cache_bytes:
        _write_cached_media(
            meta_path,
            data_path,
            payload=payload,
            content_type=content_type,
            ttl_seconds=int(os.environ.get("WOO_MEDIA_CACHE_TTL_SECONDS") or 86400),
        )

    response = Response(payload, status=200)
    if content_type:
        response.headers["Content-Type"] = content_type
    response.headers["Cache-Control"] = "public, max-age=86400"
    response.headers["X-PepPro-Media-Cache"] = "MISS"
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
    def action():
        _require_admin()
        decoded: bytes
        filename: str | None = None
        mime: str = "application/octet-stream"

        # Prefer multipart uploads to avoid base64 overhead and proxy limits.
        if request.files and "file" in request.files:
            incoming = request.files.get("file")
            if not incoming:
                err = ValueError("Document payload is required")
                setattr(err, "status", 400)
                raise err

            data = bytearray()
            while True:
                chunk = incoming.stream.read(64 * 1024)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > _COA_MAX_BYTES:
                    max_mb = round(_COA_MAX_BYTES / (1024 * 1024), 2)
                    err = ValueError(f"Document is too large (max {max_mb} MB).")
                    setattr(err, "status", 413)
                    raise err

            decoded = bytes(data)
            filename = (incoming.filename or "").strip() or None
            mime = (incoming.mimetype or "").strip() or "application/octet-stream"
        else:
            payload = request.get_json(force=True, silent=True) or {}
            data_raw = payload.get("data") or payload.get("dataBase64") or payload.get("dataUrl")
            decoded, mime_from_payload = _parse_data_url_or_base64(str(data_raw or ""))
            if len(decoded) > _COA_MAX_BYTES:
                max_mb = round(_COA_MAX_BYTES / (1024 * 1024), 2)
                err = ValueError(f"Document is too large (max {max_mb} MB).")
                setattr(err, "status", 413)
                raise err

            filename = payload.get("filename") if isinstance(payload.get("filename"), str) else None
            mime_type = payload.get("mimeType") if isinstance(payload.get("mimeType"), str) else None
            # Data URL already embeds the true mime; only fall back to explicit mimeType if needed.
            mime = (mime_from_payload or mime_type or "application/octet-stream").strip()

        filename = filename or "certificate-of-analysis"

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
