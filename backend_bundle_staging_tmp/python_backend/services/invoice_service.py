from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple


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


def _invoice_filename(order_number: str) -> str:
    safe = "".join([c for c in (order_number or "").strip() if c.isalnum() or c in ("-", "_")]) or "order"
    return f"PepPro_Invoice_{safe}.pdf"


def _pdf_escape_text(value: str) -> str:
    return (
        (value or "")
        .replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .replace("\r", "")
    )


def _build_simple_text_pdf(lines: List[str]) -> bytes:
    """
    Minimal, dependency-free PDF generator for a single page of text.
    Uses Helvetica (built-in Type1 font) and a basic content stream.
    """
    # Letter: 612 x 792 points
    page_w = 612
    page_h = 792
    left = 72
    top = page_h - 72
    font_size = 11
    leading = 14

    content_lines: List[str] = [
        "BT",
        f"/F1 {font_size} Tf",
        f"{left} {top} Td",
        f"{leading} TL",
    ]
    for raw in lines:
        text = _pdf_escape_text(raw)[:240]
        content_lines.append(f"({text}) Tj")
        content_lines.append("T*")
    content_lines.append("ET")
    content = ("\n".join(content_lines) + "\n").encode("latin-1", errors="replace")

    def obj(num: int, body: bytes) -> bytes:
        return f"{num} 0 obj\n".encode("ascii") + body + b"\nendobj\n"

    objects: List[bytes] = []
    objects.append(obj(1, b"<< /Type /Catalog /Pages 2 0 R >>"))
    objects.append(obj(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"))
    objects.append(
        obj(
            3,
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_w} {page_h}] /Contents 4 0 R "
            f"/Resources << /Font << /F1 5 0 R >> >> >>".encode("ascii"),
        )
    )
    stream = b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"endstream"
    objects.append(obj(4, stream))
    objects.append(obj(5, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"))

    header = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    parts: List[bytes] = [header]
    offsets: List[int] = [0]
    for o in objects:
        offsets.append(sum(len(p) for p in parts))
        parts.append(o)
    xref_start = sum(len(p) for p in parts)

    xref = [b"xref\n", f"0 {len(objects) + 1}\n".encode("ascii"), b"0000000000 65535 f \n"]
    for off in offsets[1:]:
        xref.append(f"{off:010d} 00000 n \n".encode("ascii"))
    trailer = (
        b"trailer\n"
        + f"<< /Size {len(objects) + 1} /Root 1 0 R >>\n".encode("ascii")
        + b"startxref\n"
        + f"{xref_start}\n".encode("ascii")
        + b"%%EOF\n"
    )
    parts.extend(xref)
    parts.append(trailer)
    return b"".join(parts)


def build_invoice_pdf(
    *,
    woo_order: Dict[str, Any],
    mapped_summary: Dict[str, Any],
    customer_email: str,
) -> Tuple[bytes, str]:
    currency = (mapped_summary.get("currency") or woo_order.get("currency") or "USD").strip() or "USD"
    order_number = str(
        mapped_summary.get("wooOrderNumber")
        or mapped_summary.get("number")
        or woo_order.get("number")
        or woo_order.get("id")
        or "Order"
    ).strip()
    invoice_date = _format_date(mapped_summary.get("createdAt") or woo_order.get("date_created") or woo_order.get("date_created_gmt"))
    payment_label = (mapped_summary.get("paymentDetails") or mapped_summary.get("paymentMethod") or "").strip()

    shipping_address = mapped_summary.get("shippingAddress") or {}
    billing_address = mapped_summary.get("billingAddress") or {}
    if isinstance(woo_order.get("billing"), dict) and not billing_address:
        billing_address = woo_order.get("billing") or {}
    if isinstance(woo_order.get("shipping"), dict) and not shipping_address:
        shipping_address = woo_order.get("shipping") or {}

    items = woo_order.get("line_items") or []
    if not isinstance(items, list):
        items = []

    subtotal = 0.0
    line_rows: List[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        qty = int(_as_float(item.get("quantity"), 0.0))
        total = _as_float(item.get("total"), 0.0)
        subtotal += total
        name = (item.get("name") or "").strip() or "Item"
        sku = (item.get("sku") or "").strip()
        sku_part = f" [{sku}]" if sku else ""
        unit = (total / qty) if qty > 0 else total
        line_rows.append(f"{qty} x {name}{sku_part}  @ {format_money(unit, currency)}  = {format_money(total, currency)}")

    shipping_total = _as_float(mapped_summary.get("shippingTotal"), _as_float(woo_order.get("shipping_total"), 0.0))
    tax_total = _as_float(mapped_summary.get("taxTotal"), _as_float(woo_order.get("total_tax"), 0.0))
    grand_total = _as_float(mapped_summary.get("grandTotal"), _as_float(woo_order.get("total"), subtotal + shipping_total + tax_total))

    lines: List[str] = []
    lines.append("PepPro Invoice")
    lines.append("")
    if invoice_date:
        lines.append(f"Date: {invoice_date}")
    lines.append(f"Order #: {order_number}")
    if customer_email:
        lines.append(f"Email: {customer_email}")
    if payment_label:
        lines.append(f"Payment: {payment_label}")
    lines.append("")
    lines.append("Ship To:")
    ship_lines = _address_lines(shipping_address) or ["—"]
    lines.extend([f"  {l}" for l in ship_lines])
    lines.append("")
    lines.append("Bill To:")
    bill_lines = _address_lines(billing_address) or ["—"]
    lines.extend([f"  {l}" for l in bill_lines])
    lines.append("")
    lines.append("Items:")
    if line_rows:
        lines.extend([f"  {row}" for row in line_rows])
    else:
        lines.append("  —")
    lines.append("")
    lines.append("Totals:")
    lines.append(f"  Subtotal: {format_money(subtotal, currency)}")
    lines.append(f"  Shipping: {format_money(shipping_total, currency)}")
    lines.append(f"  Tax: {format_money(tax_total, currency)}")
    lines.append(f"  Total: {format_money(grand_total, currency)}")

    pdf_bytes = _build_simple_text_pdf(lines)
    return pdf_bytes, _invoice_filename(order_number)

