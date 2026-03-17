from __future__ import annotations

from flask import Blueprint, g, request

from .bugs import _resolve_optional_actor
from ..services import usage_tracking_service
from ..utils.http import handle_action

blueprint = Blueprint("usage_tracking", __name__, url_prefix="/api/usage-tracking")


@blueprint.post("")
def track_usage_event():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        event = payload.get("event")
        normalized_event = str(event or "").strip()
        metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
        actor = getattr(g, "current_user", None) or _resolve_optional_actor() or {}
        tracked = usage_tracking_service.track_event(
            normalized_event,
            actor=actor,
            metadata=metadata,
            strict=True,
        )
        return {"ok": True, "tracked": tracked, "event": normalized_event}

    return handle_action(action, status=201)
