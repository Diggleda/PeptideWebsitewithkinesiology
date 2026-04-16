from __future__ import annotations

import base64
import binascii
import re
from urllib.parse import quote, unquote_to_bytes

from flask import Response, has_request_context, request

_DATA_URL_RE = re.compile(
    r"^data:(?P<mimetype>[-\w.+/]+)?(?P<encoding>;base64)?,(?P<payload>.*)$",
    re.IGNORECASE | re.DOTALL,
)


def is_embedded_image(value: object) -> bool:
    if not isinstance(value, str):
        return False
    return value.strip().lower().startswith("data:image/")


def resolve_self_profile_image_url(value: object) -> str | None:
    return _resolve_embedded_asset_url(value, "/api/auth/me/profile-image")


def resolve_self_delegate_logo_url(value: object) -> str | None:
    return _resolve_embedded_asset_url(value, "/api/auth/me/delegate-logo")


def resolve_admin_user_profile_image_url(user_id: object, value: object) -> str | None:
    normalized_id = str(user_id or "").strip()
    if not normalized_id:
        return _normalize_external_media_value(value)
    return _resolve_embedded_asset_url(
        value,
        f"/api/settings/users/{quote(normalized_id, safe='')}/profile-image",
    )


def build_embedded_image_response(value: object) -> Response | None:
    decoded = _decode_data_url(value)
    if decoded is None:
        return None
    mimetype, payload = decoded
    response = Response(payload)
    response.mimetype = mimetype
    response.headers["Cache-Control"] = "private, max-age=300"
    response.headers["Content-Length"] = str(len(payload))
    return response


def _resolve_embedded_asset_url(value: object, path: str) -> str | None:
    normalized = _normalize_external_media_value(value)
    if normalized is None:
        return None
    if not is_embedded_image(normalized):
        return normalized
    if has_request_context():
        return f"{request.url_root.rstrip('/')}{path}"
    return path


def _normalize_external_media_value(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


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
