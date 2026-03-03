from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from ..database import mysql_client
from ..services import get_config

_DISCOUNT_CODE_COLUMNS_CACHE: Optional[set[str]] = None


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _normalize_code(code: str) -> str:
    return (code or "").strip().upper()


def _now_sql() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def _discount_code_columns() -> set[str]:
    global _DISCOUNT_CODE_COLUMNS_CACHE
    if _DISCOUNT_CODE_COLUMNS_CACHE is not None:
        return _DISCOUNT_CODE_COLUMNS_CACHE
    if not _using_mysql():
        _DISCOUNT_CODE_COLUMNS_CACHE = set()
        return _DISCOUNT_CODE_COLUMNS_CACHE
    try:
        rows = mysql_client.fetch_all(
            """
            SELECT COLUMN_NAME
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'discount_codes'
              AND COLUMN_NAME IN ('used_by_json', 'used_by')
            """,
        )
        cols = {str((row or {}).get("COLUMN_NAME") or "").strip() for row in (rows or [])}
        _DISCOUNT_CODE_COLUMNS_CACHE = {c for c in cols if c}
    except Exception:
        # Fall back to legacy expectation.
        _DISCOUNT_CODE_COLUMNS_CACHE = {"used_by_json"}
    return _DISCOUNT_CODE_COLUMNS_CACHE


def _used_by_read_column(columns: set[str]) -> Optional[str]:
    if "used_by_json" in columns:
        return "used_by_json"
    if "used_by" in columns:
        return "used_by"
    return None


def _used_by_write_columns(columns: set[str]) -> list[str]:
    out: list[str] = []
    if "used_by_json" in columns:
        out.append("used_by_json")
    if "used_by" in columns:
        out.append("used_by")
    return out


def find_by_code(code: str) -> Optional[Dict[str, Any]]:
    candidate = _normalize_code(code)
    if not candidate or not _using_mysql():
        return None
    columns = _discount_code_columns()
    read_col = _used_by_read_column(columns)
    used_by_select = f"`{read_col}` AS used_by_payload" if read_col else "NULL AS used_by_payload"
    row = mysql_client.fetch_one(
        f"SELECT code, discount_value, {used_by_select}, `condition`, created_at, updated_at FROM discount_codes WHERE code = %(code)s",
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
            if isinstance(val, str) and user_key:
                out[user_key] = {"label": val, "subtotal": None, "quantity": None}
                continue
            if isinstance(val, dict) and user_key:
                subtotal = val.get("subtotal")
                quantity = val.get("quantity")
                label = val.get("label")
                try:
                    subtotal_value = float(subtotal) if subtotal is not None else None
                except Exception:
                    subtotal_value = None
                try:
                    quantity_value = int(float(quantity)) if quantity is not None else None
                except Exception:
                    quantity_value = None
                out[user_key] = {
                    "label": str(label) if isinstance(label, str) else None,
                    "subtotal": subtotal_value,
                    "quantity": quantity_value,
                }
        return out

    used_by = parse_used_by(row.get("used_by_payload"))
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
    columns = _discount_code_columns()
    used_by_columns = _used_by_write_columns(columns)
    insert_columns = ["code", "discount_value", "`condition`", "created_at", "updated_at"]
    value_tokens = ["%(code)s", "%(discount_value)s", "%(condition)s", "%(created_at)s", "%(updated_at)s"]
    payload: Dict[str, Any] = {
        "code": normalized,
        "discount_value": float(discount_value),
        "condition": json.dumps(condition) if isinstance(condition, dict) else None,
        "created_at": now,
        "updated_at": now,
    }
    for col in used_by_columns:
        insert_columns.insert(2, col)
        value_tokens.insert(2, f"%({col})s")
        payload[col] = json.dumps({})

    on_duplicate = "updated_at = VALUES(updated_at)"
    if overwrite_value:
        on_duplicate = "discount_value = VALUES(discount_value), updated_at = VALUES(updated_at)"
    if overwrite_condition:
        on_duplicate = f"{on_duplicate}, `condition` = VALUES(`condition`)"
    mysql_client.execute(
        f"""
        INSERT INTO discount_codes ({", ".join(insert_columns)})
        VALUES ({", ".join(value_tokens)})
        ON DUPLICATE KEY UPDATE
          {on_duplicate}
        """,
        payload,
    )


def reserve_use_once(
    *,
    code: str,
    user_id: str,
    user_name: Optional[str] = None,
    order_id: Optional[str] = None,
    enforce_single_use: bool = True,
    items_subtotal: float,
    quantity: int,
) -> Dict[str, Any]:
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
    columns = _discount_code_columns()
    read_col = _used_by_read_column(columns)
    write_cols = _used_by_write_columns(columns)
    used_by_select = read_col if read_col else "NULL"

    with mysql_client.cursor() as cur:
        cur.execute(
            f"SELECT code, discount_value, {used_by_select} AS used_by_payload FROM discount_codes WHERE code = %(code)s FOR UPDATE",
            {"code": normalized},
        )
        row = cur.fetchone()
        if not row:
            err = ValueError("Invalid discount code")
            setattr(err, "status", 400)
            raise err

        used_by_raw = row.get("used_by_payload")
        try:
            used_by = json.loads(used_by_raw) if used_by_raw else {}
        except Exception:
            used_by = {}
        if not isinstance(used_by, dict):
            used_by = {}

        if enforce_single_use and str(user_id) in used_by:
            err = ValueError("Discount code already used")
            setattr(err, "status", 400)
            raise err

        display_name = str(user_name or "").strip() or str(user_id)
        display_order_id = str(order_id or "").strip() or "unknown"
        entry_value = f"({display_name}):({display_order_id})"
        entry_key = str(user_id)
        if not enforce_single_use:
            # For reusable codes, keep a per-order history instead of overwriting one user key.
            entry_key = f"{str(user_id)}:{display_order_id}:{int(datetime.now(timezone.utc).timestamp())}"
        used_by[entry_key] = entry_value
        if write_cols:
            set_parts = [f"{col} = %({col})s" for col in write_cols]
            set_parts.append("updated_at = %(updated_at)s")
            params: Dict[str, Any] = {"updated_at": now, "code": normalized}
            serialized = json.dumps(used_by)
            for col in write_cols:
                params[col] = serialized
            cur.execute(
                f"""
                UPDATE discount_codes
                SET {", ".join(set_parts)}
                WHERE code = %(code)s
                """,
                params,
            )

        try:
            discount_value = float(row.get("discount_value") or 0)
        except Exception:
            discount_value = 0.0
        return {"code": normalized, "discountValue": float(discount_value), "usedBy": used_by}
