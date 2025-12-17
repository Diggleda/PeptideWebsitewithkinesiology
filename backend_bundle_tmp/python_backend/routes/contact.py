from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from flask import Blueprint, request

from ..storage import contact_form_store
from ..utils.http import handle_action
from ..database import mysql_client

blueprint = Blueprint("contact", __name__, url_prefix="/api/contact")


@blueprint.post("/")
def submit_contact():
    def action() -> Dict[str, Any]:
        payload = request.get_json(silent=True) or {}
        name = str(payload.get("name") or "").strip()
        email = str(payload.get("email") or "").strip()
        phone = str(payload.get("phone") or "").strip()
        source = str(payload.get("source") or "").strip()

        if not name or not email:
            error = ValueError("Name and email are required.")
            error.status = 400  # type: ignore[attr-defined]
            raise error

        record = {
            "name": name,
            "email": email,
            "phone": phone or None,
            "source": source or None,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }

        # Prefer MySQL; fall back to JSON store if unavailable.
        try:
            mysql_client.execute(
                """
                INSERT INTO contact_forms (name, email, phone, source)
                VALUES (%(name)s, %(email)s, %(phone)s, %(source)s)
                """,
                {
                    "name": record["name"],
                    "email": record["email"],
                    "phone": record["phone"],
                    "source": record["source"],
                },
            )
        except Exception:
            if contact_form_store:
                forms = contact_form_store.read()
                forms.append(record)
                contact_form_store.write(forms)

        return {"status": "ok"}

    return handle_action(action)


@blueprint.get("/")
def contact_info():
    def action() -> Dict[str, Any]:
        return {"status": "ok"}

    return handle_action(action)
