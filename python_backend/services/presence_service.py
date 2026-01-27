from __future__ import annotations

import threading
import time
from datetime import datetime, timezone
from typing import Dict, Optional

_LOCK = threading.Lock()
_PRESENCE: Dict[str, Dict[str, object]] = {}

def is_recent_epoch(
    ts_epoch: float | int | None,
    *,
    threshold_s: float,
    now_epoch: float | None = None,
    future_skew_s: float = 5.0,
) -> bool:
    """
    Returns True when `ts_epoch` is within `threshold_s` seconds of `now_epoch`.

    Guards against clock skew / bad timestamps by requiring:
    - ts_epoch is positive
    - delta <= threshold_s
    - ts_epoch is not too far in the future (<= future_skew_s)
    """
    if ts_epoch is None:
        return False
    try:
        stamp = float(ts_epoch)
    except Exception:
        return False
    if stamp <= 0:
        return False
    now = float(now_epoch) if now_epoch is not None else time.time()
    delta = now - stamp
    if delta < -float(future_skew_s):
        return False
    return delta <= float(threshold_s)


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

def prune_stale(*, max_age_s: float) -> int:
    """
    Drop in-memory presence entries that haven't heartbeated recently.

    This does not affect persisted presence in MySQL; it only prevents the in-memory
    map from growing unbounded when clients disconnect without a final logout call.
    """
    try:
        max_age = float(max_age_s)
    except Exception:
        return 0
    if max_age <= 0:
        return 0
    now = time.time()
    removed = 0
    with _LOCK:
        stale_ids = []
        for uid, entry in _PRESENCE.items():
            if not isinstance(entry, dict):
                stale_ids.append(uid)
                continue
            last_hb = entry.get("lastHeartbeatAt")
            try:
                last_hb = float(last_hb) if last_hb is not None else None
            except Exception:
                last_hb = None
            if not last_hb or last_hb <= 0 or (now - float(last_hb)) >= max_age:
                stale_ids.append(uid)
        for uid in stale_ids:
            if uid in _PRESENCE:
                _PRESENCE.pop(uid, None)
                removed += 1
    return removed

def clear_user(user_id: str) -> bool:
    uid = str(user_id or "").strip()
    if not uid:
        return False
    with _LOCK:
        existed = uid in _PRESENCE
        _PRESENCE.pop(uid, None)
        return existed


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
