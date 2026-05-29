from __future__ import annotations

import base64
import hashlib
import hmac
import html
import imaplib
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
from urllib.parse import quote, urlencode, urlparse

from ..repositories import email_campaign_repository
from . import background_job_supervisor, email_service, get_config, resource_version_service

logger = logging.getLogger(__name__)

_MANIFEST_PATH = Path(__file__).resolve().parents[1] / "email_templates_manifest.json"
_TEMPLATE_ROOT = Path(__file__).resolve().parents[1] / "email_templates"
_VARIABLE_RE = re.compile(r"{{\s*([a-zA-Z0-9_]+)\s*}}")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_TOKEN_TTL_SECONDS = 60 * 60
_PREVIEW_ASSET_TOKEN_TTL_SECONDS = 60 * 60
_TEST_RATE_WINDOW_SECONDS = 15 * 60
_TEST_RATE_LIMIT = 10
_TEST_SENDS: Dict[str, List[float]] = {}
_TEST_SENDS_LOCK = threading.Lock()
_CUSTOM_HTML_VARIABLE_KEY = "__email_center_custom_html"
_MAX_CUSTOM_HTML_LENGTH = 500_000
_PROCESSING_STALE_SECONDS = 15 * 60
_BOUNCE_DIAGNOSTIC_MAX_LENGTH = 1200
_BOUNCE_POLL_LOCK = threading.Lock()
_BOUNCE_LAST_POLL_MONOTONIC = 0.0

_THREAD_STARTED = False
_THREAD_LOCK = threading.Lock()
_KICK_RUNNING = False
_KICK_LOCK = threading.Lock()
_JOB_NAME = "emailCampaignWorker"
_RESOURCE_NAME = "email-campaigns"

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

_RECIPIENT_DYNAMIC_VARIABLES = {
    "doctor_name",
    "clinic_name",
    "delegate_links_url",
    "unsubscribe_url",
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


def _notify_email_campaigns_changed(**metadata: Any) -> None:
    clean_metadata = {key: value for key, value in metadata.items() if value is not None}
    resource_version_service.bump_safe(_RESOURCE_NAME, metadata=clean_metadata or None)


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


def _custom_html_digest(custom_html: Optional[str]) -> str:
    return hashlib.sha256(str(custom_html or "").encode("utf-8")).hexdigest()


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


def _build_test_token(
    *,
    admin_id: str,
    template_id: str,
    subject: str,
    variables: Dict[str, Any],
    custom_html: Optional[str] = None,
) -> Tuple[str, str]:
    expires_at = int(time.time()) + _TOKEN_TTL_SECONDS
    payload = {
        "adminId": admin_id,
        "templateId": template_id,
        "subject": subject,
        "variablesDigest": _variables_digest(variables),
        "customHtmlDigest": _custom_html_digest(custom_html),
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
    custom_html: Optional[str] = None,
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
    if str(payload.get("customHtmlDigest") or _custom_html_digest("")) != _custom_html_digest(custom_html):
        raise service_error("Send a new test email after changing the HTML preview", 400)


def _build_preview_asset_token(content_id: str) -> str:
    expires_at = int(time.time()) + _PREVIEW_ASSET_TOKEN_TTL_SECONDS
    return _sign_payload(
        {
            "scope": "email_preview_asset",
            "contentId": str(content_id or "").strip(),
            "expiresAt": expires_at,
        }
    )


def _verify_preview_asset_token(content_id: str, token: Any) -> None:
    payload = _verify_signed_payload(token)
    if payload.get("scope") != "email_preview_asset":
        raise service_error("Invalid email preview asset token", 403)
    if str(payload.get("contentId") or "") != str(content_id or "").strip():
        raise service_error("Invalid email preview asset token", 403)


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


def _campaign_variables(template: Dict[str, Any], variables: Optional[Dict[str, Any]]) -> Dict[str, str]:
    normalized = normalize_variables(template, variables)
    return {
        key: value
        for key, value in normalized.items()
        if key not in _RECIPIENT_DYNAMIC_VARIABLES
    }


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


def render_preview_html(html_value: str, *, asset_base_url: Optional[str] = None) -> Tuple[str, Dict[str, str]]:
    base_url = str(asset_base_url or "").strip().rstrip("/")
    if not base_url:
        return str(html_value or ""), {}
    rewritten = str(html_value or "")
    asset_urls: Dict[str, str] = {}
    for content_id in email_service.get_inline_email_image_content_ids():
        cid_reference = f"cid:{content_id}"
        if cid_reference not in rewritten:
            continue
        token = _build_preview_asset_token(content_id)
        asset_url = f"{base_url}/{quote(content_id, safe='')}?token={quote(token, safe='')}"
        asset_urls[content_id] = asset_url
        rewritten = rewritten.replace(cid_reference, html.escape(asset_url, quote=True))
    return rewritten, asset_urls


def _strip_campaign_reserved_variables(variables: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    return {
        key: value
        for key, value in dict(variables or {}).items()
        if key != _CUSTOM_HTML_VARIABLE_KEY
    }


def _restore_preview_asset_sources(html_value: str) -> str:
    restored = str(html_value or "")
    for content_id in email_service.get_inline_email_image_content_ids():
        escaped_id = re.escape(quote(content_id, safe=""))
        restored = re.sub(
            rf"(?i)https?://[^\"'<>\s]+/api/admin/email/assets/{escaped_id}(?:\?[^\"'<>\s]*)?",
            f"cid:{content_id}",
            restored,
        )
        restored = re.sub(
            rf"(?i)/api/admin/email/assets/{escaped_id}(?:\?[^\"'<>\s]*)?",
            f"cid:{content_id}",
            restored,
        )
    return restored


def _unwrap_preview_variable_markers(html_value: str) -> str:
    return re.sub(
        r'(?is)<span\b(?=[^>]*\bdata-email-center-variable=(["\']?)([a-zA-Z0-9_]+)\1)[^>]*>.*?</span>',
        lambda match: "{{ " + match.group(2) + " }}",
        str(html_value or ""),
    )


def _restore_variable_placeholders(
    html_value: str,
    template: Dict[str, Any],
    variables: Optional[Dict[str, Any]],
) -> str:
    restored = str(html_value or "")
    supplied = variables if isinstance(variables, dict) else {}
    for variable_name in template.get("variables") or []:
        value = str(supplied.get(variable_name) or _SAMPLE_VARIABLES.get(variable_name) or "")
        if not value:
            continue
        placeholder = "{{ " + str(variable_name) + " }}"
        candidates = {
            value,
            html.escape(value, quote=False),
            html.escape(value, quote=True),
        }
        for candidate in sorted(candidates, key=len, reverse=True):
            if candidate:
                restored = restored.replace(candidate, placeholder)
    return restored


def _normalize_custom_html(
    value: Any,
    *,
    template: Optional[Dict[str, Any]] = None,
    variables: Optional[Dict[str, Any]] = None,
) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip()
    if not normalized:
        return ""
    if len(normalized) > _MAX_CUSTOM_HTML_LENGTH:
        raise service_error("Custom email HTML is too large", 400)
    normalized = re.sub(r"(?is)<script\b[^>]*>.*?</script>", "", normalized)
    normalized = re.sub(
        r'(?is)<style\b(?=[^>]*data-email-center-preview-(?:containment|editor-style))[^>]*>.*?</style>',
        "",
        normalized,
    )
    normalized = re.sub(
        r'(?is)<meta\b(?=[^>]*data-email-center-preview-containment)[^>]*>',
        "",
        normalized,
    )
    normalized = re.sub(
        r'\sdata-email-center-(?:edit-target|editing)(?:=(?:"[^"]*"|\'[^\']*\'|[^\s>]+))?',
        "",
        normalized,
    )
    normalized = re.sub(
        r'\scontenteditable(?:=(?:"[^"]*"|\'[^\']*\'|[^\s>]+))?',
        "",
        normalized,
        flags=re.I,
    )
    normalized = _unwrap_preview_variable_markers(normalized)
    normalized = _restore_preview_asset_sources(normalized)
    if template:
        normalized = _restore_variable_placeholders(normalized, template, variables)
    return normalized


def render_campaign_html(
    template_id: str,
    variables: Optional[Dict[str, Any]] = None,
    *,
    custom_html: Optional[str] = None,
) -> Dict[str, Any]:
    if not custom_html:
        return render_email_template(template_id, variables)
    template = get_template(template_id)
    normalized_variables = normalize_variables(template, variables)

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in normalized_variables:
            return ""
        return _safe_text(normalized_variables.get(name))

    rendered = _VARIABLE_RE.sub(replace, str(custom_html or ""))
    return {
        "template": template,
        "html": rendered,
        "plainText": _plain_text_from_html(rendered),
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
        host = (urlparse(frontend).hostname or "").strip().lower()
        if host in {"trufusionlabs.com", "www.trufusionlabs.com"}:
            return "https://api.trufusionlabs.com/api"
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


def _first_text(*values: Any) -> str:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return text
    return ""


def _nested_text(value: Any, *keys: str) -> str:
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return ""
        current = current.get(key)
    return _first_text(current)


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


def unsubscribe_landing_url(email: Optional[str] = None, *, status: str = "success") -> str:
    try:
        frontend = str(get_config().frontend_base_url or "").strip().rstrip("/")
    except Exception:
        frontend = ""
    if not frontend:
        frontend = "https://www.trufusionlabs.com"
    params = {"email_unsubscribed": "1", "status": status}
    normalized = _normalize_email(email)
    if normalized:
        params["email"] = normalized
    return f"{frontend}/?{urlencode(params)}"


def _base_variables_for_recipient(recipient: Dict[str, Any], campaign_id: Optional[str] = None) -> Dict[str, str]:
    email = _normalize_email(recipient.get("email") or recipient.get("recipient_email"))
    recipient_type = str(recipient.get("type") or recipient.get("recipient_type") or "").strip().lower()
    name = _first_text(
        recipient.get("name"),
        recipient.get("recipient_name"),
        recipient.get("fullName"),
        recipient.get("full_name"),
        recipient.get("npiProviderName"),
        recipient.get("npi_provider_name"),
        _nested_text(recipient.get("npiVerification"), "name"),
        _nested_text(recipient.get("npi_verification"), "name"),
    )
    clinic_name = _first_text(
        recipient.get("clinicName"),
        recipient.get("clinic_name"),
        recipient.get("officeName"),
        recipient.get("office_name"),
        recipient.get("practiceName"),
        recipient.get("practice_name"),
        recipient.get("companyName"),
        recipient.get("company_name"),
        recipient.get("company"),
        recipient.get("npiClinicName"),
        recipient.get("npi_clinic_name"),
        _nested_text(recipient.get("npiVerification"), "organizationName"),
        _nested_text(recipient.get("npi_verification"), "organizationName"),
        _nested_text(recipient.get("npiVerification"), "basic", "organization_name"),
        _nested_text(recipient.get("npi_verification"), "basic", "organization_name"),
    )
    try:
        base_url = (get_config().frontend_base_url or "https://trufusionlabs.com").rstrip("/")
    except Exception:
        base_url = "https://trufusionlabs.com"
    default_name = "Doctor" if recipient_type in {"physician", "doctor"} else "there"
    return {
        "doctor_name": name or default_name,
        "clinic_name": clinic_name or "your practice",
        "delegate_links_url": f"{base_url}/account?tab=delegate-links",
        "unsubscribe_url": build_unsubscribe_url(email, campaign_id),
    }


def _recipient_name(user: Dict[str, Any]) -> str:
    return str(
        user.get("name")
        or " ".join(
            filter(
                None,
                [
                    user.get("firstName") or user.get("first_name"),
                    user.get("lastName") or user.get("last_name"),
                ],
            )
        )
        or ""
    ).strip()


def _is_verified_physician(user: Dict[str, Any]) -> bool:
    role = str(user.get("role") or "").strip().lower()
    if role != "doctor":
        return False
    if str(user.get("status") or "active").strip().lower() in ("disabled", "inactive", "deleted"):
        return False
    return True


def _dedupe_recipients(recipients: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    seen: set[str] = set()
    result: List[Dict[str, Any]] = []
    for recipient in recipients:
        email = _normalize_email(recipient.get("email") or recipient.get("recipient_email"))
        if not email or email in seen:
            continue
        seen.add(email)
        normalized = dict(recipient)
        normalized["email"] = email
        normalized["name"] = str(recipient.get("name") or recipient.get("recipient_name") or "").strip()
        normalized["type"] = str(recipient.get("type") or recipient.get("recipient_type") or "custom").strip() or "custom"
        normalized["variables"] = dict(recipient.get("variables") or {})
        result.append(normalized)
    return result


def _recipient_from_user(user: Dict[str, Any]) -> Dict[str, Any]:
    return {
        **dict(user or {}),
        "email": (user or {}).get("email"),
        "name": _recipient_name(user or {}),
        "type": "physician",
    }


def _recipient_from_sales_rep(rep: Dict[str, Any]) -> Dict[str, Any]:
    return {
        **dict(rep or {}),
        "email": (rep or {}).get("email"),
        "name": _recipient_name(rep or {}),
        "type": "sales_rep",
    }


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
        recipients.append(_recipient_from_user({**user, "email": email}))
    elif mode == "all_verified_physicians":
        from ..repositories import user_repository

        for user in user_repository.get_all():
            if _is_verified_physician(user):
                recipients.append(_recipient_from_user(user))
    elif mode == "sales_reps":
        from ..repositories import sales_rep_repository

        for rep in sales_rep_repository.get_all():
            if str(rep.get("status") or "active").strip().lower() in ("disabled", "inactive", "deleted"):
                continue
            recipients.append(_recipient_from_sales_rep(rep))
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


def _estimate_draft_recipients(selection: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    try:
        return resolve_recipients(selection)
    except Exception as exc:
        status = int(getattr(exc, "status", 500) or 500)
        if status in {400, 404}:
            return []
        raise


def estimate_recipients(payload: Dict[str, Any]) -> Dict[str, Any]:
    selected = payload if isinstance(payload, dict) else {}
    selection = selected.get("recipientSelection") or selected.get("recipient_selection")
    if not isinstance(selection, dict):
        selection = {"mode": selected.get("mode") or "test"}
    mode = str(selection.get("mode") or "test").strip()
    template_id = str(selected.get("templateId") or selected.get("template_id") or "").strip()
    recipients = _estimate_draft_recipients(selection)
    if template_id:
        template = get_template(template_id)
        allowed = set(template.get("allowed_recipient_groups") or [])
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
    recipient_payloads = []
    for recipient in recipients:
        preview_variables = _base_variables_for_recipient(recipient)
        recipient_payloads.append(
            {
                "email": recipient.get("email"),
                "name": recipient.get("name") or "",
                "type": recipient.get("type") or "",
                "clinicName": preview_variables.get("clinic_name") or "",
                "variables": preview_variables,
            }
        )
    return {
        "mode": mode,
        "recipientCount": len(recipients),
        "recipients": recipient_payloads,
    }


def preview_template(
    template_id: str,
    variables: Optional[Dict[str, Any]] = None,
    *,
    admin_id: Optional[str] = None,
    asset_base_url: Optional[str] = None,
    custom_html: Optional[str] = None,
) -> Dict[str, Any]:
    template = get_template(template_id)
    normalized_variables = normalize_variables(template, variables)
    normalized_custom_html = _normalize_custom_html(
        custom_html,
        template=template,
        variables=normalized_variables,
    )
    rendered = render_campaign_html(template_id, normalized_variables, custom_html=normalized_custom_html)
    preview_html, asset_urls = render_preview_html(rendered["html"], asset_base_url=asset_base_url)
    rendered = {
        **rendered,
        "html": preview_html,
        "customHtml": normalized_custom_html or None,
        "previewAssetUrls": asset_urls,
    }
    email_campaign_repository.log_event(
        event_id=_new_id("evt"),
        event_type="previewed",
        metadata={"templateId": template_id, "adminId": admin_id},
    )
    return rendered


def get_preview_asset(content_id: str, token: Any) -> Dict[str, Any]:
    normalized = str(content_id or "").strip()
    if normalized not in set(email_service.get_inline_email_image_content_ids()):
        raise service_error("Email preview asset not found", 404)
    _verify_preview_asset_token(normalized, token)
    image = email_service.get_inline_email_image(normalized)
    if not image:
        raise service_error("Email preview asset is missing", 404)
    return image


def send_test_email(payload: Dict[str, Any], *, admin: Dict[str, Any]) -> Dict[str, Any]:
    admin_id = str(admin.get("id") or "")
    _check_test_rate_limit(admin_id)
    template = get_template(str(payload.get("templateId") or payload.get("template_id") or ""))
    recipient_email = _require_email(payload.get("recipientEmail") or payload.get("recipient_email"))
    subject = str(payload.get("subject") or template.get("default_subject") or "Message from TrufusionLabs").strip()
    variables = normalize_variables(template, payload.get("variables") if isinstance(payload.get("variables"), dict) else {})
    custom_html = _normalize_custom_html(payload.get("customHtml") or payload.get("custom_html"), template=template, variables=variables)
    token_variables = _campaign_variables(template, variables)
    variables.update(
        {
            "unsubscribe_url": build_unsubscribe_url(recipient_email),
        }
    )
    rendered = render_campaign_html(str(template["id"]), variables, custom_html=custom_html)
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
        custom_html=custom_html,
    )
    return {
        "ok": True,
        "testToken": test_token,
        "expiresAt": expires_at,
        "recipientEmail": recipient_email,
        "recipientCount": 1,
    }


def _campaign_status_from_counts(campaign: Dict[str, Any], counts: Dict[str, Any]) -> str:
    current_status = str(campaign.get("status") or "")
    if current_status in {"draft", "scheduled"}:
        return current_status
    sent = int(counts.get("sent") or 0)
    failed = int(counts.get("failed") or 0) + int(counts.get("bounced") or 0)
    unsubscribed = int(counts.get("unsubscribed") or 0)
    pending = int(counts.get("pending") or 0)
    processing = int(counts.get("processing") or 0)
    known_total = sent + failed + unsubscribed + pending + processing
    total = max(int(campaign.get("recipient_count") or 0), known_total)
    if total <= 0:
        return current_status or "draft"
    if pending > 0 or processing > 0:
        return "sending"
    if failed > 0 and sent == 0 and unsubscribed == 0:
        return "failed"
    if sent > 0 or failed > 0 or unsubscribed > 0:
        return "sent"
    return current_status or "sending"


def _reconcile_campaign_status(campaign: Dict[str, Any], counts: Dict[str, Any]) -> str:
    campaign_id = str(campaign.get("id") or "")
    current_status = str(campaign.get("status") or "")
    next_status = _campaign_status_from_counts(campaign, counts)
    if campaign_id and next_status and next_status != current_status:
        sent_at = _now_iso() if next_status in {"sent", "failed"} else None
        email_campaign_repository.update_campaign_status(campaign_id, next_status, sent_at=sent_at)
        campaign["status"] = next_status
        if sent_at and not campaign.get("sent_at"):
            campaign["sent_at"] = sent_at
    return str(campaign.get("status") or next_status)


def _requeue_stale_processing_recipients() -> int:
    cutoff = (_now() - timedelta(seconds=_PROCESSING_STALE_SECONDS)).isoformat().replace("+00:00", "Z")
    requeued = email_campaign_repository.requeue_stale_processing_recipients(cutoff)
    if requeued:
        _notify_email_campaigns_changed(event="stale_campaign_recipients_requeued", requeued=requeued)
    return int(requeued or 0)


def _campaign_to_api(campaign: Dict[str, Any]) -> Dict[str, Any]:
    counts = email_campaign_repository.count_recipients_by_status(str(campaign.get("id") or ""))
    status = _reconcile_campaign_status(campaign, counts)
    variables = dict(campaign.get("variables_json") or {})
    custom_html = str(variables.pop(_CUSTOM_HTML_VARIABLE_KEY, "") or "")
    variables = _strip_campaign_reserved_variables(variables)
    return {
        "id": campaign.get("id"),
        "campaignType": campaign.get("campaign_type"),
        "templateId": campaign.get("template_id"),
        "subject": campaign.get("subject"),
        "createdByAdminId": campaign.get("created_by_admin_id"),
        "status": status,
        "recipientCount": int(campaign.get("recipient_count") or 0),
        "counts": counts,
        "variables": variables,
        "customHtml": custom_html or None,
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
    normalized_variables = normalize_variables(template, payload.get("variables") if isinstance(payload.get("variables"), dict) else {})
    custom_html = _normalize_custom_html(
        payload.get("customHtml") or payload.get("custom_html"),
        template=template,
        variables=normalized_variables,
    )
    variables = _campaign_variables(template, normalized_variables)
    recipient_selection = payload.get("recipientSelection") or payload.get("recipient_selection")
    recipients = _estimate_draft_recipients(recipient_selection) if save_as_draft else resolve_recipients(recipient_selection)
    selection_for_mode = recipient_selection if isinstance(recipient_selection, dict) else {}
    recipient_mode = str(selection_for_mode.get("mode") or "test").strip()
    requires_test_token = recipient_mode != "test"
    if not save_as_draft:
        _assert_allowed_recipients(template, recipients, recipient_selection)
        if str(payload.get("confirmationText") or "").strip() != "SEND":
            raise service_error("Type SEND to confirm this campaign", 400)
        if requires_test_token:
            _verify_test_token(
                token=payload.get("testToken") or payload.get("test_token"),
                admin_id=str(admin.get("id") or ""),
                template_id=str(template["id"]),
                subject=subject,
                variables=variables,
                custom_html=custom_html,
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
        "variables_json": {
            **variables,
            **({_CUSTOM_HTML_VARIABLE_KEY: custom_html} if custom_html else {}),
        },
        "created_at": now_iso,
        "scheduled_at": scheduled_at.isoformat().replace("+00:00", "Z") if scheduled_at else None,
        "sent_at": None,
    }
    recipient_records: List[Dict[str, Any]] = []
    for recipient in ([] if save_as_draft else recipients):
        recipient_variables = {
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
            "recipientCount": len(recipients),
            "scheduledAt": campaign_record.get("scheduled_at"),
            "status": status,
        },
    )
    _notify_email_campaigns_changed(
        event="campaign_created" if not save_as_draft else "draft_saved",
        campaignId=campaign_id,
        status=status,
    )
    if not save_as_draft:
        if status == "sending":
            kick_due_campaign_processing()
        ensure_email_campaign_worker_started()
    return {"campaign": _campaign_to_api(campaign)}


def delete_draft_campaign(campaign_id: str, *, admin: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    campaign = email_campaign_repository.get_campaign(str(campaign_id or ""))
    if not campaign:
        raise service_error("Campaign not found", 404)
    if str(campaign.get("status") or "") != "draft":
        raise service_error("Only draft campaigns can be deleted", 400)
    deleted = email_campaign_repository.delete_draft_campaign(str(campaign.get("id") or campaign_id))
    if not deleted:
        raise service_error("Draft campaign could not be deleted", 409)
    email_campaign_repository.log_event(
        event_id=_new_id("evt"),
        campaign_id=str(campaign.get("id") or campaign_id),
        event_type="draft_deleted",
        metadata={
            "templateId": campaign.get("template_id"),
            "adminId": (admin or {}).get("id"),
        },
    )
    _notify_email_campaigns_changed(event="draft_deleted", campaignId=str(campaign.get("id") or campaign_id))
    return {"ok": True, "deleted": True, "campaignId": campaign.get("id") or campaign_id}


def list_campaigns(*, status: Optional[str] = None, limit: int = 50) -> Dict[str, Any]:
    _requeue_stale_processing_recipients()
    promoted = email_campaign_repository.promote_due_scheduled_campaigns()
    if promoted > 0:
        _notify_email_campaigns_changed(event="scheduled_campaigns_due", promoted=promoted)
        kick_due_campaign_processing()
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


def _extract_header_value(raw_message: str, header_name: str) -> str:
    pattern = re.compile(rf"(?im)^{re.escape(header_name)}:\s*(.*(?:\n[ \t].*)*)")
    match = pattern.search(raw_message or "")
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()


def _extract_bounce_diagnostic(raw_message: str) -> str:
    match = re.search(
        r"(?ims)^Diagnostic-Code:\s*(.*?)(?=^[A-Za-z][A-Za-z0-9-]{0,80}:\s|\Z)",
        raw_message or "",
    )
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()[:_BOUNCE_DIAGNOSTIC_MAX_LENGTH]


def _extract_bounce_campaign_id(raw_message: str, explicit: Any = None) -> str:
    explicit_text = str(explicit or "").strip()
    if explicit_text:
        return explicit_text
    header_value = _extract_header_value(raw_message, "X-Trufusion-Campaign-Id")
    if header_value:
        return header_value.split()[0].strip()
    match = re.search(r"\bemc_[a-zA-Z0-9]+\b", raw_message or "")
    return match.group(0) if match else ""


def _extract_first_email(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    email = _normalize_email(text)
    if email:
        return email
    match = re.search(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b", text)
    return _normalize_email(match.group(0) if match else "")


def _extract_bounce_recipient(raw_message: str, explicit: Any = None) -> str:
    explicit_email = _extract_first_email(explicit)
    if explicit_email:
        return explicit_email
    for header_name in ("Final-Recipient", "Original-Recipient", "X-Failed-Recipients", "To"):
        header_value = _extract_header_value(raw_message, header_name)
        if not header_value:
            continue
        if ";" in header_value:
            header_value = header_value.rsplit(";", 1)[-1]
        email = _extract_first_email(header_value)
        if email:
            return email
    return _extract_first_email(raw_message)


def _parse_bounce_notification(payload: Dict[str, Any]) -> Dict[str, str]:
    raw_message = str(
        payload.get("rawEmail")
        or payload.get("raw_email")
        or payload.get("rawMessage")
        or payload.get("raw_message")
        or payload.get("message")
        or ""
    )
    campaign_id = _extract_bounce_campaign_id(raw_message, payload.get("campaignId") or payload.get("campaign_id"))
    recipient_email = _extract_bounce_recipient(raw_message, payload.get("recipientEmail") or payload.get("recipient_email"))
    status_code = str(payload.get("status") or _extract_header_value(raw_message, "Status") or "").strip()
    action = str(payload.get("action") or _extract_header_value(raw_message, "Action") or "").strip().lower()
    diagnostic = str(payload.get("diagnostic") or _extract_bounce_diagnostic(raw_message) or "").strip()
    message_id = str(
        payload.get("messageId")
        or payload.get("message_id")
        or _extract_header_value(raw_message, "X-Original-Message-ID")
        or _extract_header_value(raw_message, "Message-ID")
        or ""
    ).strip()
    if not campaign_id:
        raise service_error("Bounce message did not include a campaign id", 400)
    if not recipient_email:
        raise service_error("Bounce message did not include a failed recipient", 400)
    return {
        "campaignId": campaign_id,
        "recipientEmail": recipient_email,
        "status": status_code,
        "action": action,
        "diagnostic": diagnostic,
        "messageId": message_id,
    }


def process_bounce_notification(payload: Dict[str, Any], *, admin: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    parsed = _parse_bounce_notification(payload if isinstance(payload, dict) else {})
    campaign_id = parsed["campaignId"]
    recipient_email = parsed["recipientEmail"]
    campaign = email_campaign_repository.get_campaign(campaign_id)
    if not campaign:
        raise service_error("Campaign from bounce was not found", 404)
    diagnostic = parsed.get("diagnostic") or parsed.get("status") or "Delivery failure"
    action = str(parsed.get("action") or "").strip().lower()
    status_text = str(parsed.get("status") or "").strip()
    if action and action not in {"failed", "failure"} and not status_text.startswith("5."):
        raise service_error("Bounce message was not a permanent delivery failure", 400)
    recipient = email_campaign_repository.get_recipient_by_campaign_and_email(campaign_id, recipient_email)
    if not recipient:
        raise service_error("Failed recipient from bounce was not found in this campaign", 404)
    current_recipient_status = str(recipient.get("status") or "").strip().lower()
    if current_recipient_status in {"failed", "bounced"}:
        counts = email_campaign_repository.count_recipients_by_status(campaign_id)
        _reconcile_campaign_status(campaign, counts)
        return {
            "ok": True,
            "duplicate": True,
            "campaignId": campaign_id,
            "recipientEmail": recipient_email,
            "recipientStatus": current_recipient_status,
            "status": parsed.get("status"),
            "action": parsed.get("action"),
            "diagnostic": diagnostic,
            "counts": counts,
        }
    updated = email_campaign_repository.update_recipient_status_by_campaign_and_email(
        campaign_id,
        recipient_email,
        "failed",
        sent_at=_now_iso(),
        error_message=diagnostic,
    )
    if not updated:
        raise service_error("Failed recipient from bounce was not found in this campaign", 404)
    email_campaign_repository.log_event(
        event_id=_new_id("evt"),
        campaign_id=campaign_id,
        recipient_email=recipient_email,
        event_type="bounced",
        metadata={
            "status": parsed.get("status"),
            "action": parsed.get("action"),
            "diagnostic": diagnostic,
            "messageId": parsed.get("messageId"),
            "adminId": (admin or {}).get("id"),
        },
    )
    counts = email_campaign_repository.count_recipients_by_status(campaign_id)
    _reconcile_campaign_status(campaign, counts)
    _notify_email_campaigns_changed(event="campaign_bounce_processed", campaignId=campaign_id, recipientEmail=recipient_email)
    return {
        "ok": True,
        "campaignId": campaign_id,
        "recipientEmail": recipient_email,
        "recipientStatus": "failed",
        "status": parsed.get("status"),
        "action": parsed.get("action"),
        "diagnostic": diagnostic,
        "counts": counts,
    }


def verify_bounce_webhook_secret(token: Any) -> None:
    expected = str(os.environ.get("EMAIL_BOUNCE_WEBHOOK_SECRET") or "").strip()
    if not expected:
        raise service_error("Bounce webhook is not configured", 404)
    supplied = str(token or "").strip()
    if not supplied or not hmac.compare_digest(supplied, expected):
        raise service_error("Invalid bounce webhook token", 403)


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on", "enabled"}


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = str(os.environ.get(name) or "").strip()
    try:
        value = int(float(raw)) if raw else default
    except Exception:
        value = default
    return max(minimum, min(value, maximum))


def _bounce_imap_settings() -> Dict[str, Any]:
    user = str(os.environ.get("EMAIL_BOUNCE_IMAP_USER") or os.environ.get("IMAP_USER") or "").strip()
    password = str(os.environ.get("EMAIL_BOUNCE_IMAP_PASS") or os.environ.get("IMAP_PASS") or "").strip()
    host = str(os.environ.get("EMAIL_BOUNCE_IMAP_HOST") or os.environ.get("IMAP_HOST") or "").strip()
    use_ssl = _env_bool("EMAIL_BOUNCE_IMAP_SSL", True)
    if not host and user:
        host = "imap.gmail.com"
    return {
        "host": host,
        "port": _env_int("EMAIL_BOUNCE_IMAP_PORT", 993 if use_ssl else 143, minimum=1, maximum=65535),
        "user": user,
        "password": password,
        "mailbox": str(os.environ.get("EMAIL_BOUNCE_IMAP_MAILBOX") or "INBOX").strip() or "INBOX",
        "ssl": use_ssl,
        "timeout": _env_int("EMAIL_BOUNCE_IMAP_TIMEOUT_SECONDS", 15, minimum=3, maximum=120),
        "searchDays": _env_int("EMAIL_BOUNCE_IMAP_SEARCH_DAYS", 14, minimum=1, maximum=30),
        "limit": _env_int("EMAIL_BOUNCE_IMAP_MAX_MESSAGES", 50, minimum=1, maximum=500),
        "markSeen": _env_bool("EMAIL_BOUNCE_IMAP_MARK_SEEN", False),
    }


def _bounce_imap_configured(settings: Optional[Dict[str, Any]] = None) -> bool:
    selected = settings or _bounce_imap_settings()
    return bool(selected.get("host") and selected.get("user") and selected.get("password"))


def _bounce_poll_enabled(settings: Optional[Dict[str, Any]] = None) -> bool:
    selected = settings or _bounce_imap_settings()
    configured = _bounce_imap_configured(selected)
    raw = os.environ.get("EMAIL_BOUNCE_POLL_ENABLED")
    if raw is None or str(raw).strip() == "":
        return configured
    return _env_bool("EMAIL_BOUNCE_POLL_ENABLED", False) and configured


def _bounce_poll_interval_seconds() -> int:
    return _env_int("EMAIL_BOUNCE_POLL_INTERVAL_SECONDS", 60, minimum=30, maximum=3600)


def _looks_like_bounce_notification(raw_message: str) -> bool:
    text = str(raw_message or "")
    lower = text.lower()
    if "x-trufusion-campaign-id:" not in lower and not re.search(r"\bemc_[a-z0-9]+\b", lower):
        return False
    return any(
        marker in lower
        for marker in (
            "final-recipient:",
            "x-failed-recipients:",
            "diagnostic-code:",
            "delivery status notification",
            "undelivered",
            "address not found",
            "mailer-daemon",
        )
    )


def _raw_text_from_imap_fetch(fetch_data: Any) -> str:
    for part in fetch_data or []:
        if isinstance(part, tuple) and len(part) >= 2:
            payload = part[1]
            if isinstance(payload, bytes):
                return payload.decode("utf-8", "replace")
            if isinstance(payload, str):
                return payload
    return ""


def poll_bounce_mailbox(*, force: bool = False) -> Dict[str, Any]:
    settings = _bounce_imap_settings()
    configured = _bounce_imap_configured(settings)
    enabled = _bounce_poll_enabled(settings)
    if not enabled:
        return {
            "ok": True,
            "enabled": False,
            "configured": configured,
            "processed": 0,
            "duplicates": 0,
            "matched": 0,
            "scanned": 0,
            "failed": 0,
            "skipped": 0,
        }

    interval_s = _bounce_poll_interval_seconds()
    now_monotonic = time.monotonic()
    global _BOUNCE_LAST_POLL_MONOTONIC
    with _BOUNCE_POLL_LOCK:
        if not force and _BOUNCE_LAST_POLL_MONOTONIC and now_monotonic - _BOUNCE_LAST_POLL_MONOTONIC < interval_s:
            return {
                "ok": True,
                "enabled": True,
                "configured": True,
                "skipped": True,
                "processed": 0,
                "matched": 0,
                "scanned": 0,
            }
        _BOUNCE_LAST_POLL_MONOTONIC = now_monotonic

    scanned = 0
    matched = 0
    processed = 0
    duplicates = 0
    skipped = 0
    failed = 0
    client = None
    try:
        if settings.get("ssl"):
            client = imaplib.IMAP4_SSL(
                str(settings["host"]),
                int(settings["port"]),
                timeout=int(settings["timeout"]),
            )
        else:
            client = imaplib.IMAP4(str(settings["host"]), int(settings["port"]), timeout=int(settings["timeout"]))
        client.login(str(settings["user"]), str(settings["password"]))
        client.select(str(settings["mailbox"]), readonly=not bool(settings.get("markSeen")))
        since = (_now() - timedelta(days=int(settings["searchDays"]))).strftime("%d-%b-%Y")
        status, search_data = client.search(None, "SINCE", since)
        if str(status).upper() != "OK":
            raise RuntimeError(f"Bounce mailbox search failed: {status}")
        message_ids = (search_data[0].split() if search_data and search_data[0] else [])[-int(settings["limit"]):]
        for message_id in message_ids:
            fetch_status, fetch_data = client.fetch(message_id, "(RFC822)")
            if str(fetch_status).upper() != "OK":
                failed += 1
                continue
            scanned += 1
            raw_message = _raw_text_from_imap_fetch(fetch_data)
            if not _looks_like_bounce_notification(raw_message):
                continue
            matched += 1
            try:
                result = process_bounce_notification({"rawEmail": raw_message, "source": "imap"})
                if result.get("duplicate"):
                    duplicates += 1
                else:
                    processed += 1
                    if settings.get("markSeen"):
                        client.store(message_id, "+FLAGS", "\\Seen")
            except Exception as exc:
                status_code = int(getattr(exc, "status", 500) or 500)
                if status_code in {400, 404}:
                    skipped += 1
                    continue
                failed += 1
                logger.warning("Failed to process campaign bounce message", exc_info=True)
    except Exception as exc:
        logger.exception("Email campaign bounce mailbox poll failed")
        return {
            "ok": False,
            "enabled": True,
            "configured": True,
            "error": str(exc)[:500],
            "processed": processed,
            "duplicates": duplicates,
            "matched": matched,
            "scanned": scanned,
            "failed": failed,
            "skipped": skipped,
        }
    finally:
        if client is not None:
            try:
                client.logout()
            except Exception:
                pass

    if processed:
        _notify_email_campaigns_changed(event="campaign_bounces_polled", processed=processed)
    return {
        "ok": True,
        "enabled": True,
        "configured": True,
        "processed": processed,
        "duplicates": duplicates,
        "matched": matched,
        "scanned": scanned,
        "failed": failed,
        "skipped": skipped,
    }


def process_pending_campaign_emails(*, limit: int = 25, throttle_seconds: float = 0.25) -> Dict[str, Any]:
    bounce_poll = poll_bounce_mailbox()
    _requeue_stale_processing_recipients()
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
            campaign_variables = dict(job.get("campaign_variables_json") or {})
            custom_html = str(campaign_variables.pop(_CUSTOM_HTML_VARIABLE_KEY, "") or "")
            variables = {
                **campaign_variables,
                **dict(job.get("recipient_variables_json") or {}),
            }
            rendered = render_campaign_html(str(job.get("template_id") or ""), variables, custom_html=custom_html)
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
        campaign = email_campaign_repository.get_campaign(campaign_id) or {"id": campaign_id, "status": "sending"}
        counts = email_campaign_repository.count_recipients_by_status(campaign_id)
        _reconcile_campaign_status(campaign, counts)

    if processed > 0:
        _notify_email_campaigns_changed(event="campaign_recipients_processed", processed=processed, sent=sent, failed=failed, skipped=skipped)

    return {
        "ok": True,
        "processed": processed,
        "sent": sent,
        "failed": failed,
        "skipped": skipped,
        "bouncesProcessed": int((bounce_poll or {}).get("processed") or 0),
        "bouncePoll": bounce_poll,
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
    bounce_settings = _bounce_imap_settings()
    worker_status = background_job_supervisor.get_job_status(_JOB_NAME)
    last_result = worker_status.get("lastResult") if isinstance(worker_status.get("lastResult"), dict) else {}
    return {
        **worker_status,
        "enabled": _enabled(),
        "mode": _mode(),
        "intervalSeconds": _interval_seconds(),
        "batchSize": _batch_size(),
        "throttleSeconds": _throttle_seconds(),
        "bouncePollingEnabled": _bounce_poll_enabled(bounce_settings),
        "bounceMailboxConfigured": _bounce_imap_configured(bounce_settings),
        "bouncePollIntervalSeconds": _bounce_poll_interval_seconds(),
        "bouncePollLastResult": last_result.get("bouncePoll") if isinstance(last_result, dict) else None,
        "started": _THREAD_STARTED,
        "kickRunning": _KICK_RUNNING,
    }


def _run_kick_loop() -> None:
    global _KICK_RUNNING
    try:
        deadline = time.monotonic() + 300.0
        while time.monotonic() < deadline:
            result = process_pending_campaign_emails(limit=_batch_size(), throttle_seconds=_throttle_seconds())
            background_job_supervisor.record_heartbeat(
                _JOB_NAME,
                last_result={**result, "source": "kick"},
                clear_error=True,
                enabled=_enabled(),
                mode=_mode(),
                intervalSeconds=_interval_seconds(),
            )
            if int(result.get("processed") or 0) <= 0:
                break
            time.sleep(1.0)
    except Exception as exc:
        logger.exception("Email campaign kick worker failed")
        background_job_supervisor.record_heartbeat(
            _JOB_NAME,
            last_error=exc,
            enabled=_enabled(),
            mode=_mode(),
            intervalSeconds=_interval_seconds(),
        )
    finally:
        with _KICK_LOCK:
            _KICK_RUNNING = False


def kick_due_campaign_processing() -> None:
    global _KICK_RUNNING
    if not _enabled():
        return
    if _THREAD_STARTED:
        return
    with _KICK_LOCK:
        if _KICK_RUNNING:
            return
        _KICK_RUNNING = True
    worker = threading.Thread(target=_run_kick_loop, name="email-campaign-kick", daemon=True)
    worker.start()


def ensure_email_campaign_worker_started() -> None:
    if not _enabled() or _THREAD_STARTED:
        return
    try:
        start_email_campaign_worker(force=True)
    except Exception:
        logger.exception("Failed to start email campaign worker")


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
