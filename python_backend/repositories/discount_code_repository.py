from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..database import mysql_client
from ..services import get_config


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def _now_sql() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def find_by_code(code: str) -> Optional[Dict[str, Any]]:
    candidate = _normalize_code(code)
    if not candidate or not _using_mysql():
        return None
    row = mysql_client.fetch_one(
        "SELECT code, discount_value, used_by_json, `condition`, created_at, updated_at FROM discount_codes WHERE code = %(code)s",
        {"code": candidate},
    )
    if not row:
        return None

    def parse_used_by(value: Any) -> Dict[str, Dict[str, Any]]:
        if not value:
            return {}
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        if not isinstance(parsed, dict):
            return {}
        out: Dict[str, Dict[str, Any]] = {}
        for key, val in parsed.items():
            user_key = str(key)
            # Backward-compatibility: older format stored just a number.
            if isinstance(val, (int, float)) and user_key:
                out[user_key] = {"subtotal": float(val), "quantity": None}
                continue
            if isinstance(val, dict) and user_key:
                subtotal = val.get("subtotal")
                quantity = val.get("quantity")
                try:
                    subtotal_value = float(subtotal) if subtotal is not None else None
                except Exception:
                    subtotal_value = None
                try:
                    quantity_value = int(float(quantity)) if quantity is not None else None
                except Exception:
                    quantity_value = None
                out[user_key] = {"subtotal": subtotal_value, "quantity": quantity_value}
        return out

    used_by = parse_used_by(row.get("used_by_json"))
    raw_condition = row.get("condition")
    condition: Dict[str, Any] = {}
    if raw_condition:
        try:
            if isinstance(raw_condition, (dict, list)):
                parsed = raw_condition
            else:
                parsed = json.loads(raw_condition)
            if isinstance(parsed, dict):
                condition = parsed
        except Exception:
            condition = {}
    try:
        discount_value = float(row.get("discount_value") or 0)
    except Exception:
        discount_value = 0.0
    return {
        "code": row.get("code") or candidate,
        "discountValue": float(discount_value),
        "usedBy": used_by,
        "condition": condition,
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
    }


def ensure_code_exists(
    *,
    code: str,
    discount_value: float,
    overwrite_value: bool = False,
    condition: Optional[Dict[str, Any]] = None,
    overwrite_condition: bool = False,
) -> None:
    """
    Best-effort seed so we can ship a hard-coded code without manual SQL.
    Safe to call repeatedly.
    """
    if not _using_mysql():
        return
    normalized = _normalize_code(code)
    now = _now_sql()
    on_duplicate = "updated_at = VALUES(updated_at)"
    if overwrite_value:
        on_duplicate = "discount_value = VALUES(discount_value), updated_at = VALUES(updated_at)"
    if overwrite_condition:
        on_duplicate = f"{on_duplicate}, `condition` = VALUES(`condition`)"
    mysql_client.execute(
        f"""
        INSERT INTO discount_codes (code, discount_value, used_by_json, `condition`, created_at, updated_at)
        VALUES (%(code)s, %(discount_value)s, %(used_by_json)s, %(condition)s, %(created_at)s, %(updated_at)s)
        ON DUPLICATE KEY UPDATE
          {on_duplicate}
        """,
        {
            "code": normalized,
            "discount_value": float(discount_value),
            "used_by_json": json.dumps({}),
            "condition": json.dumps(condition) if isinstance(condition, dict) else None,
            "created_at": now,
            "updated_at": now,
        },
    )


def reserve_use_once(*, code: str, user_id: str, items_subtotal: float, quantity: int) -> Dict[str, Any]:
    """
    Atomically mark this code as used by `user_id` (once per user).
    Stores a { userId: { subtotal, quantity } } mapping in `used_by_json`.
    """
    if not _using_mysql():
        err = RuntimeError("Discount codes are unavailable (MySQL disabled).")
        setattr(err, "status", 503)
        raise err
    normalized = _normalize_code(code)
    if not normalized:
        err = ValueError("Discount code is required")
        setattr(err, "status", 400)
        raise err
    if not user_id:
        err = ValueError("User ID is required")
        setattr(err, "status", 400)
        raise err

    safe_subtotal = float(items_subtotal or 0.0)
    if safe_subtotal < 0:
        safe_subtotal = 0.0
    safe_subtotal = round(safe_subtotal, 2)
    try:
        safe_qty = int(quantity or 0)
    except Exception:
        safe_qty = 0
    safe_qty = max(0, safe_qty)
    now = _now_sql()

    with mysql_client.cursor() as cur:
        cur.execute(
            "SELECT code, discount_value, used_by_json FROM discount_codes WHERE code = %(code)s FOR UPDATE",
            {"code": normalized},
        )
        row = cur.fetchone()
        if not row:
            err = ValueError("Invalid discount code")
            setattr(err, "status", 400)
            raise err

        used_by_raw = row.get("used_by_json")
        try:
            used_by = json.loads(used_by_raw) if used_by_raw else {}
        except Exception:
            used_by = {}
        if not isinstance(used_by, dict):
            used_by = {}

        if str(user_id) in used_by:
            err = ValueError("Discount code already used")
            setattr(err, "status", 400)
            raise err

        used_by[str(user_id)] = {"subtotal": safe_subtotal, "quantity": safe_qty}
        cur.execute(
            """
            UPDATE discount_codes
            SET used_by_json = %(used_by_json)s, updated_at = %(updated_at)s
            WHERE code = %(code)s
            """,
            {"used_by_json": json.dumps(used_by), "updated_at": now, "code": normalized},
        )

        try:
            discount_value = float(row.get("discount_value") or 0)
        except Exception:
            discount_value = 0.0
        return {"code": normalized, "discountValue": float(discount_value), "usedBy": used_by}
