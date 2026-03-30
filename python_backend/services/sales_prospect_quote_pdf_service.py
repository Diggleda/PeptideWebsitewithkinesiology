from __future__ import annotations

import base64
import glob
import json
import logging
import os
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..config import BASE_DIR
from .invoice_service import _build_simple_text_pdf

logger = logging.getLogger(__name__)

_PDF_BRIDGE_TIMEOUT_SECONDS = 120


def _service_error(message: str, status: int) -> Exception:
    try:
        from ..utils.http import service_error as http_service_error

        return http_service_error(message, status)
    except Exception:
        error = ValueError(message)
        setattr(error, "status", status)
        return error


def _bridge_script_path() -> Path:
    return BASE_DIR / "server" / "scripts" / "generateProspectQuotePdfCli.js"


def _iter_existing_paths(patterns: List[str]) -> List[str]:
    results: List[str] = []
    for pattern in patterns:
        expanded = os.path.expanduser(pattern)
        if any(char in expanded for char in "*?[]"):
            matches = sorted(glob.glob(expanded), reverse=True)
        else:
            matches = [expanded]
        for match in matches:
            if match and os.path.exists(match):
                results.append(match)
    return results


def _find_node_binary() -> Optional[str]:
    candidates = [
        os.environ.get("QUOTE_PDF_NODE_BINARY"),
        os.environ.get("NODE_BINARY"),
        shutil.which("node"),
        shutil.which("nodejs"),
        *_iter_existing_paths(
            [
                "~/.nvm/versions/node/*/bin/node",
                "~/.local/bin/node",
                "/opt/cpanel/ea-nodejs*/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ]
        ),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _find_playwright_browsers_path() -> Optional[str]:
    env_value = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if env_value and os.path.isdir(env_value):
        return env_value

    candidates = _iter_existing_paths(
        [
            str(BASE_DIR / ".playwright-browsers"),
            "~/.cache/ms-playwright",
            "~/Library/Caches/ms-playwright",
            "/root/.cache/ms-playwright",
            "/home/*/.cache/ms-playwright",
            "/Users/*/Library/Caches/ms-playwright",
        ]
    )
    for candidate in candidates:
        try:
            if os.path.isdir(candidate) and any(Path(candidate).iterdir()):
                return candidate
        except Exception:
            continue
    return None


def _allow_text_fallback() -> bool:
    return str(os.environ.get("QUOTE_PDF_ALLOW_TEXT_FALLBACK") or "").strip().lower() in ("1", "true", "yes", "on")


def _safe_text(value: object, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _sanitize_filename(value: object, fallback: str = "Prospect") -> str:
    raw = _safe_text(value, fallback)
    safe = "".join(char if char.isalnum() or char in ("_", "-") else "_" for char in raw)
    safe = safe.strip("_")
    return (safe[:80] or fallback).strip("_") or fallback


def _build_quote_filename(quote: Dict) -> str:
    payload = quote.get("quotePayloadJson") if isinstance(quote.get("quotePayloadJson"), dict) else {}
    prospect = payload.get("prospect") if isinstance(payload.get("prospect"), dict) else {}
    prospect_name = (
        _safe_text(prospect.get("contactName"))
        or _safe_text(prospect.get("name"))
        or _safe_text(prospect.get("identifier"))
        or _safe_text(quote.get("prospectId"))
        or "Prospect"
    )
    try:
        revision = max(1, int(float(quote.get("revisionNumber") or 1)))
    except Exception:
        revision = 1
    return f"PepPro_Quote_{_sanitize_filename(prospect_name)}_{revision}.pdf"


def _as_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _format_money(amount: object, currency: str = "USD") -> str:
    normalized = _safe_text(currency, "USD").upper()
    symbol = "$" if normalized == "USD" else f"{normalized} "
    value = _as_float(amount, 0.0)
    return f"{symbol}{value:,.2f}"


def _format_datetime(value: object) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%b %d, %Y %I:%M %p")
    text = _safe_text(value)
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.strftime("%b %d, %Y %I:%M %p")
    except Exception:
        return text


def _build_fallback_quote_pdf(quote: Dict) -> Dict:
    payload = quote.get("quotePayloadJson") if isinstance(quote.get("quotePayloadJson"), dict) else {}
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    prospect = payload.get("prospect") if isinstance(payload.get("prospect"), dict) else {}
    sales_rep = payload.get("salesRep") if isinstance(payload.get("salesRep"), dict) else {}

    currency = _safe_text(quote.get("currency") or payload.get("currency"), "USD").upper()
    title = _safe_text(quote.get("title") or payload.get("title"), "Quote")
    try:
        revision = max(1, int(float(quote.get("revisionNumber") or 1)))
    except Exception:
        revision = 1
    subtotal = _format_money(quote.get("subtotal") if quote.get("subtotal") is not None else payload.get("subtotal"), currency)
    notes = _safe_text(payload.get("notes"))

    lines: List[str] = [
        "PepPro Quote",
        "",
        title,
        f"Revision R{revision}",
        "",
    ]

    prospect_name = _safe_text(prospect.get("contactName"), "Prospect")
    lines.append(f"Prospect: {prospect_name}")
    prospect_email = _safe_text(prospect.get("contactEmail"))
    if prospect_email:
        lines.append(f"Email: {prospect_email}")
    prospect_phone = _safe_text(prospect.get("contactPhone"))
    if prospect_phone:
        lines.append(f"Phone: {prospect_phone}")

    sales_rep_name = _safe_text(sales_rep.get("name"))
    if sales_rep_name:
        lines.append(f"Sales Rep: {sales_rep_name}")
    sales_rep_email = _safe_text(sales_rep.get("email"))
    if sales_rep_email:
        lines.append(f"Sales Rep Email: {sales_rep_email}")

    updated_at = _format_datetime(quote.get("updatedAt"))
    if updated_at:
        lines.append(f"Updated: {updated_at}")

    if notes:
        lines.append("")
        lines.append("Notes:")
        lines.extend([f"  {line}" for line in notes.splitlines() if line.strip()] or ["  —"])

    lines.append("")
    lines.append("Items:")
    if not items:
        lines.append("  —")
    else:
        for item in items:
            if not isinstance(item, dict):
                continue
            name = _safe_text(item.get("name"), "Item")
            try:
                quantity = max(1, int(float(item.get("quantity") or 1)))
            except Exception:
                quantity = 1
            unit_price = _format_money(item.get("unitPrice"), currency)
            line_total = _format_money(item.get("lineTotal"), currency)
            sku = _safe_text(item.get("sku"))
            sku_part = f" [{sku}]" if sku else ""
            lines.append(f"  {quantity} x {name}{sku_part} @ {unit_price} = {line_total}")
            note = _safe_text(item.get("note"))
            if note:
                lines.append(f"    Note: {note}")

    lines.append("")
    lines.append(f"Subtotal  {subtotal}")

    pdf = _build_simple_text_pdf(lines)
    return {
        "pdf": pdf,
        "filename": _build_quote_filename(quote),
    }


def _run_node_bridge(quote: Dict) -> Optional[Dict]:
    script_path = _bridge_script_path()
    node_binary = _find_node_binary()
    if not script_path.exists() or not node_binary:
        logger.error(
            "Quote PDF node bridge unavailable",
            extra={
                "script_path": str(script_path),
                "script_exists": script_path.exists(),
                "node_binary": node_binary,
            },
        )
        return None

    command = [node_binary, str(script_path)]
    env = os.environ.copy()
    node_dir = str(Path(node_binary).resolve().parent)
    path_parts = [part for part in env.get("PATH", "").split(os.pathsep) if part]
    if node_dir not in path_parts:
        env["PATH"] = os.pathsep.join([node_dir, *path_parts])
    browsers_path = _find_playwright_browsers_path()
    if browsers_path and not env.get("PLAYWRIGHT_BROWSERS_PATH"):
        env["PLAYWRIGHT_BROWSERS_PATH"] = browsers_path

    try:
        completed = subprocess.run(
            command,
            input=json.dumps({"quote": quote or {}}, ensure_ascii=False),
            capture_output=True,
            text=True,
            cwd=str(BASE_DIR),
            env=env,
            timeout=_PDF_BRIDGE_TIMEOUT_SECONDS,
            check=False,
        )
    except Exception:
        logger.exception("Quote PDF node bridge failed to execute")
        return None

    if completed.returncode != 0:
        logger.error(
            "Quote PDF node bridge exited non-zero",
            extra={
                "returncode": completed.returncode,
                "node_binary": node_binary,
                "playwright_browsers_path": env.get("PLAYWRIGHT_BROWSERS_PATH"),
                "stderr": (completed.stderr or "")[:1000],
            },
        )
        return None

    try:
        payload = json.loads(completed.stdout or "{}")
    except Exception:
        logger.exception("Quote PDF node bridge returned invalid JSON")
        return None

    pdf_base64 = payload.get("pdfBase64")
    if not isinstance(pdf_base64, str) or not pdf_base64.strip():
        logger.error("Quote PDF node bridge returned no pdfBase64 payload")
        return None

    try:
        pdf = base64.b64decode(pdf_base64)
    except Exception:
        logger.exception("Quote PDF node bridge returned invalid base64 PDF")
        return None

    filename = _safe_text(payload.get("filename"), _build_quote_filename(quote))
    return {
        "pdf": pdf,
        "filename": filename,
    }


def generate_prospect_quote_pdf(quote: Dict) -> Dict:
    rendered = _run_node_bridge(quote)
    if rendered is not None:
        return rendered
    if _allow_text_fallback():
        logger.warning("Falling back to Python quote PDF generator")
        return _build_fallback_quote_pdf(quote)
    raise _service_error("QUOTE_PDF_RENDERER_UNAVAILABLE", 500)
