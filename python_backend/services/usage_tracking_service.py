from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..repositories import usage_tracking_repository


def track_event(event: str, *, actor: Optional[Dict[str, Any]] = None, metadata: Optional[Dict[str, Any]] = None) -> None:
    name = str(event or "").strip()
    if not name:
        return
    actor = actor or {}
    details = {
        "who": {
            "id": str(actor.get("id") or "").strip() or None,
            "name": str(actor.get("name") or "").strip() or None,
            "email": str(actor.get("email") or "").strip() or None,
            "role": str(actor.get("role") or "").strip() or None,
        },
        "when": datetime.now(timezone.utc).isoformat(),
        **(metadata or {}),
    }
    usage_tracking_repository.insert_event(name, details)
