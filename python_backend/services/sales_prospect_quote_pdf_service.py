from __future__ import annotations

import base64
import json
import shutil
import subprocess
from pathlib import Path
from typing import Dict

from ..config import BASE_DIR
from ..utils.http import service_error as _service_error

_PDF_BRIDGE_TIMEOUT_SECONDS = 120


def _bridge_script_path() -> Path:
    return BASE_DIR / "server" / "scripts" / "generateProspectQuotePdfCli.js"


def _find_node_binary() -> str:
    binary = shutil.which("node") or shutil.which("nodejs")
    if binary:
        return binary
    raise _service_error("QUOTE_PDF_GENERATOR_UNAVAILABLE", 500)


def generate_prospect_quote_pdf(quote: Dict) -> Dict:
    script_path = _bridge_script_path()
    if not script_path.exists():
        raise _service_error("QUOTE_PDF_GENERATOR_UNAVAILABLE", 500)

    command = [_find_node_binary(), str(script_path)]
    completed = subprocess.run(
        command,
        input=json.dumps({"quote": quote or {}}, ensure_ascii=False),
        capture_output=True,
        text=True,
        cwd=str(BASE_DIR),
        timeout=_PDF_BRIDGE_TIMEOUT_SECONDS,
        check=False,
    )

    if completed.returncode != 0:
        raise _service_error("QUOTE_PDF_GENERATION_FAILED", 500)

    try:
        payload = json.loads(completed.stdout or "{}")
    except Exception as exc:
        raise _service_error("QUOTE_PDF_GENERATION_FAILED", 500) from exc

    pdf_base64 = payload.get("pdfBase64")
    if not isinstance(pdf_base64, str) or not pdf_base64.strip():
        raise _service_error("QUOTE_PDF_GENERATION_FAILED", 500)

    try:
        pdf = base64.b64decode(pdf_base64)
    except Exception as exc:
        raise _service_error("QUOTE_PDF_GENERATION_FAILED", 500) from exc

    filename = str(payload.get("filename") or "PepPro_Quote.pdf").strip() or "PepPro_Quote.pdf"
    return {
        "pdf": pdf,
        "filename": filename,
    }

