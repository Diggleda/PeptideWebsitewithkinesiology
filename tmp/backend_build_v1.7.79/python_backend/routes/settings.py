from __future__ import annotations

from flask import Blueprint, request

from ..storage import settings_store
from ..utils.http import handle_action
from ..database import mysql_client

blueprint = Blueprint("settings", __name__, url_prefix="/api/settings")


def _to_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    return text in ("1", "true", "yes", "on")


def _get_settings():
    # Prefer JSON store first (so manual edits to server-data/settings.json are honored),
    # then MySQL, then default.
    if settings_store:
        try:
            data = settings_store.read() or {}
            if "shopEnabled" in data:
                return {"shopEnabled": _to_bool(data.get("shopEnabled", False))}
        except Exception:
            pass

    try:
        row = mysql_client.fetch_one(
            "SELECT value_json FROM settings WHERE `key` = %(key)s",
            {"key": "shopEnabled"},
        )
        if row and "value_json" in row and row["value_json"] is not None:
            return {"shopEnabled": _to_bool(row["value_json"])}
    except Exception:
        pass

    return {"shopEnabled": False}


def _write_settings(data):
    # Write to MySQL and keep JSON in sync as a secondary store.
    normalized = {"shopEnabled": _to_bool(data.get("shopEnabled", True))}
    try:
        mysql_client.execute(
            """
            INSERT INTO settings (`key`, value_json, updated_at)
            VALUES (%(key)s, %(value)s, NOW())
            ON DUPLICATE KEY UPDATE value_json = VALUES(value_json), updated_at = NOW()
            """,
            {"key": "shopEnabled", "value": normalized["shopEnabled"]},
        )
    except Exception:
        pass

    if settings_store:
        try:
            settings_store.write(normalized)
        except Exception:
            pass


@blueprint.get("/shop")
def get_shop():
    def action():
        settings = _get_settings()
        return {"shopEnabled": bool(settings.get("shopEnabled", True))}

    return handle_action(action)


@blueprint.put("/shop")
def update_shop():
    def action():
        payload = request.get_json(silent=True) or {}
        enabled = bool(payload.get("enabled", False))
        settings = _get_settings()
        settings["shopEnabled"] = enabled
        _write_settings(settings)
        return {"shopEnabled": enabled}

    return handle_action(action)
