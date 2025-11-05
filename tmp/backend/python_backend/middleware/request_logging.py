from __future__ import annotations

import logging
import time

from flask import Flask, g, jsonify, request


def _should_track(path: str) -> bool:
    return path.startswith("/api")


def init_request_logging(app: Flask) -> None:
    """
    Attach basic request/response logging for API routes.
    """
    logger = logging.getLogger("protixa.http")

    @app.before_request
    def _log_start() -> None:  # type: ignore[return-value]
        if _should_track(request.path):
            g._request_logging_started_at = time.perf_counter()

    @app.after_request
    def _log_response(response):  # type: ignore[return-value]
        if _should_track(request.path):
            started = getattr(g, "_request_logging_started_at", None)
            duration_ms = None
            if isinstance(started, float):
                duration_ms = (time.perf_counter() - started) * 1000
            logger.info(
                "HTTP %s %s -> %s (%.1f ms)",
                request.method,
                request.path,
                response.status_code,
                duration_ms or -1,
            )
        return response

    @app.errorhandler(404)
    def _not_found(error):  # type: ignore[return-value]
        if _should_track(request.path):
            logger.warning("Route not found: %s %s", request.method, request.path)
            return jsonify({"error": "NOT_FOUND", "message": "Endpoint does not exist"}), 404
        return error

    @app.errorhandler(405)
    def _method_not_allowed(error):  # type: ignore[return-value]
        if _should_track(request.path):
            logger.warning("Method not allowed: %s %s", request.method, request.path)
            return jsonify({"error": "METHOD_NOT_ALLOWED"}), 405
        return error
