from __future__ import annotations

import re

from flask import Blueprint, make_response, request

from ..integrations import ups_tracking
from ..middleware.auth import require_auth

blueprint = Blueprint("tracking", __name__, url_prefix="/api/tracking")


def _sanitize_tracking_number(value: str) -> str:
    raw = str(value or "").strip()
    # Keep alphanumerics only.
    cleaned = re.sub(r"[^A-Za-z0-9]", "", raw).upper()
    return cleaned


@blueprint.get("/status/<tracking_number>")
@require_auth
def get_tracking_status(tracking_number: str):
    normalized = _sanitize_tracking_number(tracking_number)
    if not normalized:
        return make_response({"error": "trackingNumber is required"}, 400)

    carrier = (request.args.get("carrier") or "").strip().lower()
    if carrier and carrier != "ups":
        return make_response({"error": "Unsupported carrier"}, 400)

    # Basic UPS heuristic: UPS tracking numbers commonly start with 1Z.
    effective_carrier = "ups" if carrier == "ups" or normalized.startswith("1Z") else None
    if effective_carrier != "ups":
        return make_response(
            {
                "trackingNumber": normalized,
                "carrier": None,
                "trackingStatus": None,
                "trackingStatusRaw": None,
                "checkedAt": None,
            },
            200,
        )

    info = ups_tracking.fetch_tracking_status(normalized)
    if not info:
        return make_response(
            {
                "carrier": "ups",
                "trackingNumber": normalized,
                "trackingStatus": None,
                "trackingStatusRaw": None,
                "deliveredAt": None,
                "checkedAt": None,
                "error": "UPS_LOOKUP_UNAVAILABLE",
            },
            200,
        )
    return make_response(info, 200)
