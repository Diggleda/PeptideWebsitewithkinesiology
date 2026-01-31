from __future__ import annotations

import re

from flask import Blueprint, make_response, request

from ..integrations import ship_engine, ups_tracking
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
    if carrier and carrier not in ("ups", "ups_walleted", "shipengine"):
        return make_response({"error": "Unsupported carrier"}, 400)

    def normalize_carrier(value: str | None) -> str | None:
        raw = (value or "").strip().lower()
        if raw in ("ups_walleted", "ups-walleted"):
            return "ups"
        if raw == "ups":
            return "ups"
        return None

    inferred = normalize_carrier(carrier) or ("ups" if normalized.startswith("1Z") else None)
    if inferred != "ups":
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

    # Prefer ShipEngine tracking if configured (UPS Track API stalls from some server networks).
    info = None
    if ship_engine.is_configured():
        info = ship_engine.fetch_tracking_status("ups", normalized)

    if not info:
        info = ups_tracking.fetch_tracking_status(normalized)

    if not info:
        return make_response(
            {
                "carrier": inferred,
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
