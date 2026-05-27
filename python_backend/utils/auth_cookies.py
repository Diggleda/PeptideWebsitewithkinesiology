from __future__ import annotations

import os

from flask import Response, request

from ..brand import LEGACY_BRAND

MEDIA_AUTH_COOKIE_NAME = "trufusion_media_token"
LEGACY_MEDIA_AUTH_COOKIE_NAME = LEGACY_BRAND["media_auth_cookie_name"]


def read_media_auth_cookie() -> str | None:
    raw = request.cookies.get(MEDIA_AUTH_COOKIE_NAME) or request.cookies.get(LEGACY_MEDIA_AUTH_COOKIE_NAME)
    if not isinstance(raw, str):
        return None
    normalized = raw.strip()
    return normalized or None


def set_media_auth_cookie(response: Response, token: str) -> Response:
    normalized = str(token or "").strip()
    if not normalized:
        return clear_media_auth_cookie(response)
    response.set_cookie(
        MEDIA_AUTH_COOKIE_NAME,
        normalized,
        httponly=True,
        secure=_request_is_secure(),
        samesite="Lax",
        path="/api",
    )
    return response


def clear_media_auth_cookie(response: Response) -> Response:
    response.delete_cookie(
        MEDIA_AUTH_COOKIE_NAME,
        path="/api",
        secure=_request_is_secure(),
        samesite="Lax",
        httponly=True,
    )
    response.delete_cookie(
        LEGACY_MEDIA_AUTH_COOKIE_NAME,
        path="/api",
        secure=_request_is_secure(),
        samesite="Lax",
        httponly=True,
    )
    return response


def _request_is_secure() -> bool:
    if request.is_secure:
        return True
    forwarded_proto = str(request.headers.get("X-Forwarded-Proto") or "").strip().lower()
    if forwarded_proto and any(part.strip() == "https" for part in forwarded_proto.split(",")):
        return True
    if str(os.environ.get("NODE_ENV") or "").strip().lower() == "production":
        return True
    frontend_base_url = str(os.environ.get("FRONTEND_BASE_URL") or "").strip().lower()
    return frontend_base_url.startswith("https://")
