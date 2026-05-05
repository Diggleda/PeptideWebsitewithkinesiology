from __future__ import annotations

import jwt
from flask import Flask, jsonify, request

from ..services import admin_shadow_session_service, get_config


_READ_ONLY_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_READ_ONLY_ALLOWLIST = {
    "/api/auth/logout",
}


def init_shadow_mode(app: Flask) -> None:
    @app.before_request
    def _reject_shadow_writes():  # type: ignore[return-value]
        if request.method not in _READ_ONLY_METHODS:
            return None
        if request.path in _READ_ONLY_ALLOWLIST:
            return None
        header = request.headers.get("Authorization", "") or ""
        if not header.strip():
            return None
        parts = header.split()
        token = parts[1] if len(parts) == 2 else parts[0]
        token = str(token or "").strip()
        if not token:
            return None
        try:
            payload = jwt.decode(token, get_config().jwt_secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            try:
                payload = jwt.decode(
                    token,
                    get_config().jwt_secret,
                    algorithms=["HS256"],
                    options={"verify_exp": False},
                )
            except jwt.InvalidTokenError:
                return None
            if payload.get("shadow") is True and payload.get("readOnly") is True:
                return _auth_failure("Token expired", "TOKEN_EXPIRED")
            return None
        except jwt.InvalidTokenError:
            return None
        if payload.get("shadow") is True and payload.get("readOnly") is True:
            try:
                admin_shadow_session_service.resolve_shadow_session(payload)
            except Exception as exc:
                code = getattr(exc, "error_code", None) or getattr(exc, "code", None)
                if not isinstance(code, str) or not code.strip():
                    code = "TOKEN_REVOKED"
                return _auth_failure("Token revoked", code.strip())
            response = jsonify(
                {
                    "error": "Maintenance mode is read-only",
                    "code": "SHADOW_READ_ONLY",
                }
            )
            response.status_code = 403
            return response
        return None


def _auth_failure(message: str, code: str):
    response = jsonify({"error": message, "code": code})
    response.status_code = 403
    return response
