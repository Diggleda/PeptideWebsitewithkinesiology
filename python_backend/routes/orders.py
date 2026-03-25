from __future__ import annotations

import os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from urllib.parse import quote

import requests
from flask import Blueprint, Response, g, make_response, request

from ..middleware.auth import require_auth
from ..integrations import ship_station
from ..integrations import woo_commerce
from ..repositories import order_repository, patient_links_repository, user_repository
from ..services import order_service, delegation_service, usage_tracking_service, tax_tracking_service
from ..services.invoice_service import build_invoice_pdf
from ..utils.http import handle_action, require_admin as _require_admin_user

blueprint = Blueprint("orders", __name__, url_prefix="/api/orders")

def _round_money(value) -> float:
    try:
        return round(float(value or 0) + 1e-9, 2)
    except Exception:
        return 0.0


def _find_local_order_for_user_invoice(order_id: str, *, user_id: str | None) -> dict | None:
    """
    Best-effort local lookup for invoice fallback when Woo is down.
    Only searches within the authenticated user's local orders (safe for permissions).
    """
    if not user_id:
        return None
    target = str(order_id or "").strip()
    if not target:
        return None
    try:
        candidates = order_repository.find_by_user_id(str(user_id))
    except Exception:
        return None
    for order in candidates or []:
        if not isinstance(order, dict):
            continue
        if str(order.get("wooOrderId") or "") == target:
            return order
        if str(order.get("wooOrderNumber") or "") == target:
            return order
        if str(order.get("id") or "") == target:
            return order
    return None


def _build_invoice_from_local_order(local_order: dict, *, customer_email: str | None) -> tuple[bytes, str]:
    items = local_order.get("items") or []
    if not isinstance(items, list):
        items = []
    line_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        qty = int(float(item.get("quantity") or 0) or 0)
        unit = _round_money(item.get("price") or 0)
        total = _round_money(unit * qty)
        line_items.append(
            {
                "name": item.get("name") or "Item",
                "sku": item.get("sku") or item.get("variantSku") or item.get("productId") or None,
                "quantity": qty,
                "total": total,
            }
        )

    currency = str(local_order.get("currency") or "USD").strip() or "USD"
    items_subtotal = _round_money(local_order.get("itemsSubtotal") or local_order.get("total") or 0)
    shipping_total = _round_money(local_order.get("shippingTotal") or 0)
    tax_total = _round_money(local_order.get("taxTotal") or 0)
    discount = _round_money(local_order.get("discountTotal") or local_order.get("appliedReferralCredit") or 0)
    grand_total = _round_money(local_order.get("grandTotal") or (items_subtotal - discount + shipping_total + tax_total))

    order_number = str(local_order.get("wooOrderNumber") or local_order.get("id") or "Order").strip()
    woo_order = {
        "id": local_order.get("wooOrderId") or local_order.get("id") or order_number,
        "number": order_number,
        "currency": currency,
        "date_created": local_order.get("createdAt") or None,
        "billing": {"email": (customer_email or "").strip()},
        "shipping_total": shipping_total,
        "total_tax": tax_total,
        "total": grand_total,
        "line_items": line_items,
        "shipping": local_order.get("shippingAddress") or {},
    }

    mapped = {
        "currency": currency,
        "wooOrderNumber": order_number,
        "number": order_number,
        "createdAt": local_order.get("createdAt") or None,
        "shippingTotal": shipping_total,
        "taxTotal": tax_total,
        "grandTotal": grand_total,
        "shippingAddress": local_order.get("shippingAddress") or {},
        "billingAddress": local_order.get("billingAddress") or {},
        "paymentMethod": local_order.get("paymentMethod") or None,
        "paymentDetails": local_order.get("paymentDetails") or None,
    }

    pdf_bytes, filename = build_invoice_pdf(
        woo_order=woo_order,
        mapped_summary=mapped,
        customer_email=(customer_email or ""),
    )
    return pdf_bytes, filename


@blueprint.post("/")
@require_auth
def create_order():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    total = payload.get("total")
    referral_code = payload.get("referralCode")
    discount_code = payload.get("discountCode") or payload.get("discount_code") or None
    payment_method = payload.get("paymentMethod") or payload.get("payment_method") or None
    pricing_mode = payload.get("pricingMode") or payload.get("pricing_mode") or None
    tax_total = payload.get("taxTotal")
    shipping_total = payload.get("shippingTotal")
    shipping_address = payload.get("shippingAddress")
    facility_pickup = bool(payload.get("handDelivery") is True or payload.get("facility_pickup") is True)
    # Support both keys from frontend/backends
    shipping_rate = payload.get("shippingRate") or payload.get("shippingEstimate")
    delegate_proposal_token = (
        payload.get("delegateProposalToken")
        or payload.get("delegate_proposal_token")
        or payload.get("delegationToken")
        or payload.get("delegation_token")
        or payload.get("proposalToken")
        or payload.get("proposal_token")
        or None
    )
    as_delegate_label = payload.get("asDelegate") or payload.get("as_delegate") or None
    normalized_delegate_token = str(delegate_proposal_token or "").strip()
    if normalized_delegate_token:
        as_delegate_label = "Delegate Order"
        try:
            link = patient_links_repository.find_by_token(normalized_delegate_token) or {}
            reference_label = (
                str(link.get("referenceLabel") or "").strip()
                or str(link.get("reference_label") or "").strip()
                or str(link.get("label") or "").strip()
            )
            if reference_label:
                as_delegate_label = reference_label
        except Exception:
            as_delegate_label = "Delegate Order"
    if isinstance(as_delegate_label, str):
        as_delegate_label = as_delegate_label.strip()[:190] or None
    expected_shipment_window = payload.get("expectedShipmentWindow") or None
    physician_certified = bool(
        payload.get("physicianCertificationAccepted")
        or payload.get("physicianCertification")
    )
    user_id = g.current_user.get("id")
    def action():
        result = order_service.create_order(
            user_id=user_id,
            items=items,
            total=total,
            referral_code=referral_code,
            discount_code=discount_code,
            payment_method=payment_method,
            pricing_mode=pricing_mode,
            tax_total=tax_total,
            shipping_total=shipping_total,
            shipping_address=shipping_address,
            facility_pickup=facility_pickup,
            shipping_rate=shipping_rate,
            expected_shipment_window=expected_shipment_window,
            physician_certified=physician_certified,
            as_delegate_label=as_delegate_label,
        )
        if normalized_delegate_token:
            usage_tracking_service.track_event(
                "delegate_order_placed",
                actor=getattr(g, "current_user", None) or {},
                metadata={"delegateProposalToken": normalized_delegate_token, "orderId": result.get("id")},
            )
        return result

    return handle_action(action)


@blueprint.get("/")
@require_auth
def list_orders():
    user_id = g.current_user.get("id")
    force = (request.args.get("force") or "").strip().lower() in ("1", "true", "yes")
    return handle_action(lambda: order_service.get_orders_for_user(user_id, force=force))


@blueprint.get("/sales-rep")
@require_auth
def list_orders_for_sales_rep():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "sales_partner", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        scope = (request.args.get("scope") or "").strip().lower()
        can_view_all_doctors = role in ("admin", "sales_lead", "saleslead", "sales-lead")
        scope_all = can_view_all_doctors and scope == "all"

        # Optional override: allow explicit salesRepId query param for admins and sales leads.
        override = (request.args.get("salesRepId") or "").strip() or None
        if override and can_view_all_doctors:
            sales_rep_id = override
        else:
            # When admin or sales lead is requesting "all", omit the sales rep filter entirely.
            sales_rep_id = None if scope_all else g.current_user.get("id")
        force = (request.args.get("force") or "").strip().lower() in ("1", "true", "yes")
        include_doctors = (request.args.get("includeDoctors") or "").strip().lower() not in ("0", "false", "no")
        local_only = (request.args.get("localOnly") or "").strip().lower() in ("1", "true", "yes")
        return order_service.get_orders_for_sales_rep(
            sales_rep_id,
            include_doctors=include_doctors,
            force=force,
            include_all_doctors=scope_all,
            include_house_contacts=(role == "admin"),
            local_only=local_only,
        )

    return handle_action(action)


@blueprint.get("/sales-rep/on-hold")
@require_auth
def list_on_hold_orders_for_sales_rep():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "sales_partner", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        raw_limit = request.args.get("limit")
        try:
            limit = int(raw_limit) if raw_limit is not None else 1200
        except Exception:
            limit = 1200
        limit = max(1, min(limit, 5000))
        scope = (request.args.get("scope") or "").strip().lower()
        can_view_all_doctors = role in ("admin", "sales_lead", "saleslead", "sales-lead")
        include_all_doctors = can_view_all_doctors and scope == "all"
        sales_rep_id = None if include_all_doctors else g.current_user.get("salesRepId") or g.current_user.get("id")
        return order_service.get_on_hold_orders_for_sales_rep(
            sales_rep_id,
            include_all_doctors=include_all_doctors,
            include_house_contacts=(role == "admin"),
            limit=limit,
        )

    return handle_action(action)


@blueprint.get("/sales-rep/<order_id>")
@require_auth
def get_sales_rep_order_detail(order_id: str):
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "sales_partner", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        sales_rep_id = g.current_user.get("id")
        return order_service.get_sales_rep_order_detail(
            order_id,
            sales_rep_id,
            token_role=role,
            doctor_id_hint=request.args.get("doctorId"),
            doctor_email_hint=request.args.get("doctorEmail"),
        )

    return handle_action(action)


@blueprint.get("/sales-rep/users/<user_id>/modal-detail")
@require_auth
def get_sales_modal_detail(user_id: str):
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "sales_partner", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        return order_service.get_sales_modal_detail(actor=g.current_user, target_user_id=user_id)

    return handle_action(action)


@blueprint.post("/<order_id>/cancel")
@require_auth
def cancel_order(order_id: str):
    payload = request.get_json(force=True, silent=True) or {}
    reason = (payload.get("reason") or "").strip()
    user_id = g.current_user.get("id")
    return handle_action(lambda: order_service.cancel_order(user_id=user_id, order_id=order_id, reason=reason))


@blueprint.get("/admin/sales-rep-summary")
@blueprint.get("/sales-rep-summary")
@require_auth
def sales_by_rep_summary():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("admin", "sales_lead", "saleslead", "sales-lead"):
            err = ValueError("Admin or Sales Lead access required")
            setattr(err, "status", 403)
            raise err
        exclude_id = g.current_user.get("id") if role == "admin" else None
        period_start = request.args.get("periodStart") or request.args.get("start") or None
        period_end = request.args.get("periodEnd") or request.args.get("end") or None
        force_raw = request.args.get("force") or ""
        force = str(force_raw).strip().lower() in ("1", "true", "yes", "y", "on")
        debug_raw = request.args.get("debug") or ""
        debug = str(debug_raw).strip().lower() in ("1", "true", "yes", "y", "on")
        return order_service.get_sales_by_rep(
            exclude_sales_rep_id=exclude_id if exclude_id else None,
            period_start=period_start,
            period_end=period_end,
            force=force,
            debug=debug,
        )

    return handle_action(action)


@blueprint.get("/admin/on-hold")
@blueprint.get("/on-hold")
@require_auth
def admin_on_hold_orders():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role != "admin":
            err = ValueError("Admin access required")
            setattr(err, "status", 403)
            raise err

        raw_limit = request.args.get("limit")
        try:
            limit = int(raw_limit) if raw_limit is not None else 1200
        except Exception:
            limit = 1200
        limit = max(1, min(limit, 5000))

        # Pull a wider recent window so filtering can still return up to `limit`.
        scan_limit = max(limit * 4, 1500)
        scan_limit = min(scan_limit, 10000)
        local_orders = order_repository.list_recent(scan_limit) or []

        users = user_repository.get_all() or []
        user_lookup = {
            str(user.get("id")): user
            for user in users
            if isinstance(user, dict) and user.get("id") is not None
        }

        def _normalized_status(value) -> str:
            return str(value or "").strip().lower().replace("_", "-")

        def _as_dict(value):
            return value if isinstance(value, dict) else {}

        def _first_text(*values) -> str | None:
            for value in values:
                text = str(value or "").strip()
                if text:
                    return text
            return None

        def _combined_name(first_name, last_name) -> str | None:
            first = str(first_name or "").strip()
            last = str(last_name or "").strip()
            full = f"{first} {last}".strip()
            return full or None

        summaries = []
        for local in local_orders:
            if not isinstance(local, dict):
                continue
            if _normalized_status(local.get("status")) not in ("on-hold", "onhold"):
                continue

            local_user_id = str(local.get("userId") or local.get("user_id") or "").strip()
            doctor = user_lookup.get(local_user_id) or {}
            shipping = _as_dict(local.get("shippingAddress") or local.get("shipping_address"))
            billing = _as_dict(local.get("billingAddress") or local.get("billing_address"))
            customer = _as_dict(local.get("customer"))
            shipping_name = _combined_name(
                shipping.get("firstName") or shipping.get("first_name"),
                shipping.get("lastName") or shipping.get("last_name"),
            ) or _first_text(shipping.get("name"), shipping.get("company"))
            billing_name = _combined_name(
                billing.get("firstName") or billing.get("first_name"),
                billing.get("lastName") or billing.get("last_name"),
            ) or _first_text(billing.get("name"), billing.get("company"))
            doctor_email = _first_text(
                doctor.get("email"),
                local.get("doctorEmail"),
                local.get("doctor_email"),
                local.get("email"),
                customer.get("email"),
                billing.get("email"),
                shipping.get("email"),
            )
            doctor_name = _first_text(
                doctor.get("name"),
                local.get("doctorName"),
                local.get("doctor_name"),
                customer.get("name"),
                shipping_name,
                billing_name,
                doctor_email,
            ) or "Unknown doctor"
            summary = {
                "id": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "wooOrderId": local.get("wooOrderId") or local.get("woo_order_id") or None,
                "wooOrderNumber": local.get("wooOrderNumber") or local.get("woo_order_number") or None,
                "number": local.get("wooOrderNumber") or local.get("wooOrderId") or local.get("id"),
                "status": local.get("status") or "on-hold",
                "total": float(local.get("grandTotal") or local.get("total") or 0),
                "grandTotal": float(local.get("grandTotal") or local.get("total") or 0),
                "taxTotal": float(local.get("taxTotal") or 0),
                "shippingTotal": float(local.get("shippingTotal") or 0),
                "currency": local.get("currency") or "USD",
                "createdAt": local.get("createdAt") or local.get("dateCreated") or local.get("date_created") or None,
                "updatedAt": local.get("updatedAt") or None,
                "doctorId": doctor.get("id") or local_user_id or None,
                "doctorName": doctor_name,
                "doctorEmail": doctor_email,
                "userId": doctor.get("id") or local_user_id or None,
                "lineItems": local.get("items") or [],
                "source": "peppro",
            }
            summaries.append(summary)

        summaries.sort(key=lambda order: str(order.get("createdAt") or order.get("updatedAt") or ""), reverse=True)
        return {"orders": summaries[:limit]}

    return handle_action(action)


@blueprint.get("/admin/taxes-by-state")
@require_auth
def admin_taxes_by_state():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role != "admin":
            err = ValueError("Admin access required")
            setattr(err, "status", 403)
            raise err
        period_start = request.args.get("periodStart") or request.args.get("start") or None
        period_end = request.args.get("periodEnd") or request.args.get("end") or None
        return order_service.get_taxes_by_state_for_admin(period_start=period_start, period_end=period_end)

    return handle_action(action)


@blueprint.patch("/admin/tax-tracking/<state_code>")
@require_auth
def update_admin_tax_tracking(state_code: str):
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role != "admin":
            err = ValueError("Admin access required")
            setattr(err, "status", 403)
            raise err

        payload = request.get_json(force=True, silent=True) or {}
        if "taxNexusApplied" in payload:
            raw_value = payload.get("taxNexusApplied")
        elif "filed" in payload:
            raw_value = payload.get("filed")
        elif "taxFiled" in payload:
            raw_value = payload.get("taxFiled")
        else:
            err = ValueError("taxNexusApplied is required")
            setattr(err, "status", 400)
            raise err

        if isinstance(raw_value, bool):
            tax_nexus_applied = raw_value
        elif isinstance(raw_value, (int, float)):
            tax_nexus_applied = raw_value != 0
        else:
            tax_nexus_applied = str(raw_value or "").strip().lower() in ("1", "true", "yes", "y", "on")

        try:
            updated = tax_tracking_service.set_tax_nexus_applied(state_code, tax_nexus_applied)
        except ValueError as exc:
            setattr(exc, "status", 400)
            raise
        except RuntimeError as exc:
            setattr(exc, "status", 503)
            raise

        order_service.invalidate_admin_taxes_by_state_cache()
        return updated

    return handle_action(action)


@blueprint.get("/admin/product-sales-commission")
@blueprint.get("/product-sales-commission")
@require_auth
def admin_products_commission():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("admin", "sales_lead", "saleslead", "sales-lead"):
            err = ValueError("Admin or Sales Lead access required")
            setattr(err, "status", 403)
            raise err
        period_start = request.args.get("periodStart") or request.args.get("start") or None
        period_end = request.args.get("periodEnd") or request.args.get("end") or None
        debug_raw = request.args.get("debug") or request.args.get("debugMode") or request.args.get("debug_mode") or None
        debug = str(debug_raw or "").strip().lower() in ("1", "true", "yes", "y", "on")
        return order_service.get_products_and_commission_for_admin(period_start=period_start, period_end=period_end, debug=debug)

    return handle_action(action)


@blueprint.get("/admin/users/<user_id>")
@require_auth
def admin_orders_for_user(user_id: str):
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("admin", "sales_lead", "saleslead", "sales-lead"):
            err = ValueError("Admin access required")
            setattr(err, "status", 403)
            raise err
        target_id = (user_id or "").strip()
        if not target_id:
            err = ValueError("user_id is required")
            setattr(err, "status", 400)
            raise err
        return order_service.get_orders_for_user(target_id)

    return handle_action(action)


@blueprint.get("/admin/shipstation-sync-status")
@require_auth
def admin_shipstation_sync_status():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role != "admin":
            err = ValueError("Admin access required")
            setattr(err, "status", 403)
            raise err
        from ..services.shipstation_status_sync_service import get_status

        return {"success": True, "state": get_status()}

    return handle_action(action)


@blueprint.get("/admin/shipstation/order-status/<order_number>")
@require_auth
def admin_shipstation_order_status(order_number: str):
    def action():
        _require_admin_user()
        normalized = str(order_number or "").strip()
        if not normalized:
            return {"error": "orderNumber is required"}, 400
        info = ship_station.fetch_order_status(normalized)
        return info or {"orderNumber": normalized, "status": None, "trackingNumber": None, "trackingStatus": None, "shipments": []}

    return handle_action(action)


@blueprint.post("/admin/sync-shipstation-statuses")
@require_auth
def admin_run_shipstation_sync_now():
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        role = (g.current_user.get("role") or "").lower()
        if role != "admin":
            err = ValueError("Admin access required")
            setattr(err, "status", 403)
            raise err
        ignore_cooldown = bool(payload.get("ignoreCooldown") is True or payload.get("ignore_cooldown") is True)
        from ..services.shipstation_status_sync_service import run_sync_once, get_status

        result = run_sync_once(ignore_cooldown=ignore_cooldown)
        return {"success": True, "result": result, "state": get_status()}

    return handle_action(action)


@blueprint.post("/estimate")
@require_auth
def estimate_order_totals():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    shipping_address = payload.get("shippingAddress") or {}
    shipping_estimate = payload.get("shippingEstimate") or {}
    shipping_total = payload.get("shippingTotal") or 0
    facility_pickup = bool(payload.get("handDelivery") is True or payload.get("facility_pickup") is True)
    payment_method = payload.get("paymentMethod") or payload.get("payment_method") or None
    discount_code = payload.get("discountCode") or payload.get("discount_code") or None
    user_id = g.current_user.get("id")
    return handle_action(
        lambda: order_service.estimate_order_totals(
            user_id=user_id,
            items=items,
            shipping_address=shipping_address,
            shipping_estimate=shipping_estimate,
            shipping_total=shipping_total,
            facility_pickup=facility_pickup,
            payment_method=payment_method,
            discount_code=discount_code,
        )
    )


@blueprint.post("/delegate/estimate")
def delegate_estimate_order_totals():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    shipping_address = payload.get("shippingAddress") or {}
    shipping_estimate = payload.get("shippingEstimate") or {}
    shipping_total = payload.get("shippingTotal") or 0
    facility_pickup = bool(payload.get("handDelivery") is True or payload.get("facility_pickup") is True)
    payment_method = payload.get("paymentMethod") or payload.get("payment_method") or None
    delegate_token = payload.get("delegateToken") or payload.get("delegate_token") or payload.get("token") or None
    discount_code = payload.get("discountCode") or payload.get("discount_code") or None

    def action():
        delegate_info = delegation_service.resolve_delegate_token(str(delegate_token or ""))
        validated = delegation_service.validate_delegate_items(str(delegate_token or ""), items)
        doctor_id = delegate_info.get("doctorId")
        if not doctor_id:
            err = ValueError("Invalid or expired delegate link")
            setattr(err, "status", 404)
            raise err
        return order_service.estimate_order_totals(
            user_id=str(doctor_id),
            items=validated.get("validatedItems") or items,
            shipping_address=shipping_address,
            shipping_estimate=shipping_estimate,
            shipping_total=shipping_total,
            facility_pickup=facility_pickup,
            payment_method=payment_method,
            discount_code=discount_code,
        )

    return handle_action(action)


@blueprint.post("/delegate/share")
def delegate_share_order():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    shipping_address = payload.get("shippingAddress") or {}
    shipping_estimate = payload.get("shippingEstimate") or {}
    shipping_total = payload.get("shippingTotal") or 0
    payment_method = payload.get("paymentMethod") or payload.get("payment_method") or None
    expected_shipment_window = payload.get("expectedShipmentWindow") or payload.get("expected_shipment_window") or None
    delegate_token = payload.get("delegateToken") or payload.get("delegate_token") or payload.get("token") or None

    def action():
        delegate_info = delegation_service.resolve_delegate_token(str(delegate_token or ""))
        validated = delegation_service.validate_delegate_items(str(delegate_token or ""), items)
        doctor_id = str(delegate_info.get("doctorId") or "").strip()
        doctor_name = str(delegate_info.get("doctorName") or "Doctor").strip() or "Doctor"
        if not doctor_id:
            err = ValueError("Invalid or expired delegate link")
            setattr(err, "status", 404)
            raise err

        estimate = order_service.estimate_order_totals(
            user_id=doctor_id,
            items=validated.get("validatedItems") or items,
            shipping_address=shipping_address,
            shipping_estimate=shipping_estimate,
            shipping_total=shipping_total,
            payment_method=payment_method,
        )
        totals = estimate.get("totals") if isinstance(estimate, dict) else None
        if not isinstance(totals, dict):
            err = RuntimeError("Unable to estimate order totals")
            setattr(err, "status", 502)
            raise err

        items_subtotal = float(totals.get("itemsTotal") or 0.0)
        shipping_total_value = float(totals.get("shippingTotal") or 0.0)
        tax_total_value = float(totals.get("taxTotal") or 0.0)
        grand_total_value = float(totals.get("grandTotal") or 0.0)

        raw_payment_method = str(payment_method or "").strip().lower()
        normalized_payment_method = raw_payment_method
        if normalized_payment_method in ("bacs", "bank", "bank_transfer", "direct_bank_transfer", "zelle"):
            normalized_payment_method = "bacs"
        else:
            normalized_payment_method = "stripe"

        try:
            tz = ZoneInfo(os.environ.get("ORDER_TIMEZONE") or "America/Los_Angeles")
        except Exception:
            tz = timezone.utc
        now_dt = datetime.now(tz)
        now = now_dt.isoformat()
        order_id = str(int(datetime.now(timezone.utc).timestamp() * 1000))
        order = {
            "id": order_id,
            "userId": doctor_id,
            "items": validated.get("validatedItems") or items,
            "pricingMode": "wholesale",
            "total": items_subtotal,
            "itemsSubtotal": items_subtotal,
            "shippingTotal": shipping_total_value,
            "taxTotal": tax_total_value,
            "grandTotal": grand_total_value,
            "shippingEstimate": shipping_estimate or {},
            "shippingAddress": shipping_address or {},
            "expectedShipmentWindow": expected_shipment_window,
            "physicianCertificationAccepted": False,
            "paymentMethod": normalized_payment_method,
            "paymentDetails": raw_payment_method if normalized_payment_method == "bacs" else None,
            "status": "delegation_draft",
            "createdAt": now,
            "updatedAt": now,
            "delegation": {
                "token": delegate_info.get("token"),
                "doctorId": doctor_id,
                "doctorName": doctor_name,
                "markupPercent": delegate_info.get("markupPercent"),
                "allowedProducts": delegate_info.get("allowedProducts") or [],
                "sharedAt": now,
            },
        }
        stored = order_repository.insert(order) or order
        stored_id = stored.get("id") if isinstance(stored, dict) else order_id
        delegation_service.store_delegate_submission(
            str(delegate_info.get("token") or ""),
            cart={"items": validated.get("validatedItems") or items},
            shipping={
                "shippingAddress": shipping_address or {},
                "shippingEstimate": shipping_estimate or {},
                "shippingRate": shipping_estimate or {},
                "shippingTotal": shipping_total_value,
                "taxTotal": tax_total_value,
                "expectedShipmentWindow": expected_shipment_window,
                "itemsSubtotal": items_subtotal,
                "grandTotal": grand_total_value,
            },
            payment={
                "paymentMethod": normalized_payment_method,
                "paymentDetails": raw_payment_method if normalized_payment_method == "bacs" else None,
                "rawPaymentMethod": raw_payment_method,
            },
            order_id=str(stored_id or order_id),
            shared_at=now_dt,
        )
        return {
            "success": True,
            "message": f"Shared with {doctor_name}",
            "order": {
                "id": stored.get("id") if isinstance(stored, dict) else order_id,
                "number": (stored.get("wooOrderNumber") or stored.get("id")) if isinstance(stored, dict) else order_id,
            },
        }

    return handle_action(action, status=201)


@blueprint.patch("/<order_id>/notes")
@require_auth
def update_order_notes(order_id: str):
    payload = request.get_json(force=True, silent=True) or {}
    notes = payload.get("notes") if "notes" in payload else None

    def action():
        actor = g.current_user or {}
        return order_service.update_order_notes(order_id=str(order_id), actor=actor, notes=notes)

    return handle_action(action)


@blueprint.patch("/<order_id>")
@require_auth
def patch_order(order_id: str):
    payload = request.get_json(force=True, silent=True) or {}

    def action():
        actor = g.current_user or {}
        role = (actor.get("role") or "").lower()
        if role not in ("admin", "sales_rep", "sales_partner", "rep"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err

        return order_service.update_order_fields(
            order_id=str(order_id),
            actor=actor,
            tracking_number=payload.get("trackingNumber") if "trackingNumber" in payload else None,
            shipping_carrier=payload.get("shippingCarrier") if "shippingCarrier" in payload else None,
            shipping_service=payload.get("shippingService") if "shippingService" in payload else None,
            status=payload.get("status") if "status" in payload else None,
            expected_shipment_window=payload.get("expectedShipmentWindow") if "expectedShipmentWindow" in payload else None,
        )

    return handle_action(action)


@blueprint.get("/<order_id>/invoice")
@require_auth
def download_invoice(order_id: str) -> Response:
    def action() -> Response:
        if not order_id:
            err = ValueError("Order id required")
            setattr(err, "status", 400)
            raise err

        role = (g.current_user.get("role") or "").lower()
        user_email = (g.current_user.get("email") or "").strip().lower()
        user_id = g.current_user.get("id")

        woo_order = None
        woo_error = None
        try:
            woo_order = woo_commerce.fetch_order(order_id)
            if not woo_order:
                woo_order = woo_commerce.fetch_order_by_number(order_id) or woo_commerce.fetch_order_by_peppro_id(order_id)
        except Exception as exc:
            if isinstance(exc, getattr(woo_commerce, "IntegrationError", Exception)):
                woo_error = exc
                woo_order = None
            else:
                raise

        if not woo_order and woo_error:
            local_order = _find_local_order_for_user_invoice(order_id, user_id=str(user_id) if user_id else None)
            if local_order:
                pdf_bytes, filename = _build_invoice_from_local_order(local_order, customer_email=user_email or None)
                resp = make_response(pdf_bytes)
                resp.headers["Content-Type"] = "application/pdf"
                resp.headers["Content-Disposition"] = f'attachment; filename="{filename or "PepPro_Invoice.pdf"}"'
                resp.headers["Cache-Control"] = "no-store"
                resp.headers["X-PepPro-Invoice-Source"] = "fallback-local"
                return resp

        if not woo_order:
            err = ValueError("Invoice is temporarily unavailable. Please retry shortly.")
            setattr(err, "status", 503)
            raise err

        billing_email = ""
        if isinstance(woo_order.get("billing"), dict):
            billing_email = (woo_order.get("billing") or {}).get("email") or ""
        billing_email = str(billing_email or "").strip().lower()

        is_admin_like = role in ("admin", "sales_rep", "sales_partner", "rep")
        if not is_admin_like:
            # Avoid leaking existence of other customers' orders.
            if not user_email or not billing_email or user_email != billing_email:
                err = ValueError("Order not found")
                setattr(err, "status", 404)
                raise err

        def extract_wpo_access_key(order: dict) -> str | None:
            meta = order.get("meta_data") or []
            if not isinstance(meta, list) or not meta:
                return None

            def unwrap(value) -> str | None:
                if value is None:
                    return None
                if isinstance(value, (str, int, float, bool)):
                    text = str(value).strip()
                    return text if text else None
                if isinstance(value, dict):
                    invoice_value = value.get("invoice") or value.get("Invoice")
                    if isinstance(invoice_value, (str, int, float)):
                        text = str(invoice_value).strip()
                        if text:
                            return text
                    access_value = value.get("access_key") or value.get("accessKey")
                    if isinstance(access_value, (str, int, float)):
                        text = str(access_value).strip()
                        if text:
                            return text
                return None

            direct_keys = (
                "_wcpdf_invoice_access_key",
                "wcpdf_invoice_access_key",
                "_wpo_wcpdf_invoice_access_key",
                "wpo_wcpdf_invoice_access_key",
                "_wpo_wcpdf_access_key",
                "wpo_wcpdf_access_key",
                "_wcpdf_access_key",
                "wcpdf_access_key",
                "wpo_wcpdf_document_access_key",
                "_wpo_wcpdf_document_access_key",
            )

            for key in direct_keys:
                for entry in meta:
                    if not isinstance(entry, dict):
                        continue
                    if str(entry.get("key") or "") == key:
                        value = unwrap(entry.get("value"))
                        if value:
                            return value

            for entry in meta:
                if not isinstance(entry, dict):
                    continue
                key = str(entry.get("key") or "")
                if not key:
                    continue
                normalized = key.lower()
                if "access" not in normalized:
                    continue
                if "wcpdf" not in normalized and "wpo" not in normalized:
                    continue
                value = unwrap(entry.get("value"))
                if value:
                    return value

            return None

        # Prefer the WP Overnight invoice generator if installed:
        # https://docs.wpovernight.com/topic/woocommerce-pdf-invoices-packing-slips/
        pdf_bytes = None
        filename = None
        invoice_source = "fallback"
        try:
            store_base = woo_commerce._sanitize_store_url()  # type: ignore[attr-defined]
            safe_id = quote(str(woo_order.get("id") or order_id).strip(), safe="")
            access_key = extract_wpo_access_key(woo_order)
            if store_base and safe_id and access_key:
                wpo_url = f"{store_base}/wp-admin/admin-ajax.php"
                resp = requests.get(
                    wpo_url,
                    params={
                        "action": "generate_wpo_wcpdf",
                        "document_type": "invoice",
                        "order_ids": safe_id,
                        "access_key": access_key,
                        "shortcode": "true",
                    },
                    timeout=25,
                    allow_redirects=True,
                    headers={"Accept": "application/pdf", "User-Agent": "PepPro Invoice Proxy"},
                )
                resp.raise_for_status()
                body = resp.content or b""
                if body.startswith(b"%PDF"):
                    pdf_bytes = body
                    invoice_source = "wpo"
                    disposition = resp.headers.get("content-disposition") or ""
                    if "filename=" in disposition.lower():
                        filename = disposition.split("filename=", 1)[-1].strip().strip('"').strip("'")
        except Exception:
            pdf_bytes = None
            filename = None
            invoice_source = "fallback"

        if pdf_bytes is None:
            mapped = woo_commerce._map_woo_order_summary(woo_order)  # type: ignore[attr-defined]
            pdf_bytes, filename = build_invoice_pdf(
                woo_order=woo_order,
                mapped_summary=mapped,
                customer_email=billing_email or user_email,
            )

        resp = make_response(pdf_bytes)
        resp.headers["Content-Type"] = "application/pdf"
        resp.headers["Content-Disposition"] = f'attachment; filename="{filename or "PepPro_Invoice.pdf"}"'
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-PepPro-Invoice-Source"] = invoice_source
        return resp

    return handle_action(action)
