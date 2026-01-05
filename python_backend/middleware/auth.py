from __future__ import annotations

from functools import wraps
from typing import Callable, TypeVar

import jwt
from flask import Response, jsonify, request, g

from ..services import get_config
from ..repositories import user_repository, sales_rep_repository

F = TypeVar("F", bound=Callable)


def require_auth(func: F) -> F:
    @wraps(func)
    def wrapper(*args, **kwargs):
        header = request.headers.get("Authorization", "")
        if not header:
            return _unauthorized("Access token required", code="TOKEN_REQUIRED")

        parts = header.split()
        token = parts[1] if len(parts) == 2 else parts[0]

        try:
            payload = jwt.decode(token, get_config().jwt_secret, algorithms=["HS256"])
        except jwt.ExpiredSignatureError:
            return _forbidden("Token expired", code="TOKEN_EXPIRED")
        except jwt.InvalidTokenError:
            return _forbidden("Invalid token", code="TOKEN_INVALID")

        user_id = payload.get("id")
        if not user_id:
            return _forbidden("Invalid token", code="TOKEN_INVALID")

        role = (payload.get("role") or "").strip().lower()
        token_session_id = payload.get("sid") or payload.get("sessionId")
        if not token_session_id or not isinstance(token_session_id, str):
            return _forbidden("Invalid token", code="TOKEN_INVALID")

        if role == "sales_rep":
            rep = sales_rep_repository.find_by_id(str(user_id))
            if rep and rep.get("sessionId"):
                stored_session_id = rep.get("sessionId")
            else:
                # Some sales reps authenticate via the `users` table (role=sales_rep) rather than `sales_reps`.
                user = user_repository.find_by_id(str(user_id))
                stored_session_id = user.get("sessionId") if user else None
        else:
            user = user_repository.find_by_id(str(user_id))
            stored_session_id = user.get("sessionId") if user else None

        if not stored_session_id or not isinstance(stored_session_id, str):
            return _forbidden("Token revoked", code="TOKEN_REVOKED")

        if stored_session_id != token_session_id:
            return _forbidden("Token revoked", code="TOKEN_REVOKED")

        g.current_user = payload
        return func(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def _unauthorized(message: str, *, code: str | None = None) -> Response:
    payload = {"error": message}
    if code:
        payload["code"] = code
    return jsonify(payload), 401


def _forbidden(message: str, *, code: str | None = None) -> Response:
    payload = {"error": message}
    if code:
        payload["code"] = code
    return jsonify(payload), 403
