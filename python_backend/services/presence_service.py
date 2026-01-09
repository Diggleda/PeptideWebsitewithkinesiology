from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Dict, Optional

_LOCK = threading.Lock()
_PRESENCE: Dict[str, Dict[str, object]] = {}


def _epoch_to_iso(ts: float) -> str:
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def record_ping(
    user_id: str,
    *,
    kind: str = "heartbeat",
    is_idle: Optional[bool] = None,
) -> Dict[str, object]:
    uid = str(user_id or "").strip()
    if not uid:
        return {}
    normalized_kind = str(kind or "heartbeat").strip().lower()
    now = time.time()
    with _LOCK:
        entry = dict(_PRESENCE.get(uid) or {})
        entry["lastHeartbeatAt"] = now
        if normalized_kind == "interaction":
            entry["lastInteractionAt"] = now
            entry["isIdle"] = False
        if isinstance(is_idle, bool):
            entry["isIdle"] = is_idle
            if is_idle is False:
                entry["lastInteractionAt"] = now
        entry["updatedAt"] = now
        _PRESENCE[uid] = entry
        return dict(entry)


def snapshot() -> Dict[str, Dict[str, object]]:
    with _LOCK:
        return {k: dict(v) for k, v in _PRESENCE.items()}


def to_public_fields(entry: Optional[Dict[str, object]]) -> Dict[str, Optional[object]]:
    if not entry:
        return {
            "lastSeenAt": None,
            "lastInteractionAt": None,
            "isIdle": None,
        }
    last_hb = entry.get("lastHeartbeatAt")
    last_interaction = entry.get("lastInteractionAt")
    return {
        "lastSeenAt": _epoch_to_iso(float(last_hb)) if last_hb else None,
        "lastInteractionAt": _epoch_to_iso(float(last_interaction)) if last_interaction else None,
        "isIdle": bool(entry.get("isIdle")) if isinstance(entry.get("isIdle"), bool) else None,
    }

