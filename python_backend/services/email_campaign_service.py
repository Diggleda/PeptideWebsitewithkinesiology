from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import logging
import os
import re
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple
from urllib.parse import urlencode

from ..repositories import email_campaign_repository
from . import background_job_supervisor, email_service, get_config

logger = logging.getLogger(__name__)

_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "email_templates_manifest.json"
_TEMPLATE_ROOT = Path(__file__).resolve().parents[1] / "email_templates"
_VARIABLE_RE = re.compile(r"{{\s*([a-zA-Z0-9_]+)\s*}}")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_TOKEN_TTL_SECONDS = 60 * 60
_TEST_RATE_WINDOW_SECONDS = 15 * 60
_TEST_RATE_LIMIT = 10
_TEST_SENDS: Dict[str, List[float]] = {}
_TEST_SENDS_LOCK = threading.Lock()

_THREAD_STARTED = False
_THREAD_LOCK = threading.Lock()
_JOB_NAME = "emailCampaignWorker"

EMAIL_TYPE_OPTIONS = [
    {"id": "survey", "label": "Survey"},
    {"id": "announcement", "label": "Announcement"},
    {"id": "invitation", "label": "Invitation"},
    {"id": "legal_update", "label": "Legal Update"},
    {"id": "product_update", "label": "Product Update"},
    {"id": "research_network_invite", "label": "Research Network Invite"},
    {"id": "manual", "label": "Manual / Custom"},
]

_SAMPLE_VARIABLES = {
    "doctor_name": "Dr. Jane Example",
    "clinic_name": "Example Clinic",
    "delegate_links_url": "https://trufusionlabs.com/account?tab=delegate-links",
    "unsubscribe_url": "https://trufusionlabs.com/api/admin/email/unsubscribe?preview=1",
    "survey_link": "https://trufusionlabs.com/surveys/example",
    "invite_link": "https://trufusionlabs.com/invitations/example",
    "message_body": "This safe text field is controlled by an approved template.",
    "support_email": "support@trufusionlabs.com",
}


def service_error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _now_iso() -> str:
    return _now().isoformat().replace("+00:00", "Z")


def _new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"


def _normalize_email(value: Any) -> str:
    candidate = str(value or "").strip()
    if candidate.lower().startswith("mailto:"):
        candidate = candidate.split(":", 1)[-1].strip()
    match = re.search(r"<([^>]+)>", candidate)
    if match:
        candidate = match.group(1).strip()
    candidate = re.sub(r"\s+", "", candidate).lower()
    return candidate if _EMAIL_RE.match(candidate) else ""


def _require_email(value: Any, message: str = "A valid email is required") -> str:
    email = _normalize_email(value)
    if not email:
        raise service_error(message, 400)
    return email


def _parse_iso(value: Any) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except Exception as exc:
        raise service_error("Invalid scheduled_at value", 400) from exc
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _safe_text(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True).replace("\n", "<br />")


def _token_secret() -> bytes:
    try:
        secret = str(get_config().jwt_secret or "")
    except Exception:
        secret = ""
    if not secret:
        secret = "trufusion-email-center-dev-secret"
    return secret.encode("utf-8")


def _base64_url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _base64_url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _canonical_json(value: Any) -> str:
    return json.dumps(value or {}, sort_keys=True, separators=(",", ":"))


def _variables_digest(variables: Dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(variables).encode("utf-8")).hexdigest()


def _sign_payload(payload: Dict[str, Any]) -> str:
    raw = _canonical_json(payload).encode("utf-8")
    body = _base64_url_encode(raw)
    signature = hmac.new(_token_secret(), body.encode("ascii"), hashlib.sha256).digest()
    return f"{body}.{_base64_url_encode(signature)}"


def _verify_signed_payload(token: Any, *, require_expiry: bool = True) -> Dict[str, Any]:
    text = str(token or "").strip()
    if "." not in text:
        raise service_error("A valid test send token is required", 400)
    body, signature = text.rsplit(".", 1)
    expected = _base64_url_encode(hmac.new(_token_secret(), body.encode("ascii"), hashlib.sha256).digest())
    if not hmac.compare_digest(signature, expected):
        raise service_error("A valid test send token is required", 400)
    try:
        payload = json.loads(_base64_url_decode(body).decode("utf-8"))
    except Exception as exc:
        raise service_error("A valid test send token is required", 400) from exc
    expires_at = int(payload.get("expiresAt") or 0)
    if require_expiry and expires_at < int(time.time()):
        raise service_error("The test send token has expired; send a new test email", 400)
    return payload


def _build_test_token(*, admin_id: str, template_id: str, subject: str, variables: Dict[str, Any]) -> Tuple[str, str]:
    expires_at = int(time.time()) + _TOKEN_TTL_SECONDS
    payload = {
        "adminId": admin_id,
        "templateId": template_id,
        "subject": subject,
        "variablesDigest": _variables_digest(variables),
        "expiresAt": expires_at,
    }
    expires_iso = datetime.fromtimestamp(expires_at, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return _sign_payload(payload), expires_iso


def _verify_test_token(
    *,
    token: Any,
    admin_id: str,
    template_id: str,
    subject: str,
    variables: Dict[str, Any],
) -> None:
    payload = _verify_signed_payload(token)
    if str(payload.get("adminId") or "") != str(admin_id or ""):
        raise service_error("Send a test email before launching this campaign", 400)
    if str(payload.get("templateId") or "") != str(template_id or ""):
        raise service_error("Send a test email for the selected template before launching", 400)
    if str(payload.get("subject") or "") != str(subject or ""):
        raise service_error("Send a new test email after changing the subject", 400)
    if str(payload.get("variablesDigest") or "") != _variables_digest(variables):
        raise service_error("Send a new test email after changing variables", 400)


def _check_test_rate_limit(admin_id: str) -> None:
    now = time.time()
    key = str(admin_id or "unknown")
    with _TEST_SENDS_LOCK:
        entries = [entry for entry in _TEST_SENDS.get(key, []) if now - entry < _TEST_RATE_WINDOW_SECONDS]
        if len(entries) >= _TEST_RATE_LIMIT:
            _TEST_SENDS[key] = entries
            raise service_error("Too many test emails; wait before sending another test", 429)
        entries.append(now)
        _TEST_SENDS[key] = entries


@lru_cache(maxsize=1)
def _load_manifest_cached() -> Dict[str, Any]:
    with _MANIFEST_PATH.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise RuntimeError("Email template manifest must be a JSON object")
    return data


def clear_manifest_cache() -> None:
    _load_manifest_cached.cache_clear()


def _manifest() -> Dict[str, Any]:
    return _load_manifest_cached()


def _flatten_templates() -> List[Dict[str, Any]]:
    templates: List[Dict[str, Any]] = []
    for category, entries in _manifest().items():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            template = dict(entry)
            template["category"] = category
            template["variables"] = [str(item) for item in template.get("variables") or []]
            templates.append(template)
    return templates


def list_templates() -> Dict[str, Any]:
    templates = _flatten_templates()
    return {
        "emailTypes": EMAIL_TYPE_OPTIONS,
        "categories": _manifest(),
        "templates": templates,
    }


def get_template(template_id: str) -> Dict[str, Any]:
    normalized = str(template_id or "").strip()
    for template in _flatten_templates():
        if template.get("id") == normalized:
            return template
    raise service_error("Email template not found", 404)


def _template_path(template: Dict[str, Any]) -> Path:
    relative = str(template.get("file") or "").strip()
    if not relative:
        raise service_error("Email template has no approved file", 500)
    path = (_TEMPLATE_ROOT / relative).resolve()
    root = _TEMPLATE_ROOT.resolve()
    if path != root and root not in path.parents:
        raise service_error("Email template path is not allowed", 500)
    if not path.is_file():
        raise service_error("Email template file is missing", 500)
    return path


def _load_template_html(template: Dict[str, Any]) -> str:
    return _template_path(template).read_text(encoding="utf-8")


def normalize_variables(template: Dict[str, Any], variables: Optional[Dict[str, Any]]) -> Dict[str, str]:
    supplied = variables if isinstance(variables, dict) else {}
    normalized: Dict[str, str] = {}
    for variable_name in template.get("variables") or []:
        value = supplied.get(variable_name)
        if value is None or str(value).strip() == "":
            value = _SAMPLE_VARIABLES.get(variable_name, "")
        normalized[str(variable_name)] = str(value)
    return normalized


def render_email_template(template_id: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    template = get_template(template_id)
    normalized_variables = normalize_variables(template, variables)
    source = _load_template_html(template)

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in normalized_variables:
            return ""
        return _safe_text(normalized_variables.get(name))

    rendered = _VARIABLE_RE.sub(replace, source)
    plain = _plain_text_from_html(rendered)
    return {
        "template": template,
        "html": rendered,
        "plainText": plain,
        "variables": normalized_variables,
    }


def _plain_text_from_html(value: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", "", value or "")
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</p\s*>", "\n\n", text)
    text = re.sub(r"(?i)</h[1-6]\s*>", "\n\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _public_api_base_url() -> str:
    explicit = str(os.environ.get("PUBLIC_API_BASE_URL") or os.environ.get("API_PUBLIC_BASE_URL") or "").strip()
    if explicit:
        return explicit.rstrip("/")
    try:
        frontend = str(get_config().frontend_base_url or "").strip().rstrip("/")
    except Exception:
        frontend = ""
    if frontend:
        return f"{frontend}/api"
    return "https://trufusionlabs.com/api"


def _build_unsubscribe_token(email: str, campaign_id: Optional[str] = None) -> str:
    payload = {
        "email": _normalize_email(email),
        "campaignId": str(campaign_id or ""),
        "scope": "email_unsubscribe",
    }
    return _sign_payload(payload)


def build_unsubscribe_url(email: str, campaign_id: Optional[str] = None) -> str:
    normalized = _normalize_email(email)
    query = urlencode(
        {
            "email": normalized,
            "campaign_id": campaign_id or "",
            "token": _build_unsubscribe_token(normalized, campaign_id),
        }
    )
    return f"{_public_api_base_url()}/admin/email/unsubscribe?{query}"


def unsubscribe(email: Any, token: Any, campaign_id: Any = None) -> Dict[str, Any]:
    normalized = _require_email(email)
    payload = _verify_signed_payload(token, require_expiry=False)
    if payload.get("scope") != "email_unsubscribe":
        raise service_error("Invalid unsubscribe token", 400)
    if _normalize_email(payload.get("email")) != normalized:
        raise service_error("Invalid unsubscribe token", 400)
    token_campaign_id = str(payload.get("campaignId") or "")
    requested_campaign_id = str(campaign_id or "").strip()
    if token_campaign_id and requested_campaign_id and token_campaign_id != requested_campaign_id:
        raise service_error("Invalid unsubscribe token", 400)
    record = email_campaign_repository.add_unsubscribe(
        email=normalized,
        source="campaign_unsubscribe",
        campaign_id=token_campaign_id or requested_campaign_id or None,
    )
    email_campaign_repository.log_event(
        event_id=_new_id("evt"),
        campaign_id=token_campaign_id or requested_campaign_id or None,
        recipient_email=normalized,
        event_type="unsubscribed",
        metadata={"source": "unsubscribe_link"},
    )
    return {"ok": True, "email": record["recipient_email"]}


def _base_variables_for_recipient(recipient: Dict[str, Any], campaign_id: Optional[str] = None) -> Dict[str, str]:
    email = _normalize_email(recipient.get("email") or recipient.get("recipient_email"))
    name = str(recipient.get("name") or recipient.get("recipient_name") or "").strip()
    clinic_name = str(
        recipient.get("clinicName")
        or recipient.get("clinic_name")
        or recipient.get("officeName")
        or recipient.get("office_name")
        or "your practice"
    ).strip()
    try:
        base_url = (get_config().frontend_base_url or "https://trufusionlabs.com").rstrip("/")
    except Exception:
        base_url = "https://trufusionlabs.com"
    return {
        "doctor_name": name or "Doctor",
        "clinic_name": clinic_name or "your practice",
        "delegate_links_url": f"{base_url}/account?tab=delegate-links",
        "unsubscribe_url": build_unsubscribe_url(email, campaign_id),
        "support_email": "support@trufusionlabs.com",
    }


def _recipient_name(user: Dict[str, Any]) -> str:
    return str(user.get("name") or " ".join(filter(None, [user.get("firstName"), user.get("lastName")])) or "").strip()


def _is_verified_physician(user: Dict[str, Any]) -> bool:
    role = str(user.get("role") or "").strip().lower()
    if role not in ("doctor", "test_doctor"):
        return False
    if str(user.get("status") or "active").strip().lower() in ("disabled", "inactive", "deleted"):
        return False
    return bool(user.get("emailVerifiedAt") or user.get("email_verified_at"))


def _dedupe_recipients(recipients: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: set[str] = set()
    result: List[Dict[str, Any]] = []
    for recipient in recipients:
        email = _normalize_email(recipient.get("email") or recipient.get("recipient_email"))
        if not email or email in seen:
            continue
        seen.add(email)
        result.append(
            {
                "email": email,
                "name": str(recipient.get("name") or recipient.get("recipient_name") or "").strip(),
                "type": str(recipient.get("type") or recipient.get("recipient_type") or "custom").strip() or "custom",
                "variables": dict(recipient.get("variables") or {}),
            }
        )
    return result


def _custom_emails_from_text(value: Any) -> List[str]:
    text = str(value or "")
    pieces = re.split(r"[\s,;]+", text)
    return [_normalize_email(piece) for piece in pieces if _normalize_email(piece)]


def resolve_recipients(selection: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    selected = selection if isinstance(selection, dict) else {}
    mode = str(selected.get("mode") or "test").strip()
    recipients: List[Dict[str, Any]] = []
    if mode == "test":
        email = _require_email(selected.get("testEmail") or selected.get("email"), "A test recipient email is required")
        recipients.append({"email": email, "name": "Test Recipient", "type": "test"})
    elif mode == "selected_physician":
        from ..repositories import user_repository

        email = _require_email(selected.get("selectedPhysicianEmail") or selected.get("email"), "A selected physician email is required")
        user = user_repository.find_by_email(email)
        if not user:
            raise service_error("Selected physician was not found", 404)
        recipients.append({"email": email, "name": _recipient_name(user), "type": "physician"})
    elif mode == "all_verified_physicians":
        from ..repositories import user_repository

        for user in user_repository.get_all():
            if _is_verified_physician(user):
                recipients.append({"email": user.get("email"), "name": _recipient_name(user), "type": "physician"})
    elif mode == "sales_reps":
        from ..repositories import sales_rep_repository

        for rep in sales_rep_repository.get_all():
            if str(rep.get("status") or "active").strip().lower() in ("disabled", "inactive", "deleted"):
                continue
            recipients.append({"email": rep.get("email"), "name": _recipient_name(rep), "type": "sales_rep"})
    elif mode == "custom":
        emails = selected.get("emails")
        if isinstance(emails, list):
            normalized = [_normalize_email(email) for email in emails]
        else:
            normalized = _custom_emails_from_text(selected.get("customEmails") or selected.get("emailList"))
        recipients.extend({"email": email, "name": "", "type": "custom"} for email in normalized if email)
    else:
        raise service_error("Unsupported recipient selection", 400)
    return _dedupe_recipients(recipients)


def _assert_allowed_recipients(template: Dict[str, Any], recipients: List[Dict[str, Any]], selection: Optional[Dict[str, Any]]) -> None:
    allowed = set(template.get("allowed_recipient_groups") or [])
    mode = str((selection or {}).get("mode") or "test")
    mode_to_group = {
        "test": "test",
        "selected_physician": "physicians",
        "all_verified_physicians": "physicians",
        "sales_reps": "sales_reps",
        "custom": "custom",
    }
    group = mode_to_group.get(mode)
    if group and allowed and group not in allowed:
        raise service_error("This template is not approved for the selected recipient group", 400)
    if not recipients:
        raise service_error("Recipient selection produced zero valid recipients", 400)


def preview_template(template_id: str, variables: Optional[Dict[str, Any]] = None, *, admin_id: Optional[str] = None) -> Dict[str, Any]:
    rendered = render_email_template(template_id, variables)
    email_campaign_repository.log_event(
        event_id=_new_id("evt"),
        event_type="previewed",
        metadata={"templateId": template_id, "adminId": admin_id},
    )
    return rendered


def send_test_email(payload: Dict[str, Any], *, admin: Dict[str, Any]) -> Dict[str, Any]:
    admin_id = str(admin.get("id") or "")
    _check_test_rate_limit(admin_id)
    template = get_template(str(payload.get("templateId") or payload.get("template_id") or ""))
    recipient_email = _require_email(payload.get("recipientEmail") or payload.get("recipient_email"))
    subject = str(payload.get("subject") or template.get("default_subject") or "Message from TrufusionLabs").strip()
    variables = normalize_variables(template, payload.get("variables") if isinstance(payload.get("variables"), dict) else {})
    token_variables = {key: value for key, value in variables.items() if key != "unsubscribe_url"}
    variables.update(
        {
            "unsubscribe_url": build_unsubscribe_url(recipient_email),
        }
    )
    rendered = render_email_template(str(template["id"]), variables)
    email_service.send_campaign_test_email(
        recipient_email,
        f"[TEST] {subject}",
        rendered["html"],
        rendered["plainText"],
        headers={
            "X-Trufusion-Campaign-Template": str(template["id"]),
            "X-Trufusion-Campaign-Admin": admin_id,
        },
    )
    email_campaign_repository.log_event(
        event_id=_new_id("evt"),
        event_type="test_sent",
        recipient_email=recipient_email,
        metadata={"templateId": template["id"], "adminId": admin_id},
    )
    test_token, expires_at = _build_test_token(
        admin_id=admin_id,
        template_id=str(template["id"]),
        subject=subject,
        variables=token_variables,
    )
    return {
        "ok": True,
        "testToken": test_token,
        "expiresAt": expires_at,
        "recipientEmail": recipient_email,
    }


def _campaign_to_api(campaign: Dict[str, Any]) -> Dict[str, Any]:
    counts = email_campaign_repository.count_recipients_by_status(str(campaign.get("id") or ""))
    return {
        "id": campaign.get("id"),
        "campaignType": campaign.get("campaign_type"),
        "templateId": campaign.get("template_id"),
        "subject": campaign.get("subject"),
        "createdByAdminId": campaign.get("created_by_admin_id"),
        "status": campaign.get("status"),
        "recipientCount": int(campaign.get("recipient_count") or 0),
        "counts": counts,
        "variables": campaign.get("variables_json") or {},
        "createdAt": campaign.get("created_at"),
        "scheduledAt": campaign.get("scheduled_at"),
        "sentAt": campaign.get("sent_at"),
    }


def _recipient_to_api(recipient: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": recipient.get("id"),
        "campaignId": recipient.get("campaign_id"),
        "recipientEmail": recipient.get("recipient_email"),
        "recipientName": recipient.get("recipient_name"),
        "recipientType": recipient.get("recipient_type"),
        "status": recipient.get("status"),
        "sentAt": recipient.get("sent_at"),
        "errorMessage": recipient.get("error_message"),
    }


def create_campaign(payload: Dict[str, Any], *, admin: Dict[str, Any]) -> Dict[str, Any]:
    template = get_template(str(payload.get("templateId") or payload.get("template_id") or ""))
    subject = str(payload.get("subject") or template.get("default_subject") or "Message from TrufusionLabs").strip()
    if not subject:
        raise service_error("Subject is required", 400)
    requested_status = str(payload.get("status") or "").strip().lower()
    save_as_draft = requested_status == "draft" or bool(payload.get("saveDraft"))
    scheduled_at = _parse_iso(payload.get("scheduledAt") or payload.get("scheduled_at"))
    variables = normalize_variables(template, payload.get("variables") if isinstance(payload.get("variables"), dict) else {})
    recipients = [] if save_as_draft else resolve_recipients(payload.get("recipientSelection") or payload.get("recipient_selection"))
    if not save_as_draft:
        _assert_allowed_recipients(template, recipients, payload.get("recipientSelection") or payload.get("recipient_selection"))
        if str(payload.get("confirmationText") or "").strip() != "SEND":
            raise service_error("Type SEND to confirm this campaign", 400)
        _verify_test_token(
            token=payload.get("testToken") or payload.get("test_token"),
            admin_id=str(admin.get("id") or ""),
            template_id=str(template["id"]),
            subject=subject,
            variables={key: value for key, value in variables.items() if key != "unsubscribe_url"},
        )

    now_iso = _now_iso()
    campaign_id = _new_id("emc")
    status = "draft" if save_as_draft else ("scheduled" if scheduled_at and scheduled_at > _now() else "sending")
    campaign_record = {
        "id": campaign_id,
        "campaign_type": template.get("campaign_type"),
        "template_id": template.get("id"),
        "subject": subject,
        "created_by_admin_id": str(admin.get("id") or ""),
        "status": status,
        "recipient_count": len(recipients),
        "variables_json": variables,
        "created_at": now_iso,
        "scheduled_at": scheduled_at.isoformat().replace("+00:00", "Z") if scheduled_at else None,
        "sent_at": None,
    }
    recipient_records: List[Dict[str, Any]] = []
    for recipient in recipients:
        recipient_variables = {
            **variables,
            **_base_variables_for_recipient(recipient, campaign_id),
            **dict(recipient.get("variables") or {}),
        }
        recipient_records.append(
            {
                "id": _new_id("emr"),
                "campaign_id": campaign_id,
                "recipient_email": recipient["email"],
                "recipient_name": recipient.get("name") or None,
                "recipient_type": recipient.get("type") or "custom",
                "status": "pending",
                "variables_json": recipient_variables,
                "created_at": now_iso,
                "sent_at": None,
                "error_message": None,
            }
        )
    campaign = email_campaign_repository.create_campaign(campaign_record, recipient_records)
    email_campaign_repository.log_event(
        event_id=_new_id("evt"),
        campaign_id=campaign_id,
        event_type="campaign_created" if not save_as_draft else "draft_saved",
        metadata={
            "templateId": template.get("id"),
            "adminId": admin.get("id"),
            "recipientCount": len(recipient_records),
            "status": status,
        },
    )
    return {"campaign": _campaign_to_api(campaign)}


def list_campaigns(*, status: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
    campaigns = email_campaign_repository.list_campaigns(status=status or None, limit=limit)
    return {"campaigns": [_campaign_to_api(campaign) for campaign in campaigns]}


def get_campaign_detail(campaign_id: str) -> Dict[str, Any]:
    campaign = email_campaign_repository.get_campaign(campaign_id)
    if not campaign:
        raise service_error("Campaign not found", 404)
    recipients = email_campaign_repository.list_campaign_recipients(campaign_id)
    events = email_campaign_repository.list_campaign_events(campaign_id)
    return {
        "campaign": _campaign_to_api(campaign),
        "recipients": [_recipient_to_api(recipient) for recipient in recipients],
        "events": events,
    }


def process_pending_campaign_emails(*, limit: int = 25, throttle_seconds: float = 0.25) -> Dict[str, Any]:
    jobs = email_campaign_repository.list_due_pending_recipients(limit=limit)
    processed = 0
    sent = 0
    failed = 0
    skipped = 0
    campaign_ids: set[str] = set()
    for job in jobs:
        processed += 1
        campaign_id = str(job.get("campaign_id") or "")
        campaign_ids.add(campaign_id)
        recipient_id = str(job.get("recipient_id") or "")
        recipient_email = _normalize_email(job.get("recipient_email"))
        if not recipient_email:
            failed += 1
            email_campaign_repository.update_recipient_status(
                recipient_id,
                "failed",
                error_message="Invalid recipient email",
            )
            continue
        if job.get("campaign_status") == "scheduled":
            email_campaign_repository.update_campaign_status(campaign_id, "sending")
        if email_campaign_repository.is_unsubscribed(recipient_email):
            skipped += 1
            email_campaign_repository.update_recipient_status(
                recipient_id,
                "unsubscribed",
                sent_at=_now_iso(),
            )
            email_campaign_repository.log_event(
                event_id=_new_id("evt"),
                campaign_id=campaign_id,
                recipient_email=recipient_email,
                event_type="unsubscribed",
                metadata={"reason": "recipient_unsubscribed"},
            )
            continue
        try:
            variables = {
                **dict(job.get("campaign_variables_json") or {}),
                **dict(job.get("recipient_variables_json") or {}),
            }
            rendered = render_email_template(str(job.get("template_id") or ""), variables)
            email_service.send_campaign_email(
                recipient_email,
                str(job.get("subject") or "Message from TrufusionLabs"),
                rendered["html"],
                rendered["plainText"],
                headers={
                    "X-Trufusion-Campaign-Id": campaign_id,
                    "X-Trufusion-Campaign-Template": str(job.get("template_id") or ""),
                },
            )
            sent += 1
            email_campaign_repository.update_recipient_status(recipient_id, "sent", sent_at=_now_iso())
            email_campaign_repository.log_event(
                event_id=_new_id("evt"),
                campaign_id=campaign_id,
                recipient_email=recipient_email,
                event_type="sent",
                metadata={"templateId": job.get("template_id")},
            )
        except Exception as exc:
            failed += 1
            message = str(exc)[:1000] or exc.__class__.__name__
            logger.exception("Failed to send campaign recipient", extra={"campaignId": campaign_id, "recipient": recipient_email})
            email_campaign_repository.update_recipient_status(
                recipient_id,
                "failed",
                sent_at=_now_iso(),
                error_message=message,
            )
            email_campaign_repository.log_event(
                event_id=_new_id("evt"),
                campaign_id=campaign_id,
                recipient_email=recipient_email,
                event_type="failed",
                metadata={"error": message},
            )
        if throttle_seconds > 0:
            time.sleep(max(0.0, min(float(throttle_seconds), 10.0)))

    for campaign_id in campaign_ids:
        counts = email_campaign_repository.count_recipients_by_status(campaign_id)
        if int(counts.get("pending") or 0) == 0:
            final_status = "failed" if int(counts.get("sent") or 0) == 0 and int(counts.get("failed") or 0) > 0 else "sent"
            email_campaign_repository.update_campaign_status(campaign_id, final_status, sent_at=_now_iso())

    return {
        "ok": True,
        "processed": processed,
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
    }


def _enabled() -> bool:
    raw = str(os.environ.get("EMAIL_CAMPAIGN_WORKER_ENABLED", "true")).strip().lower()
    return raw not in ("0", "false", "no", "off")


def _mode() -> str:
    return str(os.environ.get("EMAIL_CAMPAIGN_WORKER_MODE", "thread")).strip().lower() or "thread"


def _interval_seconds() -> int:
    raw = str(os.environ.get("EMAIL_CAMPAIGN_WORKER_INTERVAL_SECONDS", "30")).strip()
    try:
        value = int(float(raw))
    except Exception:
        value = 30
    return max(5, min(value, 3600))


def _batch_size() -> int:
    raw = str(os.environ.get("EMAIL_CAMPAIGN_WORKER_BATCH_SIZE", "25")).strip()
    try:
        value = int(float(raw))
    except Exception:
        value = 25
    return max(1, min(value, 250))


def _throttle_seconds() -> float:
    raw = str(os.environ.get("EMAIL_CAMPAIGN_WORKER_THROTTLE_SECONDS", "0.25")).strip()
    try:
        value = float(raw)
    except Exception:
        value = 0.25
    return max(0.0, min(value, 10.0))


def get_worker_status() -> Dict[str, Any]:
    return {
        **background_job_supervisor.get_job_status(_JOB_NAME),
        "enabled": _enabled(),
        "mode": _mode(),
        "intervalSeconds": _interval_seconds(),
        "batchSize": _batch_size(),
        "throttleSeconds": _throttle_seconds(),
        "started": _THREAD_STARTED,
    }


def _run_loop() -> None:
    interval_s = _interval_seconds()
    while True:
        try:
            result = process_pending_campaign_emails(limit=_batch_size(), throttle_seconds=_throttle_seconds())
            background_job_supervisor.record_heartbeat(
                _JOB_NAME,
                last_result=result,
                clear_error=True,
                enabled=_enabled(),
                mode="thread",
                intervalSeconds=interval_s,
            )
        except Exception as exc:
            logger.exception("Email campaign worker failed")
            background_job_supervisor.record_heartbeat(
                _JOB_NAME,
                last_error=exc,
                enabled=_enabled(),
                mode="thread",
                intervalSeconds=interval_s,
            )
        time.sleep(interval_s)


def start_email_campaign_worker(*, force: bool = False) -> None:
    interval_s = _interval_seconds()
    if not _enabled():
        background_job_supervisor.set_job_state(
            _JOB_NAME,
            enabled=False,
            mode=_mode(),
            intervalSeconds=interval_s,
            running=False,
            state="disabled",
            reason="disabled",
        )
        return
    if not force and _mode() != "thread":
        background_job_supervisor.set_job_state(
            _JOB_NAME,
            enabled=True,
            mode=_mode(),
            intervalSeconds=interval_s,
            running=False,
            state="external",
            reason="external_mode",
        )
        return
    global _THREAD_STARTED
    with _THREAD_LOCK:
        if _THREAD_STARTED:
            return
        _THREAD_STARTED = True
        background_job_supervisor.start_supervised_job(
            _JOB_NAME,
            _run_loop,
            thread_name="email-campaign-worker",
            restart_delay_seconds=min(60.0, max(5.0, float(interval_s) / 2.0)),
            enabled=True,
            mode="thread",
            intervalSeconds=interval_s,
        )
