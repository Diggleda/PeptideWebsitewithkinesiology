from __future__ import annotations

from flask import Blueprint, Response, g, redirect, request

from ..middleware.auth import require_auth
from ..services import email_campaign_service
from ..utils.http import handle_action, require_admin as _require_admin

blueprint = Blueprint("admin_email", __name__, url_prefix="/api/admin/email")


def _current_admin() -> dict:
    _require_admin()
    return getattr(g, "current_user", None) or {}


@blueprint.get("/templates")
@require_auth
def list_templates():
    def action():
        _current_admin()
        return email_campaign_service.list_templates()

    return handle_action(action)


@blueprint.get("/templates/<template_id>/preview")
@require_auth
def preview_template(template_id: str):
    def action():
        admin = _current_admin()
        variables = {key: value for key, value in request.args.items()}
        asset_base_url = f"{request.host_url.rstrip('/')}/api/admin/email/assets"
        return email_campaign_service.preview_template(
            template_id,
            variables,
            admin_id=str(admin.get("id") or ""),
            asset_base_url=asset_base_url,
        )

    return handle_action(action)


@blueprint.post("/templates/<template_id>/preview")
@require_auth
def preview_custom_template(template_id: str):
    def action():
        admin = _current_admin()
        payload = request.get_json(silent=True) or {}
        variables = payload.get("variables") if isinstance(payload.get("variables"), dict) else {}
        asset_base_url = f"{request.host_url.rstrip('/')}/api/admin/email/assets"
        return email_campaign_service.preview_template(
            template_id,
            variables,
            admin_id=str(admin.get("id") or ""),
            asset_base_url=asset_base_url,
            custom_html=payload.get("customHtml") or payload.get("custom_html"),
        )

    return handle_action(action)


@blueprint.get("/assets/<content_id>")
def get_preview_asset(content_id: str):
    def action():
        image = email_campaign_service.get_preview_asset(content_id, request.args.get("token"))
        response = Response(image["data"], mimetype=image["mime_type"])
        response.headers["Cache-Control"] = "private, max-age=3600"
        response.headers["Content-Disposition"] = f'inline; filename="{image["filename"]}"'
        return response

    return handle_action(action)


@blueprint.post("/test")
@require_auth
def send_test():
    def action():
        admin = _current_admin()
        payload = request.get_json(silent=True) or {}
        return email_campaign_service.send_test_email(payload, admin=admin)

    return handle_action(action)


@blueprint.post("/recipients/estimate")
@require_auth
def estimate_recipients():
    def action():
        _current_admin()
        payload = request.get_json(silent=True) or {}
        return email_campaign_service.estimate_recipients(payload)

    return handle_action(action)


@blueprint.post("/campaigns")
@require_auth
def create_campaign():
    def action():
        admin = _current_admin()
        payload = request.get_json(silent=True) or {}
        return email_campaign_service.create_campaign(payload, admin=admin)

    return handle_action(action, status=201)


@blueprint.get("/campaigns")
@require_auth
def list_campaigns():
    def action():
        _current_admin()
        status = request.args.get("status") or None
        try:
            limit = int(float(request.args.get("limit") or 50))
        except Exception:
            limit = 50
        return email_campaign_service.list_campaigns(status=status, limit=limit)

    return handle_action(action)


@blueprint.get("/campaigns/<campaign_id>")
@require_auth
def get_campaign(campaign_id: str):
    def action():
        _current_admin()
        return email_campaign_service.get_campaign_detail(campaign_id)

    return handle_action(action)


@blueprint.delete("/campaigns/<campaign_id>")
@require_auth
def delete_campaign(campaign_id: str):
    def action():
        admin = _current_admin()
        return email_campaign_service.delete_draft_campaign(campaign_id, admin=admin)

    return handle_action(action)


@blueprint.get("/worker")
@require_auth
def get_worker_status():
    def action():
        _current_admin()
        return email_campaign_service.get_worker_status()

    return handle_action(action)


@blueprint.post("/bounces")
@require_auth
def process_bounce():
    def action():
        admin = _current_admin()
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {"rawEmail": request.get_data(as_text=True)}
        return email_campaign_service.process_bounce_notification(payload, admin=admin)

    return handle_action(action)


@blueprint.post("/bounces/poll")
@require_auth
def poll_bounces():
    def action():
        _current_admin()
        return email_campaign_service.poll_bounce_mailbox(force=True)

    return handle_action(action)


@blueprint.post("/bounces/webhook")
def process_bounce_webhook():
    def action():
        token = request.headers.get("X-Trufusion-Bounce-Token") or request.args.get("token")
        email_campaign_service.verify_bounce_webhook_secret(token)
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            payload = {"rawEmail": request.get_data(as_text=True)}
        return email_campaign_service.process_bounce_notification(payload)

    return handle_action(action)


@blueprint.get("/unsubscribe")
def unsubscribe():
    def action():
        result = email_campaign_service.unsubscribe(
            request.args.get("email"),
            request.args.get("token"),
            request.args.get("campaign_id"),
        )
        wants_json = request.args.get("format") == "json" or "application/json" in str(request.headers.get("Accept") or "")
        if wants_json:
            return result
        email = result.get("email") or "this address"
        return redirect(email_campaign_service.unsubscribe_landing_url(email), code=302)

    return handle_action(action)
