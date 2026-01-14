from __future__ import annotations

from flask import Blueprint

from ..services import peptide_forum_service
from ..utils.http import handle_action

blueprint = Blueprint("forum", __name__, url_prefix="/api/forum")


@blueprint.get("/the-peptide-forum")
@blueprint.get("/the-peptide-forum/")
def list_forum():
    return handle_action(lambda: {"ok": True, **peptide_forum_service.list_items()})

