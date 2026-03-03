from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import integration_service
from ..utils.http import handle_action

blueprint = Blueprint("integrations", __name__, url_prefix="/api/integrations")


@blueprint.post("/google-sheets/sales-reps")
@blueprint.post("/google-sheets/sales-reps/")
@blueprint.post("/google-sheets/sales-reps.php")
@blueprint.post("/google-sheets/sales-reps.php/")
def sync_sales_reps():
    payload = request.get_json(force=True, silent=True) or {}
    headers = {key.lower(): value for key, value in request.headers.items()}
    return handle_action(lambda: integration_service.sync_sales_reps(payload, headers))


@blueprint.post("/google-sheets/the-peptide-forum")
@blueprint.post("/google-sheets/the-peptide-forum/")
@blueprint.post("/google-sheets/the-peptide-forum.php")
@blueprint.post("/google-sheets/the-peptide-forum.php/")
def sync_peptide_forum():
    payload = request.get_json(force=True, silent=True) or {}
    headers = {key.lower(): value for key, value in request.headers.items()}
    return handle_action(lambda: integration_service.sync_peptide_forum(payload, headers))


@blueprint.route("/seamless/raw", methods=["OPTIONS"])
@blueprint.route("/seamless/raw/", methods=["OPTIONS"])
def get_seamless_raw_options():
    return "", 204


@blueprint.get("/seamless/raw")
@blueprint.get("/seamless/raw/")
@require_auth
def get_seamless_raw():
    limit = request.args.get("limit", "20")
    current_user = getattr(g, "current_user", None) or {}
    return handle_action(lambda: integration_service.list_seamless_raw_payloads(current_user, limit))
