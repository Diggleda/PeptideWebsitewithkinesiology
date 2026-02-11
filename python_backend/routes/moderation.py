from __future__ import annotations

import os
from typing import Any, Dict, Optional

import requests
from flask import Blueprint, jsonify, request

from ..middleware.auth import require_auth

blueprint = Blueprint("moderation", __name__, url_prefix="/api/moderation")


def _extract_openai_moderation_result(payload: Dict[str, Any]) -> tuple[bool, Optional[Dict[str, Any]]]:
    results = payload.get("results")
    if not isinstance(results, list) or not results:
        return False, None
    first = results[0] if isinstance(results[0], dict) else {}
    flagged = bool(first.get("flagged")) if isinstance(first, dict) else False
    categories = first.get("categories") if isinstance(first, dict) else None
    if not isinstance(categories, dict):
        categories = None
    return flagged, categories


@blueprint.post("/image")
@require_auth
def moderate_image():
    body = request.get_json(force=True, silent=True) or {}
    data_url = body.get("dataUrl") if isinstance(body, dict) else None
    purpose = body.get("purpose") if isinstance(body, dict) else None

    data_url = str(data_url or "").strip()
    purpose = str(purpose or "").strip() or None

    checked = bool(data_url and (data_url.startswith("data:image/") or data_url.startswith("http://") or data_url.startswith("https://")))

    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        return jsonify(
            {
                "status": "skipped",
                "flagged": False,
                "purpose": purpose,
                "checked": checked,
                "provider": None,
                "model": None,
                "categories": None,
            }
        )

    if not checked:
        return (
            jsonify(
                {
                    "error": "Invalid image payload; expected a data URL or http(s) URL.",
                    "code": "INVALID_IMAGE",
                }
            ),
            400,
        )

    endpoint = (os.environ.get("OPENAI_MODERATION_URL") or "https://api.openai.com/v1/moderations").strip()
    timeout_seconds = float(os.environ.get("OPENAI_TIMEOUT_MS") or "15000") / 1000.0
    timeout_seconds = max(1.0, min(timeout_seconds, 60.0))

    try:
        resp = requests.post(
            endpoint,
            json={
                "model": "omni-moderation-latest",
                "input": [
                    {
                        "type": "image_url",
                        "image_url": {"url": data_url},
                    }
                ],
            },
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            timeout=timeout_seconds,
        )
        resp.raise_for_status()
        data = resp.json() if resp.content else {}
        flagged, categories = _extract_openai_moderation_result(data if isinstance(data, dict) else {})
        return jsonify(
            {
                "status": "ok",
                "flagged": flagged,
                "purpose": purpose,
                "checked": checked,
                "provider": "openai",
                "model": "omni-moderation-latest",
                "categories": categories,
            }
        )
    except Exception:
        # Fail-open: do not block uploads if moderation is unavailable.
        return jsonify(
            {
                "status": "error",
                "flagged": False,
                "purpose": purpose,
                "checked": checked,
                "provider": "openai",
                "model": "omni-moderation-latest",
                "categories": None,
            }
        )

