from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

import jwt
from flask import Blueprint, request

from ..database import mysql_client
from ..repositories import sales_rep_repository, user_repository
from ..services import get_config, usage_tracking_service
from ..utils.crypto_envelope import encrypt_text
from ..utils.http import handle_action

blueprint = Blueprint("bugs", __name__, url_prefix="/api/bugs")


def _normalize_bug_report_source(value: Any) -> str:
    raw = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    if raw == "delegate_link":
        return "delegate_link"
    return "footer"


def _resolve_optional_actor() -> Dict[str, Any]:
    header = request.headers.get("Authorization", "") or ""
    if not header.strip():
        return {}

    parts = header.split()
    token = parts[1] if len(parts) == 2 else parts[0]
    token = str(token or "").strip()
    if not token:
        return {}

    secret = get_config().jwt_secret
    payload = None
    try:
        payload = jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        try:
            payload = jwt.decode(token, secret, algorithms=["HS256"], options={"verify_exp": False})
        except jwt.InvalidTokenError:
            payload = None
    except jwt.InvalidTokenError:
        payload = None

    if not payload or not isinstance(payload, dict):
        return {}

    user_id = payload.get("id")
    if not user_id:
        return {}

    role = str(payload.get("role") or "").strip().lower()
    if role in ("sales_rep", "sales_partner"):
        actor = sales_rep_repository.find_by_id(str(user_id))
        if actor:
            return actor

    actor = user_repository.find_by_id(str(user_id))
    if actor:
        return actor

    return payload


@blueprint.route("", methods=["POST"], strict_slashes=False)
def submit_bug_report():
    def action() -> Dict[str, Any]:
        payload = request.get_json(silent=True) or {}
        report = str(payload.get("report") or "").strip()
        source = _normalize_bug_report_source(payload.get("source"))

        if not report:
            error = ValueError("Bug report is required.")
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
            error = RuntimeError("Bug report storage requires MySQL to be enabled.")
            error.status = 503  # type: ignore[attr-defined]
            raise error

        try:
            with mysql_client.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO bugs_reported (
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
                            aad={"table": "bugs_reported", "field": "name"},
                        ) if record["name"] else None,
                        "email": encrypt_text(
                            record["email"],
                            aad={"table": "bugs_reported", "field": "email"},
                        ) if record["email"] else None,
                        "report": encrypt_text(
                            record["report"],
                            aad={"table": "bugs_reported", "field": "report"},
                        ),
                        "source": record["source"],
                    },
                )
        except Exception:
            raise

        usage_tracking_service.track_event(
            "issue_reported",
            actor=actor,
            metadata={"source": record["source"]},
        )
        return {"status": "ok"}

    return handle_action(action)
