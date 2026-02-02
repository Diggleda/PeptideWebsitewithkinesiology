from __future__ import annotations

from flask import Blueprint, g, request

from ..middleware.auth import require_auth
from ..services import delegation_service
from ..services import settings_service  # type: ignore[attr-defined]
from ..utils.http import handle_action

blueprint = Blueprint("delegation", __name__, url_prefix="/api/delegation")


def _normalize_role(value: object) -> str:
    return str(value or "").strip().lower().replace(" ", "_").replace("-", "_")


def _require_doctor_access(role: str) -> None:
    if role not in ("doctor", "test_doctor", "admin"):
        err = ValueError("Doctor access required")
        setattr(err, "status", 403)
        raise err
    if role == "doctor":
        settings = settings_service.get_settings()
        if not bool(settings.get("patientLinksEnabled", False)):
            err = ValueError("Patient links are not enabled for doctors")
            setattr(err, "status", 403)
            raise err


def _resolve_target_doctor_id(role: str) -> str:
    actor = getattr(g, "current_user", None) or {}
    actor_id = str(actor.get("id") or "").strip()
    if role == "admin":
        override = str(request.args.get("doctorId") or "").strip()
        if override:
            return override
        err = ValueError("doctorId query param is required for admin requests")
        setattr(err, "status", 400)
        raise err
    if not actor_id:
        err = ValueError("User id missing from auth token")
        setattr(err, "status", 403)
        raise err
    return actor_id


@blueprint.get("/links")
@require_auth
def list_links():
    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        return {
            "success": True,
            "links": delegation_service.list_links(doctor_id),
            "config": delegation_service.get_doctor_config(doctor_id),
        }

    return handle_action(action)


@blueprint.post("/links")
@require_auth
def create_link():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        label = payload.get("label")
        link = delegation_service.create_link(doctor_id, label=label if isinstance(label, str) else None)
        return {"success": True, "link": link}

    return handle_action(action, status=201)


@blueprint.patch("/links/<token>")
@require_auth
def update_link(token: str):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        label = payload.get("label") if "label" in payload else None
        revoke = payload.get("revoke") if "revoke" in payload else None
        updated = delegation_service.update_link(
            doctor_id,
            token,
            label=label if isinstance(label, str) else None,
            revoke=bool(revoke) if revoke is not None else None,
        )
        return {"success": True, "link": updated}

    return handle_action(action)


@blueprint.patch("/config")
@require_auth
def update_config():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = getattr(g, "current_user", None) or {}
        role = _normalize_role(actor.get("role"))
        _require_doctor_access(role)
        doctor_id = _resolve_target_doctor_id(role)
        config = delegation_service.update_doctor_config(doctor_id, payload)
        return {"success": True, "config": config}

    return handle_action(action)


@blueprint.get("/resolve")
def resolve_token():
    token = (request.args.get("token") or "").strip()
    return handle_action(lambda: {"success": True, **delegation_service.resolve_delegate_token(token)})
