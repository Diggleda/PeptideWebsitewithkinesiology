from __future__ import annotations

import json
import re
from typing import Dict, Optional

import requests

CMS_NPI_REGISTRY_URL = "https://npiregistry.cms.hhs.gov/api/"
CMS_API_VERSION = "2.1"


class NpiError(Exception):
    """Base exception for NPI operations."""


class NpiInvalidError(NpiError):
    """Raised when the provided NPI number is malformed."""


class NpiNotFoundError(NpiError):
    """Raised when the CMS registry has no results for the given NPI."""


class NpiLookupError(NpiError):
    """Raised when the CMS registry cannot be reached or returns an unexpected error."""


def normalize_npi(value: Optional[str]) -> str:
    digits = re.sub(r"[^0-9]", "", str(value or ""))
    return digits[:10]


def _extract_primary_taxonomy(record: Dict) -> Optional[str]:
    taxonomies = record.get("taxonomies") or []
    if not isinstance(taxonomies, list) or not taxonomies:
        return None

    def describe(taxonomy: Dict) -> Optional[str]:
        for key in ("desc", "classification", "specialization"):
            value = taxonomy.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return None

    primary = next(
        (tax for tax in taxonomies if str(tax.get("primary", "")).lower() == "true"),
        taxonomies[0],
    )
    return describe(primary)


def _format_name(basic: Dict) -> Optional[str]:
    if not isinstance(basic, dict):
        return None

    direct_name = basic.get("name")
    if isinstance(direct_name, str) and direct_name.strip():
        return direct_name.strip()

    parts = [
        basic.get("first_name"),
        basic.get("middle_name"),
        basic.get("last_name"),
    ]
    parts = [part.strip() for part in parts if isinstance(part, str) and part.strip()]
    return " ".join(parts) if parts else None


def verify_npi(npi_number: str) -> Dict:
    normalized = normalize_npi(npi_number)
    if len(normalized) != 10:
        raise NpiInvalidError("NPI_INVALID")

    try:
        response = requests.get(
            CMS_NPI_REGISTRY_URL,
            params={"version": CMS_API_VERSION, "number": normalized},
            timeout=7,
        )
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as exc:
        raise NpiLookupError("NPI_LOOKUP_FAILED") from exc
    except ValueError as exc:
        raise NpiLookupError("NPI_LOOKUP_FAILED") from exc

    errors = payload.get("Errors")
    if errors:
        serialized = json.dumps(errors)
        if "No results" in serialized or "No Providers" in serialized:
            raise NpiNotFoundError("NPI_NOT_FOUND")
        if "Field number" in serialized or "number" in serialized.lower():
            raise NpiInvalidError("NPI_INVALID")
        raise NpiLookupError("NPI_LOOKUP_FAILED")

    results = payload.get("results") or []
    if not payload.get("result_count") or not results:
        raise NpiNotFoundError("NPI_NOT_FOUND")

    record = results[0]
    basic = record.get("basic") or {}

    return {
        "npiNumber": normalized,
        "name": _format_name(basic),
        "credential": basic.get("credential"),
        "enumerationType": basic.get("enumeration_type") or record.get("enumeration_type"),
        "organizationName": basic.get("organization_name"),
        "primaryTaxonomy": _extract_primary_taxonomy(record),
        "raw": record,
    }
