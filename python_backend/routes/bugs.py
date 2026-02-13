from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

import jwt
from flask import Blueprint, request

from ..database import mysql_client
from ..repositories import sales_rep_repository, user_repository
from ..services import get_config
from ..storage import bug_report_store
from ..utils.http import handle_action

blueprint = Blueprint("bugs", __name__, url_prefix="/api/bugs")


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
    if role == "sales_rep":
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
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        if not get_config().mysql.get("enabled"):
            # Mirror the contact form behavior: fall back to JSON storage when MySQL is unavailable.
            if bug_report_store:
                reports = bug_report_store.read()
                reports.append(record)
                bug_report_store.write(reports)
                return {"status": "ok"}
            error = RuntimeError("Bug report storage requires MySQL to be enabled.")
            error.status = 503  # type: ignore[attr-defined]
            raise error

        try:
            with mysql_client.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO bugs_reported (user_id, name, email, report)
                    VALUES (%(user_id)s, %(name)s, %(email)s, %(report)s)
                    """,
                    {
                        "user_id": record["userId"],
                        "name": record["name"],
                        "email": record["email"],
                        "report": record["report"],
                    },
                )
        except Exception:
            if bug_report_store:
                reports = bug_report_store.read()
                reports.append(record)
                bug_report_store.write(reports)
                return {"status": "ok"}
            raise

        return {"status": "ok"}

    return handle_action(action)

