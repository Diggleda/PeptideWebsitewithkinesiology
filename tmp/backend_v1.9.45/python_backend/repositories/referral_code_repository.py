from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Dict, List, Optional

from . import sales_rep_repository


def _normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def _ensure_defaults(record: Dict) -> Dict:
    normalized = dict(record)
    normalized.setdefault("id", record.get("id") or _generate_id())
    normalized["code"] = _normalize_code(record.get("code"))
    normalized.setdefault("status", record.get("status") or "available")
    normalized.setdefault("createdAt", record.get("createdAt") or _now())
    normalized["updatedAt"] = record.get("updatedAt") or normalized["createdAt"]
    history = record.get("history")
    normalized["history"] = history if isinstance(history, list) else []
    return normalized


_REP_CODE_PREFIX = "rep-code-"


def _rep_code_id(rep_id: str) -> str:
    return f"{_REP_CODE_PREFIX}{rep_id}"


def _rep_id_from_code_id(code_id: str) -> Optional[str]:
    if not code_id:
        return None
    raw = str(code_id).strip()
    if raw.startswith(_REP_CODE_PREFIX):
        return raw[len(_REP_CODE_PREFIX) :] or None
    return raw or None


def _rep_to_code_record(rep: Optional[Dict]) -> Optional[Dict]:
    if not rep:
        return None
    rep_id = rep.get("id")
    if not rep_id:
        return None
    code = _normalize_code(rep.get("salesCode") or rep.get("sales_code") or "")
    if not code:
        return None

    created_at = rep.get("createdAt") or rep.get("created_at") or _now()
    updated_at = rep.get("updatedAt") or rep.get("updated_at") or created_at
    issued_at = rep.get("updatedAt") or rep.get("updated_at") or created_at
    return _ensure_defaults(
        {
            "id": _rep_code_id(str(rep_id)),
            "salesRepId": str(rep_id),
            "code": code,
            "status": "assigned",
            "issuedAt": issued_at,
            "updatedAt": updated_at,
            "createdAt": created_at,
            "referrerDoctorId": None,
            "referralId": None,
            "doctorId": None,
            "redeemedAt": None,
            "history": [
                {
                    "action": "assigned",
                    "at": issued_at or created_at,
                    "by": str(rep_id),
                    "status": "assigned",
                    "source": "sales_rep",
                }
            ],
        }
    )


def get_all() -> List[Dict]:
    records: List[Dict] = []
    for rep in sales_rep_repository.get_all():
        record = _rep_to_code_record(rep)
        if record:
            records.append(record)
    return records


def find_by_id(record_id: str) -> Optional[Dict]:
    rep_id = _rep_id_from_code_id(record_id)
    if not rep_id:
        return None
    rep = sales_rep_repository.find_by_id(rep_id)
    return _rep_to_code_record(rep)


def find_by_code(code: str) -> Optional[Dict]:
    candidate = _normalize_code(code)
    if not candidate:
        return None
    rep = sales_rep_repository.find_by_sales_code(candidate)
    return _rep_to_code_record(rep)


def find_available_by_rep(sales_rep_id: str) -> List[Dict]:
    rep = sales_rep_repository.find_by_id(sales_rep_id)
    record = _rep_to_code_record(rep)
    return [record] if record else []


def insert(record: Dict) -> Dict:
    raise RuntimeError("Referral codes are stored on sales reps (sales_reps.sales_code); update the sales rep instead.")


def update(record: Dict) -> Optional[Dict]:
    raise RuntimeError("Referral codes are stored on sales reps (sales_reps.sales_code); update the sales rep instead.")


def _row_to_record(row: Optional[Dict]) -> Optional[Dict]:
    if not row:
        return None

    def fmt_datetime(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=timezone.utc).isoformat()
        return str(value)

    def parse_json(value):
        if not value:
            return []
        try:
            return json.loads(value)
        except Exception:
            return []

    return _ensure_defaults(
        {
            "id": row.get("id"),
            "salesRepId": row.get("sales_rep_id"),
            "referrerDoctorId": row.get("referrer_doctor_id"),
            "referralId": row.get("referral_id"),
            "doctorId": row.get("doctor_id"),
            "code": row.get("code"),
            "status": row.get("status"),
            "issuedAt": fmt_datetime(row.get("issued_at")),
            "redeemedAt": fmt_datetime(row.get("redeemed_at")),
            "history": parse_json(row.get("history")),
            "createdAt": fmt_datetime(row.get("created_at")),
            "updatedAt": fmt_datetime(row.get("updated_at")),
        }
    )


def _to_db_params(record: Dict) -> Dict:
    def serialize_json(value):
        if not value:
            return None
        return json.dumps(value)

    def parse_dt(value):
        if not value:
            return None
        if isinstance(value, datetime):
            return value.replace(tzinfo=None)
        value = str(value)
        if value.endswith("Z"):
            value = value[:-1]
        value = value.replace("T", " ")
        return value[:26]

    return {
        "id": record.get("id"),
        "sales_rep_id": record.get("salesRepId"),
        "referrer_doctor_id": record.get("referrerDoctorId"),
        "referral_id": record.get("referralId"),
        "doctor_id": record.get("doctorId"),
        "code": record.get("code"),
        "status": record.get("status"),
        "issued_at": parse_dt(record.get("issuedAt")),
        "redeemed_at": parse_dt(record.get("redeemedAt")),
        "history": serialize_json(record.get("history")),
        "created_at": parse_dt(record.get("createdAt")),
        "updated_at": parse_dt(record.get("updatedAt")),
    }


def _generate_id() -> str:
    from time import time

    return str(int(time() * 1000))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
