from __future__ import annotations

from flask import Blueprint

from ..services import quotes_service
from ..utils.http import handle_action

blueprint = Blueprint("quotes", __name__, url_prefix="/api/quotes")


@blueprint.get("/daily")
def daily_quote():
    return handle_action(quotes_service.get_daily_quote)


@blueprint.get("")
@blueprint.get("/")
def list_quotes():
    return handle_action(quotes_service.list_quotes)
