from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import usage_tracking_service
from ..utils.http import handle_action

blueprint = Blueprint("usage_tracking", __name__, url_prefix="/api/usage-tracking")


@blueprint.post("")
@require_auth
def track_usage_event():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        event = payload.get("event")
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        usage_tracking_service.track_event(
            str(event or "").strip(),
            actor=getattr(g, "current_user", None) or {},
            metadata=metadata,
        )
        return {"ok": True}

    return handle_action(action, status=201)
