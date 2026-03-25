from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Tuple

import pymysql

from .. import storage
from ..database import mysql_client
from ..repositories import user_repository
from ..utils.crypto_envelope import decrypt_json, encrypt_json
from . import get_config


logger = logging.getLogger(__name__)

DELETED_USER_ID = "0000000000000"
DELETED_USER_NAME = "Deleted User"
_IGNORED_MYSQL_CODES = {1051, 1054, 1146}


def _normalize_id(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _replace_id_deep(value: Any, target_id: str, replacement_id: str) -> Tuple[Any, bool]:
    if isinstance(value, list):
        changed = False
        next_list = []
        for entry in value:
            replaced, entry_changed = _replace_id_deep(entry, target_id, replacement_id)
            changed = changed or entry_changed
            next_list.append(replaced)
        return (next_list, True) if changed else (value, False)

    if isinstance(value, dict):
        changed = False
        next_dict: Dict[str, Any] = {}
        for key, entry in value.items():
            replaced, entry_changed = _replace_id_deep(entry, target_id, replacement_id)
            next_key = key.replace(target_id, replacement_id) if isinstance(key, str) and target_id in key else key
            changed = changed or entry_changed or next_key != key
            next_dict[next_key] = replaced
        return (next_dict, True) if changed else (value, False)

    if isinstance(value, str):
        if target_id not in value:
            return value, False
        return value.replace(target_id, replacement_id), True

    if isinstance(value, (int, float)) and str(value) == target_id:
        return replacement_id, True

    return value, False


def _rewrite_store_references(store, label: str, target_id: str, replacement_id: str) -> Dict[str, Any]:
    if store is None:
        return {"label": label, "changed": False, "skipped": True}
    current = store.read()
    updated, changed = _replace_id_deep(current, target_id, replacement_id)
    if changed:
        store.write(updated)
    return {"label": label, "changed": bool(changed)}


def _execute_mysql(query: str, params: Dict[str, Any], label: str) -> Dict[str, Any]:
    try:
        affected = mysql_client.execute(query, params)
        return {"label": label, "ok": True, "affectedRows": int(affected or 0)}
    except pymysql.MySQLError as exc:
        code = exc.args[0] if exc.args else None
        if isinstance(code, int) and code in _IGNORED_MYSQL_CODES:
            return {"label": label, "ok": True, "affectedRows": 0, "ignored": True}
        raise


def _parse_json_value(value: Any) -> Any:
    if value in (None, ""):
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, (bytes, bytearray)):
        try:
            value = value.decode("utf-8")
        except Exception:
            return None
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def _candidate_aads(row: Dict[str, Any], *, table_name: str, field_name: str, record_ref_fields: List[str]) -> List[Dict[str, str]]:
    candidates: List[Dict[str, str]] = []
    seen: set[str] = set()
    for key in [*record_ref_fields, "id"]:
        ref = str(row.get(key) or "").strip() or "pending"
        if ref in seen:
            continue
        seen.add(ref)
        candidates.append({"table": table_name, "record_ref": ref, "field": field_name})
    if not candidates:
        candidates.append({"table": table_name, "record_ref": "pending", "field": field_name})
    return candidates


def _read_mysql_json_field(
    row: Dict[str, Any],
    *,
    table_name: str,
    field_name: str,
    legacy_fields: List[str] | None = None,
    record_ref_fields: List[str] | None = None,
) -> tuple[Any, Dict[str, str]]:
    legacy_fields = legacy_fields or []
    record_ref_fields = record_ref_fields or []
    aads = _candidate_aads(
        row,
        table_name=table_name,
        field_name=field_name,
        record_ref_fields=record_ref_fields,
    )

    field_values = [row.get(field_name)]
    field_values.extend(row.get(field) for field in legacy_fields)
    for value in field_values:
        for aad in aads:
            try:
                decoded = decrypt_json(value, aad=aad)
            except Exception:
                decoded = None
            if decoded is not None:
                return decoded, aad
        try:
            decoded = decrypt_json(value)
        except Exception:
            decoded = None
        if decoded is not None:
            return decoded, aads[0]
        decoded = _parse_json_value(value)
        if decoded is not None:
            return decoded, aads[0]

    return None, aads[0]


def _rewrite_mysql_json_field(
    *,
    table_name: str,
    field_name: str,
    label: str,
    target_id: str,
    replacement_id: str,
    legacy_fields: List[str] | None = None,
    record_ref_fields: List[str] | None = None,
) -> Dict[str, Any]:
    try:
        rows = mysql_client.fetch_all(f"SELECT * FROM {table_name}")
    except pymysql.MySQLError as exc:
        code = exc.args[0] if exc.args else None
        if isinstance(code, int) and code in _IGNORED_MYSQL_CODES:
            return {"label": label, "ok": True, "affectedRows": 0, "ignored": True}
        raise

    affected = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_id = _normalize_id(row.get("id"))
        if not row_id:
            continue
        decoded, aad = _read_mysql_json_field(
            row,
            table_name=table_name,
            field_name=field_name,
            legacy_fields=legacy_fields,
            record_ref_fields=record_ref_fields,
        )
        if decoded is None:
            continue
        updated, changed = _replace_id_deep(decoded, target_id, replacement_id)
        if not changed:
            continue
        mysql_client.execute(
            f"UPDATE {table_name} SET {field_name} = %(value)s WHERE id = %(id)s",
            {
                "id": row_id,
                "value": encrypt_json(updated, aad=aad),
            },
        )
        affected += 1

    return {"label": label, "ok": True, "affectedRows": affected}


def _rewrite_mysql_references(target_id: str, replacement_id: str) -> List[Dict[str, Any]]:
    if not bool(get_config().mysql.get("enabled")):
        return []

    statements = [
        (
            "orders.user_id",
            "UPDATE orders SET user_id = %(replacement_id)s WHERE user_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "peppro_orders.user_id",
            "UPDATE peppro_orders SET user_id = %(replacement_id)s WHERE user_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "referrals.referrer_doctor_id",
            "UPDATE referrals SET referrer_doctor_id = %(replacement_id)s WHERE referrer_doctor_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "referrals.sales_rep_id",
            "UPDATE referrals SET sales_rep_id = %(replacement_id)s WHERE sales_rep_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "referrals.converted_doctor_id",
            "UPDATE referrals SET converted_doctor_id = %(replacement_id)s WHERE converted_doctor_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "referral_codes.doctor_id",
            "UPDATE referral_codes SET doctor_id = %(replacement_id)s WHERE doctor_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "referral_codes.referrer_doctor_id",
            "UPDATE referral_codes SET referrer_doctor_id = %(replacement_id)s WHERE referrer_doctor_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "referral_codes.sales_rep_id",
            "UPDATE referral_codes SET sales_rep_id = %(replacement_id)s WHERE sales_rep_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "sales_prospects.doctor_id",
            "UPDATE sales_prospects SET doctor_id = %(replacement_id)s WHERE doctor_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "sales_prospects.id",
            "UPDATE sales_prospects SET id = REPLACE(id, %(target_id)s, %(replacement_id)s) WHERE id LIKE %(needle)s",
            params_base,
        ),
        (
            "sales_prospects.sales_rep_id",
            "UPDATE sales_prospects SET sales_rep_id = %(replacement_id)s WHERE sales_rep_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "credit_ledger.doctor_id",
            "UPDATE credit_ledger SET doctor_id = %(replacement_id)s WHERE doctor_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "credit_ledger.sales_rep_id",
            "UPDATE credit_ledger SET sales_rep_id = %(replacement_id)s WHERE sales_rep_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "patient_links.doctor_id",
            "UPDATE patient_links SET doctor_id = %(replacement_id)s WHERE doctor_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "sales_reps.legacy_user_id",
            "UPDATE sales_reps SET legacy_user_id = %(replacement_id)s WHERE legacy_user_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "password_reset_tokens.account_id",
            "DELETE FROM password_reset_tokens WHERE account_id = %(target_id)s",
            {"target_id": target_id},
        ),
        (
            "users.id",
            "DELETE FROM users WHERE id = %(target_id)s",
            {"target_id": target_id},
        ),
    ]

    results: List[Dict[str, Any]] = []
    for label, query, params in statements:
        results.append(_execute_mysql(query, params, label))
        if label == "orders.user_id":
            results.append(
                _rewrite_mysql_json_field(
                    table_name="orders",
                    field_name="payload",
                    label="orders.payload",
                    target_id=target_id,
                    replacement_id=replacement_id,
                )
            )
            results.append(
                _rewrite_mysql_json_field(
                    table_name="orders",
                    field_name="shipping_address",
                    label="orders.shipping_address",
                    target_id=target_id,
                    replacement_id=replacement_id,
                )
            )
        if label == "peppro_orders.user_id":
            results.append(
                _rewrite_mysql_json_field(
                    table_name="peppro_orders",
                    field_name="payload",
                    label="peppro_orders.payload",
                    target_id=target_id,
                    replacement_id=replacement_id,
                    legacy_fields=["payload_encrypted"],
                    record_ref_fields=["phi_payload_ref"],
                )
            )
    return results


def delete_account_and_rewrite_references(
    *,
    user_id: str,
    replacement_user_id: str = DELETED_USER_ID,
) -> Dict[str, Any]:
    target_id = _normalize_id(user_id)
    replacement_id = _normalize_id(replacement_user_id) or DELETED_USER_ID

    if not target_id:
        err = ValueError("USER_ID_REQUIRED")
        setattr(err, "status", 400)
        raise err
    if target_id == replacement_id:
        err = ValueError("INVALID_DELETE_TARGET")
        setattr(err, "status", 400)
        raise err

    existing = user_repository.find_by_id(target_id)
    if not existing:
        err = ValueError("USER_NOT_FOUND")
        setattr(err, "status", 404)
        raise err

    local_rewrites = [
        _rewrite_store_references(storage.order_store, "orders.json", target_id, replacement_id),
        _rewrite_store_references(storage.referral_store, "referrals.json", target_id, replacement_id),
        _rewrite_store_references(storage.referral_code_store, "referral-codes.json", target_id, replacement_id),
        _rewrite_store_references(storage.sales_rep_store, "sales-reps.json", target_id, replacement_id),
        _rewrite_store_references(storage.sales_prospect_store, "sales-prospects.json", target_id, replacement_id),
        _rewrite_store_references(storage.credit_ledger_store, "credit-ledger.json", target_id, replacement_id),
        _rewrite_store_references(storage.peptide_forum_store, "the-peptide-forum.json", target_id, replacement_id),
    ]

    user_repository.remove_by_id(target_id)
    mysql_results = _rewrite_mysql_references(target_id, replacement_id)

    logger.info(
        "Account deleted and references rewritten",
        extra={
            "deletedUserId": target_id,
            "replacementUserId": replacement_id,
            "localRewrites": local_rewrites,
            "mysqlResults": mysql_results,
        },
    )

    return {
        "deletedUserId": target_id,
        "replacementUserId": replacement_id,
        "localRewrites": local_rewrites,
        "mysqlResults": mysql_results,
    }
