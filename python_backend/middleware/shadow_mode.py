from __future__ import annotations

import jwt
from flask import Flask, jsonify, request

from ..services import get_config


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
        except jwt.InvalidTokenError:
            return None
        if payload.get("shadow") is True and payload.get("readOnly") is True:
            response = jsonify(
                {
                    "error": "Maintenance mode is read-only",
                    "code": "SHADOW_READ_ONLY",
                }
            )
            response.status_code = 403
            return response
        return None
