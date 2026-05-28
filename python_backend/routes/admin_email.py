from __future__ import annotations

from flask import Blueprint, Response, g, request

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
        return email_campaign_service.preview_template(
            template_id,
            variables,
            admin_id=str(admin.get("id") or ""),
        )

    return handle_action(action)


@blueprint.post("/test")
@require_auth
def send_test():
    def action():
        admin = _current_admin()
        payload = request.get_json(silent=True) or {}
        return email_campaign_service.send_test_email(payload, admin=admin)

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


@blueprint.get("/worker")
@require_auth
def get_worker_status():
    def action():
        _current_admin()
        return email_campaign_service.get_worker_status()

    return handle_action(action)


@blueprint.get("/unsubscribe")
def unsubscribe():
    def action():
        result = email_campaign_service.unsubscribe(
            request.args.get("email"),
            request.args.get("token"),
            request.args.get("campaign_id"),
        )
        email = result.get("email") or "this address"
        html = f"""<!DOCTYPE html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Unsubscribed</title></head>
  <body style="font-family:Arial,Helvetica,sans-serif;margin:0;background:#ffffff;color:#111827;">
    <main style="max-width:560px;margin:48px auto;padding:0 24px;">
      <h1 style="font-size:28px;line-height:1.2;color:#0B274B;">You are unsubscribed</h1>
      <p style="font-size:16px;line-height:1.6;">{email} will no longer receive TrufusionLabs admin campaign emails.</p>
    </main>
  </body>
</html>"""
        return Response(html, mimetype="text/html")

    return handle_action(action)
