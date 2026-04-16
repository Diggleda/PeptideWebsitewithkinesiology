from __future__ import annotations

from flask import Response, request


MEDIA_AUTH_COOKIE_NAME = "peppro_media_token"


def read_media_auth_cookie() -> str | None:
    raw = request.cookies.get(MEDIA_AUTH_COOKIE_NAME)
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
    return response


def _request_is_secure() -> bool:
    if request.is_secure:
        return True
    forwarded_proto = str(request.headers.get("X-Forwarded-Proto") or "").strip().lower()
    if not forwarded_proto:
        return False
    return any(part.strip() == "https" for part in forwarded_proto.split(","))
