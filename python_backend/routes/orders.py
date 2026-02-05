from __future__ import annotations

from datetime import datetime, timezone
from urllib.parse import quote

import requests
from flask import Blueprint, Response, g, make_response, request

from ..middleware.auth import require_auth
from ..integrations import ship_station
from ..integrations import woo_commerce
from ..repositories import order_repository
from ..services import order_service, delegation_service
from ..services.invoice_service import build_invoice_pdf
from ..utils.http import handle_action

blueprint = Blueprint("orders", __name__, url_prefix="/api/orders")

def _require_admin_user() -> None:
    role = str((getattr(g, "current_user", None) or {}).get("role") or "").strip().lower()
    if role != "admin":
        err = RuntimeError("Admin access required")
        setattr(err, "status", 403)
        raise err

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
    discount = _round_money(local_order.get("appliedReferralCredit") or 0)
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
    payment_method = payload.get("paymentMethod") or payload.get("payment_method") or None
    pricing_mode = payload.get("pricingMode") or payload.get("pricing_mode") or None
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
            payment_method=payment_method,
            pricing_mode=pricing_mode,
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
    force = (request.args.get("force") or "").strip().lower() in ("1", "true", "yes")
    return handle_action(lambda: order_service.get_orders_for_user(user_id, force=force))


@blueprint.get("/sales-rep")
@require_auth
def list_orders_for_sales_rep():
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        scope = (request.args.get("scope") or "").strip().lower()
        scope_all = role == "admin" and scope == "all"

        # Optional override: allow explicit salesRepId query param for admins and sales leads.
        override = (request.args.get("salesRepId") or "").strip() or None
        if override and role in ("admin", "sales_lead", "saleslead", "sales-lead"):
            sales_rep_id = override
        else:
            # When admin is requesting "all", omit the sales rep filter entirely.
            sales_rep_id = None if scope_all else g.current_user.get("id")
        force = (request.args.get("force") or "").strip().lower() in ("1", "true", "yes")
        include_doctors = (request.args.get("includeDoctors") or "").strip().lower() not in ("0", "false", "no")
        return order_service.get_orders_for_sales_rep(
            sales_rep_id,
            include_doctors=include_doctors,
            force=force,
            include_all_doctors=scope_all,
        )

    return handle_action(action)


@blueprint.get("/sales-rep/<order_id>")
@require_auth
def get_sales_rep_order_detail(order_id: str):
    def action():
        role = (g.current_user.get("role") or "").lower()
        if role not in ("sales_rep", "rep", "sales_lead", "saleslead", "sales-lead", "admin"):
            err = ValueError("Sales rep access required")
            setattr(err, "status", 403)
            raise err
        sales_rep_id = g.current_user.get("id")
        return order_service.get_sales_rep_order_detail(order_id, sales_rep_id, token_role=role)

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


@blueprint.get("/admin/product-sales-commission")
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
    payment_method = payload.get("paymentMethod") or payload.get("payment_method") or None
    user_id = g.current_user.get("id")
    return handle_action(
        lambda: order_service.estimate_order_totals(
            user_id=user_id,
            items=items,
            shipping_address=shipping_address,
            shipping_estimate=shipping_estimate,
            shipping_total=shipping_total,
            payment_method=payment_method,
        )
    )


@blueprint.post("/delegate/estimate")
def delegate_estimate_order_totals():
    payload = request.get_json(force=True, silent=True) or {}
    items = payload.get("items") or []
    shipping_address = payload.get("shippingAddress") or {}
    shipping_estimate = payload.get("shippingEstimate") or {}
    shipping_total = payload.get("shippingTotal") or 0
    payment_method = payload.get("paymentMethod") or payload.get("payment_method") or None
    delegate_token = payload.get("delegateToken") or payload.get("delegate_token") or payload.get("token") or None

    def action():
        delegate_info = delegation_service.resolve_delegate_token(str(delegate_token or ""))
        doctor_id = delegate_info.get("doctorId")
        if not doctor_id:
            err = ValueError("Invalid or expired delegation link")
            setattr(err, "status", 404)
            raise err
        return order_service.estimate_order_totals(
            user_id=str(doctor_id),
            items=items,
            shipping_address=shipping_address,
            shipping_estimate=shipping_estimate,
            shipping_total=shipping_total,
            payment_method=payment_method,
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
        doctor_id = str(delegate_info.get("doctorId") or "").strip()
        doctor_name = str(delegate_info.get("doctorName") or "Doctor").strip() or "Doctor"
        if not doctor_id:
            err = ValueError("Invalid or expired delegation link")
            setattr(err, "status", 404)
            raise err

        estimate = order_service.estimate_order_totals(
            user_id=doctor_id,
            items=items,
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

        now_dt = datetime.now(timezone.utc)
        now = now_dt.isoformat()
        order_id = str(int(datetime.now(timezone.utc).timestamp() * 1000))
        order = {
            "id": order_id,
            "userId": doctor_id,
            "items": items,
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
                "sharedAt": now,
            },
        }
        stored = order_repository.insert(order) or order
        stored_id = stored.get("id") if isinstance(stored, dict) else order_id
        delegation_service.store_delegate_submission(
            str(delegate_info.get("token") or ""),
            cart={"items": items},
            shipping={
                "shippingAddress": shipping_address or {},
                "shippingEstimate": shipping_estimate or {},
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
        if role not in ("admin", "sales_rep", "rep"):
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

        is_admin_like = role in ("admin", "sales_rep", "rep")
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
