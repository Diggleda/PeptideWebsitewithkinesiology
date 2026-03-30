from __future__ import annotations

import re
import time
from typing import Dict, List, Optional

from ..repositories import (
    sales_prospect_quote_repository,
    sales_prospect_repository,
    sales_rep_repository,
    user_repository,
)
from ..utils.http import service_error as _service_error, utc_now_iso as _now
from . import referral_service
from .sales_prospect_quote_pdf_service import generate_prospect_quote_pdf

QUOTE_STATUS_DRAFT = "draft"
QUOTE_STATUS_EXPORTED = "exported"


def _normalize_role(value: object) -> str:
    return re.sub(r"[\s-]+", "_", str(value or "").strip().lower())


def _normalize_optional_text(value: object) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _is_doctor_user(user: Optional[Dict]) -> bool:
    role = _normalize_role((user or {}).get("role"))
    return role in {"doctor", "test_doctor"}


def _is_sales_rep_like_role(role: object) -> bool:
    normalized = _normalize_role(role)
    return normalized in {"sales_rep", "sales_partner", "rep", "sales_lead", "saleslead", "admin"}


def _ensure_sales_rep(user: Optional[Dict], context: str = "unknown") -> None:
    del context
    role = _normalize_role((user or {}).get("role"))
    if not user or not _is_sales_rep_like_role(role):
        raise _service_error("SALES_REP_ACCESS_REQUIRED", 403)


def _extract_contact_form_id(identifier: object) -> Optional[str]:
    raw = str(identifier or "").strip()
    if not raw.startswith("contact_form:"):
        return None
    return _normalize_optional_text(raw.split(":", 1)[1])


def _to_money(value: object) -> float:
    try:
        numeric = float(value or 0)
    except Exception:
        return 0.0
    return round(numeric + 1e-12, 2)


def _normalize_title(value: object, fallback: str = "Quote") -> str:
    return _normalize_optional_text(value) or fallback


def _normalize_quote_items(items: object) -> List[Dict]:
    normalized_items: List[Dict] = []
    for index, item in enumerate(items if isinstance(items, list) else []):
        if not isinstance(item, dict):
            continue
        try:
            quantity = max(1, int(float(item.get("quantity") or 1)))
        except Exception:
            quantity = 1
        unit_price = _to_money(item.get("unitPrice"))
        line_total = _to_money(item.get("lineTotal") if item.get("lineTotal") is not None else unit_price * quantity)
        product_id = _normalize_optional_text(item.get("productId"))
        name = _normalize_title(item.get("name"), "Item")
        if not product_id and not name:
            continue
        normalized_items.append(
            {
                "position": index + 1,
                "productId": product_id,
                "variantId": _normalize_optional_text(item.get("variantId")),
                "sku": _normalize_optional_text(item.get("sku")),
                "imageUrl": _normalize_optional_text(item.get("imageUrl") or item.get("image")),
                "name": name,
                "quantity": quantity,
                "unitPrice": unit_price,
                "lineTotal": line_total,
                "note": _normalize_optional_text(item.get("note")),
            }
        )
    return normalized_items


def _sanitize_quote_summary(quote: Optional[Dict]) -> Optional[Dict]:
    if not quote:
        return None
    return {
        "id": quote.get("id"),
        "prospectId": quote.get("prospectId"),
        "salesRepId": quote.get("salesRepId"),
        "revisionNumber": quote.get("revisionNumber"),
        "status": quote.get("status"),
        "title": quote.get("title"),
        "currency": quote.get("currency"),
        "subtotal": quote.get("subtotal"),
        "createdAt": quote.get("createdAt"),
        "updatedAt": quote.get("updatedAt"),
        "exportedAt": quote.get("exportedAt"),
    }


def _sanitize_quote_detail(quote: Optional[Dict]) -> Optional[Dict]:
    if not quote:
        return None
    return {
        **(_sanitize_quote_summary(quote) or {}),
        "quotePayloadJson": quote.get("quotePayloadJson"),
    }


def _resolve_sales_rep_snapshot(prospect: Optional[Dict], actor: Optional[Dict]) -> Dict:
    prospect_sales_rep_id = _normalize_optional_text((prospect or {}).get("salesRepId"))
    rep_record = None
    if prospect_sales_rep_id:
        rep_record = sales_rep_repository.find_by_id(prospect_sales_rep_id) or sales_rep_repository.find_by_email(
            prospect_sales_rep_id
        )
    linked_user = user_repository.find_by_id(prospect_sales_rep_id) if prospect_sales_rep_id else None
    return {
        "id": prospect_sales_rep_id
        or _normalize_optional_text((actor or {}).get("salesRepId"))
        or _normalize_optional_text((actor or {}).get("id")),
        "name": _normalize_optional_text((rep_record or {}).get("name"))
        or _normalize_optional_text((linked_user or {}).get("name"))
        or _normalize_optional_text((actor or {}).get("name"))
        or "PepPro",
        "email": _normalize_optional_text((rep_record or {}).get("email"))
        or _normalize_optional_text((linked_user or {}).get("email"))
        or _normalize_optional_text((actor or {}).get("email")),
    }


def _build_prospect_base_record(
    *,
    identifier: str,
    existing: Optional[Dict] = None,
    owner_sales_rep_id: Optional[str] = None,
    prospect_snapshot: Optional[Dict] = None,
) -> Dict:
    normalized_identifier = _normalize_optional_text(identifier)
    if not normalized_identifier:
        raise _service_error("IDENTIFIER_REQUIRED", 400)

    snapshot = prospect_snapshot if isinstance(prospect_snapshot, dict) else {}
    owner = (
        _normalize_optional_text((existing or {}).get("salesRepId"))
        or _normalize_optional_text(owner_sales_rep_id)
        or _normalize_optional_text(snapshot.get("salesRepId"))
        or _normalize_optional_text(snapshot.get("ownerSalesRepId"))
    )

    contact_name = _normalize_optional_text(
        snapshot.get("contactName") or snapshot.get("referredContactName") or snapshot.get("name")
    )
    contact_email = _normalize_optional_text(
        snapshot.get("contactEmail") or snapshot.get("referredContactEmail") or snapshot.get("email")
    )
    contact_phone = _normalize_optional_text(
        snapshot.get("contactPhone") or snapshot.get("referredContactPhone") or snapshot.get("phone")
    )
    status = _normalize_optional_text(snapshot.get("status")) or _normalize_optional_text((existing or {}).get("status"))

    contact_form_id = _extract_contact_form_id(normalized_identifier) or _normalize_optional_text(snapshot.get("contactFormId"))
    if contact_form_id:
        return {
            "id": normalized_identifier,
            "salesRepId": owner,
            "contactFormId": contact_form_id,
            "status": status or "contact_form",
            "isManual": False,
            "contactName": contact_name,
            "contactEmail": contact_email,
            "contactPhone": contact_phone,
        }

    if normalized_identifier.startswith("manual:"):
        return {
            "id": normalized_identifier,
            "salesRepId": owner,
            "status": status or "pending",
            "isManual": True,
            "contactName": contact_name,
            "contactEmail": contact_email,
            "contactPhone": contact_phone,
        }

    doctor_id = _normalize_optional_text(
        snapshot.get("doctorId") or snapshot.get("referredContactAccountId") or normalized_identifier
    )
    doctor = user_repository.find_by_id(doctor_id) if doctor_id else None
    if doctor and _is_doctor_user(doctor):
        return {
            "id": f"doctor:{doctor_id}",
            "salesRepId": owner,
            "doctorId": doctor_id,
            "status": status or "converted",
            "isManual": True,
            "contactName": contact_name or _normalize_optional_text(doctor.get("name")),
            "contactEmail": contact_email or _normalize_optional_text(doctor.get("email")),
            "contactPhone": contact_phone or _normalize_optional_text(doctor.get("phone")),
        }

    return {
        "id": normalized_identifier,
        "salesRepId": owner,
        "referralId": _normalize_optional_text(snapshot.get("referralId")) or normalized_identifier,
        "status": status or "pending",
        "isManual": False,
        "contactName": contact_name,
        "contactEmail": contact_email,
        "contactPhone": contact_phone,
    }


def _resolve_scoped_prospect_access(
    *,
    identifier: str,
    user: Dict,
    query: Optional[Dict] = None,
    context: str = "unknown",
) -> Dict:
    _ensure_sales_rep(user, context)
    normalized_identifier = _normalize_optional_text(identifier)
    if not normalized_identifier:
        raise _service_error("IDENTIFIER_REQUIRED", 400)

    query = query or {}
    role = _normalize_role(user.get("role"))
    is_admin = role == "admin"
    is_lead = role in {"sales_lead", "saleslead"}
    scope_all = (is_admin or is_lead) and str(query.get("scope") or "").strip().lower() == "all"
    requested_sales_rep_id = (
        _normalize_optional_text(query.get("salesRepId"))
        or _normalize_optional_text(user.get("salesRepId"))
        or _normalize_optional_text(user.get("id"))
    )
    sales_rep_id = None if scope_all else requested_sales_rep_id

    if is_admin or scope_all:
        prospect = referral_service.get_sales_prospect_for_admin(normalized_identifier)
    else:
        prospect = referral_service.get_sales_prospect_for_sales_rep(str(sales_rep_id or ""), normalized_identifier)

    return {
        "identifier": normalized_identifier,
        "prospect": prospect,
        "salesRepId": sales_rep_id,
        "requestedSalesRepId": requested_sales_rep_id,
        "isAdmin": is_admin,
        "isLead": is_lead,
        "scopeAll": scope_all,
    }


def _ensure_prospect_record(
    *,
    identifier: str,
    user: Dict,
    query: Optional[Dict] = None,
    context: str,
    prospect_snapshot: Optional[Dict] = None,
) -> Dict:
    access = _resolve_scoped_prospect_access(identifier=identifier, user=user, query=query, context=context)
    if access.get("prospect"):
        return access

    owner_sales_rep_id = (
        _normalize_optional_text((prospect_snapshot or {}).get("salesRepId"))
        or _normalize_optional_text((prospect_snapshot or {}).get("ownerSalesRepId"))
        or _normalize_optional_text(access.get("salesRepId"))
        or _normalize_optional_text(user.get("salesRepId"))
        or _normalize_optional_text(user.get("id"))
    )
    base_record = _build_prospect_base_record(
        identifier=access["identifier"],
        existing=None,
        owner_sales_rep_id=owner_sales_rep_id,
        prospect_snapshot=prospect_snapshot,
    )
    access["prospect"] = sales_prospect_repository.upsert(base_record)
    return access


def list_quotes_for_prospect(*, identifier: str, user: Dict, query: Optional[Dict] = None) -> Dict:
    access = _resolve_scoped_prospect_access(identifier=identifier, user=user, query=query, context="list_quotes_for_prospect")
    if not access.get("prospect"):
        return {
            "prospect": None,
            "currentDraft": None,
            "history": [],
        }

    history = sales_prospect_quote_repository.list_by_prospect_id(access["prospect"]["id"])
    current_draft = next((quote for quote in history if quote.get("status") == QUOTE_STATUS_DRAFT), None)
    return {
        "prospect": access["prospect"],
        "currentDraft": _sanitize_quote_detail(current_draft),
        "history": [summary for summary in (_sanitize_quote_summary(quote) for quote in history) if summary],
    }


def import_cart_to_prospect_quote(
    *,
    identifier: str,
    user: Dict,
    query: Optional[Dict] = None,
    payload: Optional[Dict] = None,
) -> Dict:
    quote_input = payload if isinstance(payload, dict) else {}
    items = _normalize_quote_items(quote_input.get("items"))
    if not items:
        raise _service_error("QUOTE_ITEMS_REQUIRED", 400)

    access = _ensure_prospect_record(
        identifier=identifier,
        user=user,
        query=query,
        context="import_cart_to_prospect_quote",
        prospect_snapshot=quote_input.get("prospectSnapshot") if isinstance(quote_input.get("prospectSnapshot"), dict) else None,
    )

    history = sales_prospect_quote_repository.list_by_prospect_id(access["prospect"]["id"])
    active_draft = next((quote for quote in history if quote.get("status") == QUOTE_STATUS_DRAFT), None)
    max_revision = max((int(quote.get("revisionNumber") or 0) for quote in history), default=0)
    revision_number = int(active_draft.get("revisionNumber")) if active_draft else max(1, max_revision + 1)
    subtotal = _to_money(
        quote_input.get("subtotal")
        if quote_input.get("subtotal") is not None
        else sum(_to_money(item.get("lineTotal")) for item in items)
    )
    draft_title = _normalize_title(quote_input.get("title"), (active_draft or {}).get("title") or f"Quote R{revision_number}")
    input_snapshot = quote_input.get("prospectSnapshot") if isinstance(quote_input.get("prospectSnapshot"), dict) else {}
    prospect = access["prospect"]
    prospect_snapshot = {
        "identifier": access["identifier"],
        "id": prospect.get("id"),
        "status": prospect.get("status"),
        "salesRepId": prospect.get("salesRepId"),
        "doctorId": prospect.get("doctorId") or _normalize_optional_text(input_snapshot.get("doctorId")),
        "referralId": prospect.get("referralId") or _normalize_optional_text(input_snapshot.get("referralId")),
        "contactFormId": prospect.get("contactFormId") or _normalize_optional_text(input_snapshot.get("contactFormId")),
        "contactName": prospect.get("contactName")
        or _normalize_optional_text(input_snapshot.get("contactName"))
        or _normalize_optional_text(input_snapshot.get("referredContactName")),
        "contactEmail": prospect.get("contactEmail")
        or _normalize_optional_text(input_snapshot.get("contactEmail"))
        or _normalize_optional_text(input_snapshot.get("referredContactEmail")),
        "contactPhone": prospect.get("contactPhone")
        or _normalize_optional_text(input_snapshot.get("contactPhone"))
        or _normalize_optional_text(input_snapshot.get("referredContactPhone")),
    }

    quote = sales_prospect_quote_repository.upsert(
        {
            "id": (active_draft or {}).get("id"),
            "prospectId": prospect.get("id"),
            "salesRepId": prospect.get("salesRepId")
            or _normalize_optional_text(user.get("salesRepId"))
            or _normalize_optional_text(user.get("id")),
            "revisionNumber": revision_number,
            "status": QUOTE_STATUS_DRAFT,
            "title": draft_title,
            "currency": str(quote_input.get("currency") or "USD").strip().upper() or "USD",
            "subtotal": subtotal,
            "exportedAt": None,
            "quotePayloadJson": {
                "title": draft_title,
                "notes": _normalize_optional_text(quote_input.get("notes")),
                "pricingMode": str(quote_input.get("pricingMode") or "wholesale").strip().lower() or "wholesale",
                "currency": str(quote_input.get("currency") or "USD").strip().upper() or "USD",
                "subtotal": subtotal,
                "items": items,
                "prospect": prospect_snapshot,
                "salesRep": _resolve_sales_rep_snapshot(prospect, user),
            },
        }
    )

    next_history = sales_prospect_quote_repository.list_by_prospect_id(prospect.get("id"))
    return {
        "prospect": prospect,
        "quote": _sanitize_quote_detail(quote),
        "history": [summary for summary in (_sanitize_quote_summary(record) for record in next_history) if summary],
    }


def update_prospect_quote(
    *,
    identifier: str,
    quote_id: str,
    user: Dict,
    query: Optional[Dict] = None,
    payload: Optional[Dict] = None,
) -> Dict:
    access = _resolve_scoped_prospect_access(identifier=identifier, user=user, query=query, context="update_prospect_quote")
    if not access.get("prospect"):
        raise _service_error("PROSPECT_NOT_FOUND", 404)

    existing = sales_prospect_quote_repository.find_by_id(quote_id)
    if not existing or existing.get("prospectId") != access["prospect"].get("id"):
        raise _service_error("QUOTE_NOT_FOUND", 404)
    if existing.get("status") != QUOTE_STATUS_DRAFT:
        raise _service_error("QUOTE_NOT_EDITABLE", 409)

    next_payload = payload if isinstance(payload, dict) else {}
    title = _normalize_title(next_payload.get("title"), existing.get("title") or "Quote")
    current_quote_payload = existing.get("quotePayloadJson") if isinstance(existing.get("quotePayloadJson"), dict) else {}
    notes = (
        _normalize_optional_text(next_payload.get("notes"))
        if "notes" in next_payload
        else _normalize_optional_text(current_quote_payload.get("notes"))
    )

    updated = sales_prospect_quote_repository.upsert(
        {
            **existing,
            "title": title,
            "quotePayloadJson": {
                **current_quote_payload,
                "title": title,
                "notes": notes,
            },
        }
    )
    return {
        "prospect": access["prospect"],
        "quote": _sanitize_quote_detail(updated),
    }


def export_prospect_quote(
    *,
    identifier: str,
    quote_id: str,
    user: Dict,
    query: Optional[Dict] = None,
) -> Dict:
    started_at = time.perf_counter()
    access_started_at = time.perf_counter()
    access = _resolve_scoped_prospect_access(identifier=identifier, user=user, query=query, context="export_prospect_quote")
    access_ms = round((time.perf_counter() - access_started_at) * 1000, 1)
    if not access.get("prospect"):
        raise _service_error("PROSPECT_NOT_FOUND", 404)

    find_quote_started_at = time.perf_counter()
    existing = sales_prospect_quote_repository.find_by_id(quote_id)
    find_quote_ms = round((time.perf_counter() - find_quote_started_at) * 1000, 1)
    if not existing or existing.get("prospectId") != access["prospect"].get("id"):
        raise _service_error("QUOTE_NOT_FOUND", 404)

    quote = existing
    mark_exported_ms = 0.0
    if quote.get("status") == QUOTE_STATUS_DRAFT:
        mark_exported_started_at = time.perf_counter()
        quote = sales_prospect_quote_repository.upsert(
            {
                **quote,
                "status": QUOTE_STATUS_EXPORTED,
                "exportedAt": _now(),
            }
        )
        mark_exported_ms = round((time.perf_counter() - mark_exported_started_at) * 1000, 1)

    enrich_started_at = time.perf_counter()
    quote_payload = quote.get("quotePayloadJson") if isinstance(quote.get("quotePayloadJson"), dict) else {}
    quote_payload_prospect = quote_payload.get("prospect") if isinstance(quote_payload.get("prospect"), dict) else {}
    enriched_quote = {
        **quote,
        "quotePayloadJson": {
            **quote_payload,
            "prospect": {
                **quote_payload_prospect,
                "identifier": _normalize_optional_text(quote_payload_prospect.get("identifier"))
                or _normalize_optional_text(access.get("identifier"))
                or _normalize_optional_text(access["prospect"].get("id")),
                "contactName": _normalize_optional_text(quote_payload_prospect.get("contactName"))
                or _normalize_optional_text(quote_payload_prospect.get("name"))
                or _normalize_optional_text(access["prospect"].get("contactName")),
                "contactEmail": _normalize_optional_text(quote_payload_prospect.get("contactEmail"))
                or _normalize_optional_text(access["prospect"].get("contactEmail")),
                "contactPhone": _normalize_optional_text(quote_payload_prospect.get("contactPhone"))
                or _normalize_optional_text(access["prospect"].get("contactPhone")),
            },
        },
    }
    enrich_ms = round((time.perf_counter() - enrich_started_at) * 1000, 1)

    generate_pdf_started_at = time.perf_counter()
    rendered = generate_prospect_quote_pdf(enriched_quote)
    generate_pdf_ms = round((time.perf_counter() - generate_pdf_started_at) * 1000, 1)
    return {
        "quote": _sanitize_quote_summary(quote),
        "pdf": rendered["pdf"],
        "filename": rendered["filename"],
        "diagnostics": {
            "totalMs": round((time.perf_counter() - started_at) * 1000, 1),
            "accessMs": access_ms,
            "findQuoteMs": find_quote_ms,
            "markExportedMs": mark_exported_ms,
            "enrichMs": enrich_ms,
            "pdfMs": generate_pdf_ms,
            "pdf": rendered.get("diagnostics") if isinstance(rendered.get("diagnostics"), dict) else None,
        },
    }


def delete_prospect_quote(
    *,
    identifier: str,
    quote_id: str,
    user: Dict,
    query: Optional[Dict] = None,
) -> Dict:
    access = _resolve_scoped_prospect_access(identifier=identifier, user=user, query=query, context="delete_prospect_quote")
    if not access.get("prospect"):
        raise _service_error("PROSPECT_NOT_FOUND", 404)

    existing = sales_prospect_quote_repository.find_by_id(quote_id)
    if not existing or existing.get("prospectId") != access["prospect"].get("id"):
        raise _service_error("QUOTE_NOT_FOUND", 404)

    sales_prospect_quote_repository.delete_by_id(str(existing.get("id")))
    return {
        "deleted": True,
        "quoteId": str(existing.get("id") or quote_id),
    }
