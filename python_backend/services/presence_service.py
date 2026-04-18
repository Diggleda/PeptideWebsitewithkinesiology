from __future__ import annotations

import os
import threading
import time
from datetime import datetime, timezone
from typing import Dict, Optional

_LOCK = threading.Lock()
_CONDITION = threading.Condition(_LOCK)
_PRESENCE: Dict[str, Dict[str, object]] = {}
_REVISION = 0


def _bump_revision_locked() -> None:
    global _REVISION
    _REVISION += 1
    _CONDITION.notify_all()


def current_revision() -> int:
    with _LOCK:
        return int(_REVISION)


def wait_for_change(since_revision: int, *, timeout_s: float) -> int:
    timeout = max(0.0, float(timeout_s or 0.0))
    with _CONDITION:
        if _REVISION != int(since_revision):
            return int(_REVISION)
        if timeout > 0:
            _CONDITION.wait(timeout=timeout)
        return int(_REVISION)

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


def _coerce_epoch(value: object) -> float | None:
    try:
        stamp = float(value) if value is not None else None
    except Exception:
        return None
    if stamp is None or stamp <= 0:
        return None
    return stamp


def _online_threshold_seconds() -> float:
    raw = os.environ.get("USER_PRESENCE_ONLINE_SECONDS")
    try:
        threshold = float(raw) if raw is not None else 300.0
    except Exception:
        threshold = 300.0
    return max(15.0, min(threshold, 60 * 60))


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
    with _CONDITION:
        entry = dict(_PRESENCE.get(uid) or {})
        previous_heartbeat = _coerce_epoch(entry.get("lastHeartbeatAt"))
        online_since = _coerce_epoch(entry.get("onlineSinceAt"))
        if not is_recent_epoch(
            previous_heartbeat,
            threshold_s=_online_threshold_seconds(),
            now_epoch=now,
        ):
            online_since = now
        elif online_since is None:
            online_since = previous_heartbeat or now
        entry["onlineSinceAt"] = online_since
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
        _bump_revision_locked()
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
    with _CONDITION:
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
        if removed > 0:
            _bump_revision_locked()
    return removed

def clear_user(user_id: str) -> bool:
    uid = str(user_id or "").strip()
    if not uid:
        return False
    with _CONDITION:
        existed = uid in _PRESENCE
        _PRESENCE.pop(uid, None)
        if existed:
            _bump_revision_locked()
        return existed


def to_public_fields(entry: Optional[Dict[str, object]]) -> Dict[str, Optional[object]]:
    if not entry:
        return {
            "onlineSinceAt": None,
            "lastSeenAt": None,
            "lastInteractionAt": None,
            "isIdle": None,
        }
    last_hb = entry.get("lastHeartbeatAt")
    last_interaction = entry.get("lastInteractionAt")
    online_since = entry.get("onlineSinceAt")
    return {
        "onlineSinceAt": _epoch_to_iso(float(online_since)) if online_since else None,
        "lastSeenAt": _epoch_to_iso(float(last_hb)) if last_hb else None,
        "lastInteractionAt": _epoch_to_iso(float(last_interaction)) if last_interaction else None,
        "isIdle": bool(entry.get("isIdle")) if isinstance(entry.get("isIdle"), bool) else None,
    }
