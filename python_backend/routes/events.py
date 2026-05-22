from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Dict

from flask import Blueprint, Response, request, stream_with_context

from ..middleware.auth import require_auth, require_media_auth
from ..services import resource_version_service
from ..utils.http import handle_action

blueprint = Blueprint("events", __name__, url_prefix="/api")

_POLL_SECONDS = 2.0
_HEARTBEAT_SECONDS = 20.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _event_payload(row: Dict[str, object]) -> str:
    payload = {
        "resource": row.get("resource"),
        "version": int(row.get("version") or 0),
        "updatedAt": row.get("updatedAt") or _now_iso(),
    }
    event_name = f"{payload['resource']}.changed"
    return f"event: {event_name}\ndata: {json.dumps(payload, separators=(',', ':'))}\n\n"


@blueprint.get("/resource-versions")
@require_auth
def resource_versions():
    def action():
        resources = resource_version_service.parse_resources_param(request.args.get("resources"))
        return {
            "resources": resource_version_service.get_versions(resources),
            "fetchedAt": _now_iso(),
        }

    return handle_action(action)


@blueprint.get("/events")
@require_media_auth
def app_events():
    resources = resource_version_service.parse_resources_param(request.args.get("resources"))

    @stream_with_context
    def generate():
        last_versions = resource_version_service.get_versions(resources)
        last_heartbeat = time.monotonic()
        yield ": connected\n\n"
        while True:
            now = time.monotonic()
            if now - last_heartbeat >= _HEARTBEAT_SECONDS:
                last_heartbeat = now
                yield f": heartbeat {_now_iso()}\n\n"

            try:
                current_versions = resource_version_service.get_versions(resources)
            except Exception:
                current_versions = last_versions

            for resource, row in sorted(current_versions.items()):
                previous = last_versions.get(resource)
                previous_version = int((previous or {}).get("version") or 0)
                current_version = int((row or {}).get("version") or 0)
                if current_version > previous_version:
                    yield _event_payload(row)

            last_versions = current_versions
            time.sleep(_POLL_SECONDS)

    response = Response(generate(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Accel-Buffering"] = "no"
    return response

