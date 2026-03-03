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

    NOTE: Adjust `discount_value` / `condition` in MySQL `discount_codes` if you want different behavior.
    """
    discount_code_repository.ensure_code_exists(
        code="RESEARCH",
        discount_value=50.0,
        overwrite_value=True,
        condition={"min_cart_quantity": 4},
        overwrite_condition=True,
    )
    discount_code_repository.ensure_code_exists(
        code="GLORIAINEXCELSISDEO",
        discount_value=0.0,
        overwrite_value=True,
        condition={
            "allowed_roles": [
                "admin",
                "sales_rep",
                "test_rep",
                "sales_lead",
                "saleslead",
                "sales-lead",
                "rep",
            ],
            "single_use_per_user": False,
            "pricing_override": {
                "mode": "force_tier_band",
                "min_quantity": 11,
                "max_quantity": 26,
            },
        },
        overwrite_condition=True,
    )


def _normalize_role(role: Optional[str]) -> str:
    return str(role or "").strip().lower()


def _is_role_allowed(user_role: str, allowed_roles: list[Any]) -> bool:
    normalized = _normalize_role(user_role)
    if not normalized:
        return False
    allowed = {str(item or "").strip().lower() for item in (allowed_roles or []) if str(item or "").strip()}
    if not allowed:
        return False
    if normalized in allowed:
        return True
    aliases = {
        "saleslead": {"sales_lead", "sales-lead"},
        "sales_lead": {"saleslead", "sales-lead"},
        "sales-lead": {"sales_lead", "saleslead"},
        "sales_rep": {"rep"},
        "rep": {"sales_rep"},
    }
    for alias in aliases.get(normalized, set()):
        if alias in allowed:
            return True
    return False


def _parse_pricing_override(condition: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not isinstance(condition, dict):
        return None
    raw = condition.get("pricing_override")
    if not isinstance(raw, dict):
        return None
    mode = str(raw.get("mode") or "").strip().lower()
    if mode != "force_tier_band":
        return None
    try:
        min_qty = int(float(raw.get("min_quantity")))
    except Exception:
        min_qty = 0
    try:
        max_qty = int(float(raw.get("max_quantity")))
    except Exception:
        max_qty = 0
    if min_qty <= 0 or max_qty < min_qty:
        return None
    return {
        "mode": "force_tier_band",
        "minQuantity": min_qty,
        "maxQuantity": max_qty,
    }


def preview_discount_for_user(
    *,
    user_id: str,
    user_role: Optional[str],
    code: str,
    items_subtotal: float,
    cart_quantity: float | int = 0,
) -> Dict[str, Any]:
    seed_defaults()
    record = discount_code_repository.find_by_code(code)
    if not record:
        return {"valid": False, "message": "Invalid discount code"}

    condition = record.get("condition") or {}
    if not isinstance(condition, dict):
        condition = {}
    allowed_roles = condition.get("allowed_roles")
    if isinstance(allowed_roles, list) and allowed_roles:
        if not _is_role_allowed(user_role or "", allowed_roles):
            return {"valid": False, "message": "Discount code is not available for your role"}

    single_use_per_user = bool(condition.get("single_use_per_user", True))
    used_by = record.get("usedBy") or {}
    if single_use_per_user and isinstance(used_by, dict) and str(user_id) in used_by:
        return {"valid": False, "message": "Discount code already used"}

    min_qty_raw = condition.get("min_cart_quantity")
    if min_qty_raw is None:
        min_qty_raw = condition.get("min_cart_ quantity")
    try:
        min_qty = int(min_qty_raw) if min_qty_raw is not None else 0
    except Exception:
        min_qty = 0
    try:
        qty = int(float(cart_quantity or 0))
    except Exception:
        qty = 0
    if min_qty > 0 and qty < min_qty:
        return {
            "valid": False,
            "message": f"Discount code requires at least {min_qty} total items (quantity) in your cart (you have {qty})",
        }

    discount_value = float(record.get("discountValue") or 0.0)
    discount_value = max(0.0, discount_value)

    subtotal = max(0.0, float(items_subtotal or 0.0))
    discount_amount = min(_round_money(discount_value), _round_money(subtotal))
    pricing_override = _parse_pricing_override(condition)
    if discount_amount <= 0 and not pricing_override:
        return {"valid": False, "message": "Discount code is not active"}

    response = {
        "valid": True,
        "code": record.get("code"),
        "discountValue": discount_value,
        "discountAmount": discount_amount,
        "singleUsePerUser": single_use_per_user,
    }
    if pricing_override:
        response["pricingOverride"] = pricing_override
    return response


def apply_discount_to_subtotal(
    *,
    user_id: str,
    user_role: Optional[str],
    code: Optional[str],
    items_subtotal: float,
    cart_quantity: float | int = 0,
) -> Dict[str, Any]:
    if not code:
        return {"code": None, "discountValue": 0.0, "discountAmount": 0.0}

    preview = preview_discount_for_user(
        user_id=user_id,
        user_role=user_role,
        code=code,
        items_subtotal=items_subtotal,
        cart_quantity=cart_quantity,
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
        "pricingOverride": preview.get("pricingOverride")
        if isinstance(preview.get("pricingOverride"), dict)
        else None,
        "singleUsePerUser": bool(preview.get("singleUsePerUser", True)),
    }
