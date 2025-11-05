from __future__ import annotations

from functools import wraps
from typing import Callable, TypeVar

import jwt
from flask import Response, jsonify, request, g

from ..services import get_config

F = TypeVar("F", bound=Callable)


def require_auth(func: F) -> F:
    @wraps(func)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header:
            return _unauthorized("Access token required")

        parts = header.split()
        token = parts[1] if len(parts) == 2 else parts[0]

        try:
            payload = jwt.decode(token, get_config().jwt_secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return _forbidden("Token expired")
        except jwt.InvalidTokenError:
            return _forbidden("Invalid token")

        g.current_user = payload
        return func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def _unauthorized(message: str) -> Response:
    return jsonify({"error": message}), 401


def _forbidden(message: str) -> Response:
    return jsonify({"error": message}), 403
