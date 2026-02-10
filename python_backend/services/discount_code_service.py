from __future__ import annotations

from typing import Any, Dict, Optional

from ..repositories import discount_code_repository


def _round_money(value: float) -> float:
    try:
        return round(float(value or 0.0), 2)
    except Exception:
        return 0.0


def seed_defaults() -> None:
    """
    Ensure RESEARCH exists without manual SQL.

    NOTE: Adjust `discount_value` in MySQL `discount_codes` if you want a different value.
    """
    discount_code_repository.ensure_code_exists(code="RESEARCH", discount_value=50.0, overwrite_value=True)


def preview_discount_for_user(
    *,
    user_id: str,
    code: str,
    items_subtotal: float,
) -> Dict[str, Any]:
    seed_defaults()
    record = discount_code_repository.find_by_code(code)
    if not record:
        return {"valid": False, "message": "Invalid discount code"}

    used_by = record.get("usedBy") or {}
    if isinstance(used_by, dict) and str(user_id) in used_by:
        return {"valid": False, "message": "Discount code already used"}

    discount_value = float(record.get("discountValue") or 0.0)
    discount_value = max(0.0, discount_value)

    subtotal = max(0.0, float(items_subtotal or 0.0))
    discount_amount = min(_round_money(discount_value), _round_money(subtotal))
    if discount_amount <= 0:
        return {"valid": False, "message": "Discount code is not active"}

    return {
        "valid": True,
        "code": record.get("code"),
        "discountValue": discount_value,
        "discountAmount": discount_amount,
    }


def apply_discount_to_subtotal(
    *,
    user_id: str,
    code: Optional[str],
    items_subtotal: float,
) -> Dict[str, Any]:
    if not code:
        return {"code": None, "discountValue": 0.0, "discountAmount": 0.0}

    preview = preview_discount_for_user(
        user_id=user_id,
        code=code,
        items_subtotal=items_subtotal,
    )
    if not preview.get("valid"):
        err = ValueError(preview.get("message") or "Invalid discount code")
        setattr(err, "status", 400)
        raise err

    discount_amount = float(preview.get("discountAmount") or 0.0)
    discount_value = float(preview.get("discountValue") or 0.0)

    return {
        "code": str(preview.get("code") or code).strip().upper(),
        "discountValue": discount_value,
        "discountAmount": _round_money(discount_amount),
    }
