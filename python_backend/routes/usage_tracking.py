from __future__ import annotations

from flask import Blueprint, g, request

from .bugs import _resolve_optional_actor
from ..middleware.auth import require_auth
from ..services import usage_tracking_service
from ..utils.http import handle_action

blueprint = Blueprint("usage_tracking", __name__, url_prefix="/api/usage-tracking")


@blueprint.get("/funnel")
@require_auth
def get_usage_funnel():
    raw_events = request.args.get("events") or ""
    raw_actor_key = request.args.get("actorKey") or ""

    def action():
        events = [
            str(value or "").strip()
            for value in raw_events.split(",")
            if str(value or "").strip()
        ]
        actor_key = str(raw_actor_key or "").strip() or None
        funnel = usage_tracking_service.get_event_funnel(events, actor_key=actor_key)
        return {
            "events": events,
            "counts": funnel.get("counts") or {},
            "actors": funnel.get("actors") or [],
            "filteredActorKey": actor_key,
        }

    return handle_action(action)


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
