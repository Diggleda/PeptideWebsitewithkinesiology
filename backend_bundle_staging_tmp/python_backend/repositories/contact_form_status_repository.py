from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, Optional

from .. import storage


def _get_store():
    store = storage.contact_form_status_store
    if store is None:
        raise RuntimeError("contact_form_status_store is not initialised")
    return store


def _load() -> Dict[str, Dict]:
    return _get_store().read()


def _save(records: Dict[str, Dict]) -> None:
    _get_store().write(records)


def get_entry(form_id: str) -> Optional[Dict]:
    data = _load()
    return data.get(str(form_id))


def get_status(form_id: str) -> Optional[str]:
    entry = get_entry(form_id)
    if isinstance(entry, dict):
        return entry.get("status")
    if isinstance(entry, str):
        return entry
    return None


def upsert(form_id: str, status: str) -> Dict:
    data = _load()
    payload = {
        "id": str(form_id),
        "status": status,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    data[str(form_id)] = payload
    _save(data)
    return payload
