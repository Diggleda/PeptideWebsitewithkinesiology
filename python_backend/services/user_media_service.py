from __future__ import annotations

import base64
import binascii
import hashlib
import re
from urllib.parse import parse_qsl, quote, urlencode, unquote_to_bytes, urlparse, urlunparse

from flask import Response, has_request_context, request

_DATA_URL_RE = re.compile(
    r"^data:(?P<mimetype>[-\w.+/]+)?(?P<encoding>;base64)?,(?P<payload>.*)$",
    re.IGNORECASE | re.DOTALL,
)
_SELF_PROFILE_IMAGE_PATH_RE = re.compile(r"^/api/auth/me/profile-image/?$", re.IGNORECASE)
_SELF_DELEGATE_LOGO_PATH_RE = re.compile(r"^/api/auth/me/delegate-logo/?$", re.IGNORECASE)
_ADMIN_PROFILE_IMAGE_PATH_RE = re.compile(r"^/api/settings/users/[^/]+/profile-image/?$", re.IGNORECASE)


def is_embedded_image(value: object) -> bool:
    if not isinstance(value, str):
        return False
    return value.strip().lower().startswith("data:image/")


def resolve_self_profile_image_url(value: object, *, user_id: object = None) -> str | None:
    return _resolve_managed_asset_url(
        value,
        "/api/auth/me/profile-image",
        matcher=is_managed_profile_image_value,
        cache_scope=user_id,
    )


def resolve_self_delegate_logo_url(value: object, *, user_id: object = None) -> str | None:
    return _resolve_managed_asset_url(
        value,
        "/api/auth/me/delegate-logo",
        matcher=is_managed_delegate_logo_value,
        cache_scope=user_id,
    )


def resolve_admin_user_profile_image_url(user_id: object, value: object) -> str | None:
    normalized_id = str(user_id or "").strip()
    if not normalized_id:
        return _normalize_external_media_value(value)
    return _resolve_managed_asset_url(
        value,
        f"/api/settings/users/{quote(normalized_id, safe='')}/profile-image",
        matcher=is_managed_profile_image_value,
        cache_scope=normalized_id,
    )


def is_managed_profile_image_value(value: object) -> bool:
    normalized_path = _normalized_internal_path(value)
    if normalized_path is None:
        return False
    return bool(
        _SELF_PROFILE_IMAGE_PATH_RE.match(normalized_path)
        or _ADMIN_PROFILE_IMAGE_PATH_RE.match(normalized_path)
    )


def is_managed_delegate_logo_value(value: object) -> bool:
    normalized_path = _normalized_internal_path(value)
    if normalized_path is None:
        return False
    return bool(_SELF_DELEGATE_LOGO_PATH_RE.match(normalized_path))


def normalize_profile_image_for_storage(value: object, *, existing_value: object = None) -> str | None:
    return _normalize_managed_media_for_storage(
        value,
        existing_value=existing_value,
        matcher=is_managed_profile_image_value,
    )


def normalize_delegate_logo_for_storage(value: object, *, existing_value: object = None) -> str | None:
    return _normalize_managed_media_for_storage(
        value,
        existing_value=existing_value,
        matcher=is_managed_delegate_logo_value,
    )


def build_embedded_image_response(value: object) -> Response | None:
    decoded = _decode_data_url(value)
    if decoded is None:
        return None
    mimetype, payload = decoded
    response = Response(payload)
    response.mimetype = mimetype
    response.headers["Cache-Control"] = "private, max-age=300"
    response.headers["Vary"] = "Cookie, Authorization"
    response.headers["Content-Length"] = str(len(payload))
    return response


def _resolve_managed_asset_url(
    value: object,
    path: str,
    *,
    matcher,
    cache_scope: object = None,
) -> str | None:
    normalized = _normalize_external_media_value(value)
    if normalized is None:
        return None
    if not is_embedded_image(normalized) and not matcher(normalized):
        return normalized
    path_with_version = _append_version_query(path, normalized, cache_scope=cache_scope)
    if has_request_context():
        return f"{request.url_root.rstrip('/')}{path_with_version}"
    return path_with_version


def _normalize_managed_media_for_storage(
    value: object,
    *,
    existing_value: object,
    matcher,
) -> str | None:
    normalized = _normalize_external_media_value(value)
    if normalized is None:
        return None
    if not matcher(normalized):
        return normalized
    existing_normalized = _normalize_external_media_value(existing_value)
    if existing_normalized and not matcher(existing_normalized):
        return existing_normalized
    return normalized


def _normalize_external_media_value(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def _normalized_internal_path(value: object) -> str | None:
    normalized = _normalize_external_media_value(value)
    if normalized is None:
        return None
    candidate = normalized
    if "://" in candidate:
        candidate = urlparse(candidate).path or ""
    elif candidate.startswith("//"):
        candidate = urlparse(f"https:{candidate}").path or ""
    if candidate.startswith("api/"):
        candidate = f"/{candidate}"
    if not candidate.startswith("/"):
        return None
    return candidate


def _append_version_query(path: str, source_value: str, *, cache_scope: object = None) -> str:
    scope = str(cache_scope or "").strip()
    digest = hashlib.sha1(f"{scope}|{source_value}".encode("utf-8")).hexdigest()[:12]
    parsed = urlparse(path)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query["v"] = digest
    return urlunparse(parsed._replace(query=urlencode(query)))


def _decode_data_url(value: object) -> tuple[str, bytes] | None:
    normalized = _normalize_external_media_value(value)
    if normalized is None:
        return None
    match = _DATA_URL_RE.match(normalized)
    if match is None:
        return None
    mimetype = str(match.group("mimetype") or "application/octet-stream").strip() or "application/octet-stream"
    payload = match.group("payload") or ""
    is_base64 = bool(match.group("encoding"))
    try:
        if is_base64:
            raw = base64.b64decode(payload, validate=True)
        else:
            raw = unquote_to_bytes(payload)
    except (binascii.Error, ValueError):
        return None
    return mimetype, raw
