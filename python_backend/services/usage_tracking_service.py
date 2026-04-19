from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..repositories import sales_rep_repository, user_repository
from ..repositories import usage_tracking_repository

logger = logging.getLogger(__name__)


def _resolved_actor(actor: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    current = dict(actor or {})
    actor_id = str(current.get("id") or "").strip()
    actor_email = str(current.get("email") or "").strip()
    actor_name = str(current.get("name") or "").strip()

    if actor_name:
        return current

    resolved = None
    if actor_id:
        resolved = user_repository.find_by_id(actor_id)
        if not resolved:
            resolved = sales_rep_repository.find_by_id(actor_id)
    if not resolved and actor_email:
        resolved = user_repository.find_by_email(actor_email)
        if not resolved:
            resolved = sales_rep_repository.find_by_email(actor_email)

    if isinstance(resolved, dict):
        current["id"] = str(resolved.get("id") or current.get("id") or "").strip() or None
        current["name"] = str(resolved.get("name") or current.get("name") or "").strip() or None
        current["email"] = str(resolved.get("email") or current.get("email") or "").strip() or None
        current["role"] = str(resolved.get("role") or current.get("role") or "").strip() or None
    return current

def track_event(
    event: str,
    *,
    actor: Optional[Dict[str, Any]] = None,
    metadata: Optional[Dict[str, Any]] = None,
    strict: bool = False,
) -> bool:
    name = str(event or "").strip()
    if not name:
        return False
    actor = _resolved_actor(actor)
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
    try:
        return bool(usage_tracking_repository.insert_event(name, details, strict=strict))
    except Exception:
        if strict:
            raise
        logger.exception("Usage tracking write failed", extra={"event": name})
        return False


def get_event_counts(events: list[str] | tuple[str, ...] | None) -> Dict[str, int]:
    try:
        return usage_tracking_repository.get_event_counts(events)
    except Exception:
        logger.exception("Usage tracking read failed", extra={"events": list(events or [])})
        return {str(event or "").strip(): 0 for event in (events or []) if str(event or "").strip()}


def get_event_funnel(
    events: list[str] | tuple[str, ...] | None,
    *,
    actor_key: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        return usage_tracking_repository.get_event_funnel(events, actor_key=actor_key)
    except Exception:
        logger.exception(
            "Usage tracking funnel read failed",
            extra={"events": list(events or []), "actorKey": actor_key},
        )
        normalized_events = [str(event or "").strip() for event in (events or []) if str(event or "").strip()]
        return {
            "counts": {event: 0 for event in normalized_events},
            "actors": [],
        }
