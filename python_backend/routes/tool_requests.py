from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from flask import Blueprint, request

from ..database import mysql_client
from ..services import get_config, usage_tracking_service
from ..utils.crypto_envelope import encrypt_text
from ..utils.http import handle_action
from .bugs import _resolve_optional_actor

blueprint = Blueprint("tool_requests", __name__, url_prefix="/api/tool-requests")


def _normalize_tool_request_source(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if raw in {"research", "research_tab", "account_research"}:
        return "research_tab"
    return "research_tab"


@blueprint.route("", methods=["POST"], strict_slashes=False)
def submit_tool_request():
    def action() -> Dict[str, Any]:
        payload = request.get_json(silent=True) or {}
        report = str(payload.get("report") or payload.get("request") or "").strip()
        source = _normalize_tool_request_source(payload.get("source"))

        if not report:
            error = ValueError("Tool request is required.")
            error.status = 400  # type: ignore[attr-defined]
            raise error

        actor = _resolve_optional_actor() or {}
        record = {
            "userId": str(actor.get("id") or "").strip() or None,
            "name": str(actor.get("name") or "").strip() or None,
            "email": str(actor.get("email") or "").strip() or None,
            "report": report,
            "source": source,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        if not get_config().mysql.get("enabled"):
            error = RuntimeError("Tool request storage requires MySQL to be enabled.")
            error.status = 503  # type: ignore[attr-defined]
            raise error

        with mysql_client.cursor() as cur:
            cur.execute(
                """
                INSERT INTO tool_requests (
                    user_id, name, email, report, source
                )
                VALUES (
                    %(user_id)s, %(name)s, %(email)s, %(report)s, %(source)s
                )
                """,
                {
                    "user_id": record["userId"],
                    "name": encrypt_text(
                        record["name"],
                        aad={"table": "tool_requests", "field": "name"},
                    ) if record["name"] else None,
                    "email": encrypt_text(
                        record["email"],
                        aad={"table": "tool_requests", "field": "email"},
                    ) if record["email"] else None,
                    "report": encrypt_text(
                        record["report"],
                        aad={"table": "tool_requests", "field": "report"},
                    ),
                    "source": record["source"],
                },
            )

        usage_tracking_service.track_event(
            "tool_request_submitted",
            actor=actor,
            metadata={"source": record["source"]},
        )
        return {"status": "ok"}

    return handle_action(action)
