from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from fpdf import FPDF


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _currency_symbol(code: str) -> str:
    normalized = (code or "USD").strip().upper()
    if normalized == "USD":
        return "$"
    return f"{normalized} "


def format_money(amount: Any, currency: str = "USD") -> str:
    symbol = _currency_symbol(currency)
    value = _as_float(amount, 0.0)
    return f"{symbol}{value:,.2f}"


def _format_date(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%b %d, %Y")
    text = str(value).strip()
    if not text:
        return ""
    # Accept ISO timestamps; fall back to raw.
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.strftime("%b %d, %Y")
    except Exception:
        return text


def _address_lines(addr: Optional[Dict[str, Any]]) -> List[str]:
    if not isinstance(addr, dict):
        return []
    lines: List[str] = []
    name = (addr.get("name") or "").strip()
    if name:
        lines.append(name)
    line1 = (addr.get("addressLine1") or addr.get("address_1") or "").strip()
    line2 = (addr.get("addressLine2") or addr.get("address_2") or "").strip()
    city = (addr.get("city") or "").strip()
    state = (addr.get("state") or "").strip()
    postal = (addr.get("postalCode") or addr.get("postcode") or "").strip()
    country = (addr.get("country") or "").strip()
    if line1:
        lines.append(line1)
    if line2:
        lines.append(line2)
    city_state = ", ".join([part for part in [city, state] if part]).strip()
    city_state_postal = " ".join([part for part in [city_state, postal] if part]).strip()
    if city_state_postal:
        lines.append(city_state_postal)
    if country:
        lines.append(country)
    phone = (addr.get("phone") or "").strip()
    if phone:
        lines.append(phone)
    return lines


def _collect_line_items(woo_order: Dict[str, Any]) -> List[Dict[str, Any]]:
    items = woo_order.get("line_items") or []
    if isinstance(items, list):
        return [item for item in items if isinstance(item, dict)]
    return []


def _invoice_filename(order_number: str) -> str:
    safe = "".join([c for c in (order_number or "").strip() if c.isalnum() or c in ("-", "_")]) or "order"
    return f"PepPro_Invoice_{safe}.pdf"


def build_invoice_pdf(
    *,
    woo_order: Dict[str, Any],
    mapped_summary: Dict[str, Any],
    customer_email: str,
) -> Tuple[bytes, str]:
    currency = (mapped_summary.get("currency") or woo_order.get("currency") or "USD").strip() or "USD"
    order_number = str(mapped_summary.get("wooOrderNumber") or mapped_summary.get("number") or woo_order.get("number") or woo_order.get("id") or "Order").strip()
    invoice_date = _format_date(mapped_summary.get("createdAt") or woo_order.get("date_created") or woo_order.get("date_created_gmt"))
    payment_label = (mapped_summary.get("paymentDetails") or mapped_summary.get("paymentMethod") or "").strip()

    shipping_address = mapped_summary.get("shippingAddress") or {}
    billing_address = mapped_summary.get("billingAddress") or {}
    if isinstance(woo_order.get("billing"), dict) and not billing_address:
        billing_address = woo_order.get("billing") or {}
    if isinstance(woo_order.get("shipping"), dict) and not shipping_address:
        shipping_address = woo_order.get("shipping") or {}

    items = _collect_line_items(woo_order)
    subtotal = 0.0
    simplified_items: List[Dict[str, Any]] = []
    for item in items:
        qty = int(_as_float(item.get("quantity"), 0.0))
        total = _as_float(item.get("total"), 0.0)
        subtotal += total
        simplified_items.append(
            {
                "name": (item.get("name") or "").strip() or "Item",
                "sku": (item.get("sku") or "").strip() or None,
                "quantity": qty,
                "total": total,
            }
        )

    shipping_total = _as_float(mapped_summary.get("shippingTotal"), _as_float(woo_order.get("shipping_total"), 0.0))
    tax_total = _as_float(mapped_summary.get("taxTotal"), _as_float(woo_order.get("total_tax"), 0.0))
    grand_total = _as_float(mapped_summary.get("grandTotal"), _as_float(woo_order.get("total"), subtotal + shipping_total + tax_total))

    pdf = FPDF(orientation="P", unit="mm", format="Letter")
    pdf.set_auto_page_break(auto=True, margin=14)
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 20)
    pdf.cell(0, 10, "Invoice", new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 11)
    if invoice_date:
        pdf.cell(0, 6, f"Date: {invoice_date}", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Order #: {order_number}", new_x="LMARGIN", new_y="NEXT")
    if customer_email:
        pdf.cell(0, 6, f"Email: {customer_email}", new_x="LMARGIN", new_y="NEXT")
    if payment_label:
        pdf.cell(0, 6, f"Payment: {payment_label}", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 6, "Ship To", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    ship_lines = _address_lines(shipping_address)
    if ship_lines:
        for line in ship_lines:
            pdf.cell(0, 5, line, new_x="LMARGIN", new_y="NEXT")
    else:
        pdf.cell(0, 5, "—", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 6, "Bill To", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    bill_lines = _address_lines(billing_address)
    if bill_lines:
        for line in bill_lines:
            pdf.cell(0, 5, line, new_x="LMARGIN", new_y="NEXT")
    else:
        pdf.cell(0, 5, "—", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(5)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 6, "Items", new_x="LMARGIN", new_y="NEXT")

    pdf.set_font("Helvetica", "", 11)
    if simplified_items:
        for entry in simplified_items:
            qty = int(entry.get("quantity") or 0)
            total = _as_float(entry.get("total"), 0.0)
            unit = (total / qty) if qty > 0 else total
            name = entry.get("name") or "Item"
            sku = entry.get("sku")
            title = f"{qty} × {name}"
            if sku:
                title = f"{title} (SKU {sku})"
            pdf.multi_cell(0, 5.2, title)
            pdf.set_text_color(80, 80, 80)
            pdf.set_font("Helvetica", "", 10)
            pdf.cell(0, 5, f"Unit: {format_money(unit, currency)}    Line total: {format_money(total, currency)}", new_x="LMARGIN", new_y="NEXT")
            pdf.set_text_color(0, 0, 0)
            pdf.set_font("Helvetica", "", 11)
            pdf.ln(1)
    else:
        pdf.cell(0, 5.2, "—", new_x="LMARGIN", new_y="NEXT")

    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 6, "Totals", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 11)
    pdf.cell(0, 6, f"Subtotal: {format_money(subtotal, currency)}", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Shipping: {format_money(shipping_total, currency)}", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, f"Tax: {format_money(tax_total, currency)}", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 7, f"Total: {format_money(grand_total, currency)}", new_x="LMARGIN", new_y="NEXT")

    data = pdf.output(dest="S")
    if isinstance(data, bytes):
        pdf_bytes = data
    else:
        pdf_bytes = data.encode("latin-1")
    return pdf_bytes, _invoice_filename(order_number)

