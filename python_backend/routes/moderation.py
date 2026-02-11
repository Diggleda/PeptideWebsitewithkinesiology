from __future__ import annotations

import os
import logging
import time
from typing import Any, Dict, Optional

import requests
from flask import Blueprint, jsonify, request

from ..middleware.auth import require_auth

blueprint = Blueprint("moderation", __name__, url_prefix="/api/moderation")

logger = logging.getLogger("peppro.moderation")


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
    started_at = time.perf_counter()
    body = request.get_json(force=True, silent=True) or {}
    data_url = body.get("dataUrl") if isinstance(body, dict) else None
    purpose = body.get("purpose") if isinstance(body, dict) else None

    data_url = str(data_url or "").strip()
    purpose = str(purpose or "").strip() or None

    checked = bool(data_url and (data_url.startswith("data:image/") or data_url.startswith("http://") or data_url.startswith("https://")))
    user_id = None
    try:
        # set by require_auth
        from flask import g  # imported lazily to keep module import light
        user_id = (getattr(g, "current_user", None) or {}).get("id")
    except Exception:
        user_id = None

    debug_enabled = str(os.environ.get("MODERATION_DEBUG") or "").strip().lower() in ("1", "true", "yes", "on")
    if debug_enabled:
        logger.info(
            "moderation.image.request purpose=%s checked=%s userId=%s bytes=%s",
            purpose,
            checked,
            user_id,
            len(data_url) if isinstance(data_url, str) else 0,
        )

    api_key = (os.environ.get("OPENAI_API_KEY") or "").strip()
    if not api_key:
        if debug_enabled:
            logger.info("moderation.image.skipped missing OPENAI_API_KEY purpose=%s userId=%s", purpose, user_id)
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
        if debug_enabled:
            logger.warning("moderation.image.invalid_payload purpose=%s userId=%s", purpose, user_id)
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
        if debug_enabled:
            flagged_categories = None
            if isinstance(categories, dict):
                flagged_categories = [k for k, v in categories.items() if bool(v)]
            duration_ms = (time.perf_counter() - started_at) * 1000
            logger.info(
                "moderation.image.ok purpose=%s userId=%s flagged=%s flaggedCategories=%s status=%s durationMs=%.1f",
                purpose,
                user_id,
                flagged,
                flagged_categories,
                getattr(resp, "status_code", None),
                duration_ms,
            )
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
        if debug_enabled:
            duration_ms = (time.perf_counter() - started_at) * 1000
            logger.exception(
                "moderation.image.error purpose=%s userId=%s durationMs=%.1f",
                purpose,
                user_id,
                duration_ms,
            )
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
