from __future__ import annotations

from flask import Blueprint, Response, g, make_response, request

from ..middleware.auth import require_auth
from ..integrations import woo_commerce
from ..services import order_service
from ..services.invoice_service import build_invoice_pdf
from ..utils.http import handle_action

blueprint = Blueprint("orders", __name__, url_prefix="/api/orders")


@blueprint.post("/")
@require_auth
def create_order():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    total = payload.get("total")
    referral_code = payload.get("referralCode")
    tax_total = payload.get("taxTotal")
    shipping_total = payload.get("shippingTotal")
    shipping_address = payload.get("shippingAddress")
    # Support both keys from frontend/backends
    shipping_rate = payload.get("shippingRate") or payload.get("shippingEstimate")
    expected_shipment_window = payload.get("expectedShipmentWindow") or None
    physician_certified = bool(
        payload.get("physicianCertificationAccepted")
        or payload.get("physicianCertification")
    )
    user_id = g.current_user.get("id")
    return handle_action(
        lambda: order_service.create_order(
            user_id=user_id,
            items=items,
            total=total,
            referral_code=referral_code,
            tax_total=tax_total,
            shipping_total=shipping_total,
            shipping_address=shipping_address,
            shipping_rate=shipping_rate,
            expected_shipment_window=expected_shipment_window,
            physician_certified=physician_certified,
        )
    )


@blueprint.get("/")
@require_auth
def list_orders():
    user_id = g.current_user.get("id")
    return handle_action(lambda: order_service.get_orders_for_user(user_id))


@blueprint.get("/sales-rep")
@require_auth
def list_orders_for_sales_rep():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "rep", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        sales_rep_id = g.current_user.get("id")
        # Optional override: allow explicit salesRepId query param for admins
        override = request.args.get("salesRepId") or None
        if override and role == "admin":
            sales_rep_id = override
        force = (request.args.get("force") or "").strip().lower() in ("1", "true", "yes")
        include_doctors = (request.args.get("includeDoctors") or "").strip().lower() not in ("0", "false", "no")
        return order_service.get_orders_for_sales_rep(sales_rep_id, include_doctors=include_doctors, force=force)

    return handle_action(action)


@blueprint.get("/sales-rep/<order_id>")
@require_auth
def get_sales_rep_order_detail(order_id: str):
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "rep", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        sales_rep_id = g.current_user.get("id")
        return order_service.get_sales_rep_order_detail(order_id, sales_rep_id)

    return handle_action(action)


@blueprint.post("/<order_id>/cancel")
@require_auth
def cancel_order(order_id: str):
    payload = request.get_json(force=True, silent=True) or {}
    reason = (payload.get("reason") or "").strip()
    user_id = g.current_user.get("id")
    return handle_action(lambda: order_service.cancel_order(user_id=user_id, order_id=order_id, reason=reason))


@blueprint.get("/admin/sales-rep-summary")
@require_auth
def admin_sales_by_rep():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role != "admin":
            err = ValueError("Admin access required")
            setattr(err, "status", 403)
            raise err
        exclude_id = g.current_user.get("id")
        period_start = request.args.get("periodStart") or request.args.get("start") or None
        period_end = request.args.get("periodEnd") or request.args.get("end") or None
        return order_service.get_sales_by_rep(
            exclude_sales_rep_id=exclude_id,
            period_start=period_start,
            period_end=period_end,
        )

    return handle_action(action)


@blueprint.post("/estimate")
@require_auth
def estimate_order_totals():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    shipping_address = payload.get("shippingAddress") or {}
    shipping_estimate = payload.get("shippingEstimate") or {}
    shipping_total = payload.get("shippingTotal") or 0
    user_id = g.current_user.get("id")
    return handle_action(
        lambda: order_service.estimate_order_totals(
            user_id=user_id,
            items=items,
            shipping_address=shipping_address,
            shipping_estimate=shipping_estimate,
            shipping_total=shipping_total,
        )
    )


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

        woo_order = woo_commerce.fetch_order(order_id)
        if not woo_order:
            woo_order = woo_commerce.fetch_order_by_number(order_id) or woo_commerce.fetch_order_by_peppro_id(order_id)
        if not woo_order:
            err = ValueError("Order not found")
            setattr(err, "status", 404)
            raise err

        billing_email = ""
        if isinstance(woo_order.get("billing"), dict):
            billing_email = (woo_order.get("billing") or {}).get("email") or ""
        billing_email = str(billing_email or "").strip().lower()

        is_admin_like = role in ("admin", "sales_rep", "rep")
        if not is_admin_like:
            # Avoid leaking existence of other customers' orders.
            if not user_email or not billing_email or user_email != billing_email:
                err = ValueError("Order not found")
                setattr(err, "status", 404)
                raise err

        mapped = woo_commerce._map_woo_order_summary(woo_order)  # type: ignore[attr-defined]
        pdf_bytes, filename = build_invoice_pdf(
            woo_order=woo_order,
            mapped_summary=mapped,
            customer_email=billing_email or user_email,
        )

        resp = make_response(pdf_bytes)
        resp.headers["Content-Type"] = "application/pdf"
        resp.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
        resp.headers["Cache-Control"] = "no-store"
        return resp

    return handle_action(action)
