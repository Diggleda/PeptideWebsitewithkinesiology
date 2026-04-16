from __future__ import annotations

from flask import Blueprint, Response

from ..services import quotes_service
from ..utils.http import handle_action

blueprint = Blueprint("quotes", __name__, url_prefix="/api/quotes")


def _apply_cache_headers(response, value: str):
    if isinstance(response, Response):
        response.headers["Cache-Control"] = value
        return response
    if isinstance(response, tuple) and response and isinstance(response[0], Response):
        response[0].headers["Cache-Control"] = value
    return response


@blueprint.get("/daily")
def daily_quote():
    response = handle_action(quotes_service.get_daily_quote)
    return _apply_cache_headers(response, "public, max-age=300, stale-while-revalidate=3600")


@blueprint.get("")
@blueprint.get("/")
def list_quotes():
    response = handle_action(quotes_service.list_quotes)
    return _apply_cache_headers(response, "public, max-age=300, stale-while-revalidate=3600")
