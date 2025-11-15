from __future__ import annotations

from typing import Any, Callable, Tuple

from flask import Response, jsonify, request


def json_success(data: Any, status: int = 200) -> Response:
    return jsonify(data), status


def json_error(error: Exception) -> Response:
    status = getattr(error, "status", 500)
    message = getattr(error, "message", None) or str(error) or "Internal server error"
    return jsonify({"error": message}), status


def handle_action(action: Callable[[], Any], status: int = 200) -> Response:
    try:
        payload = action()
        return json_success(payload, status=status)
    except Exception as exc:  # pragma: no cover - error paths
        import logging

        logger = logging.getLogger("peppro.api")
        logger.exception(
            "Unhandled API error",
            extra={"method": request.method, "path": request.path, "status": getattr(exc, "status", 500)},
        )
        return json_error(exc)
