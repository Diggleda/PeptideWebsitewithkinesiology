from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

import pymysql

from .. import storage
from ..database import mysql_client
from ..repositories import user_repository
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


def _rewrite_mysql_references(target_id: str, replacement_id: str) -> List[Dict[str, Any]]:
    if not bool(get_config().mysql.get("enabled")):
        return []

    params_base = {"target_id": target_id, "replacement_id": replacement_id, "needle": f"%{target_id}%"}
    statements = [
        (
            "orders.user_id",
            "UPDATE orders SET user_id = %(replacement_id)s WHERE user_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "orders.payload",
            "UPDATE orders SET payload = REPLACE(payload, %(target_id)s, %(replacement_id)s) WHERE payload LIKE %(needle)s",
            params_base,
        ),
        (
            "orders.shipping_address",
            "UPDATE orders SET shipping_address = REPLACE(shipping_address, %(target_id)s, %(replacement_id)s) WHERE shipping_address LIKE %(needle)s",
            params_base,
        ),
        (
            "peppro_orders.user_id",
            "UPDATE peppro_orders SET user_id = %(replacement_id)s WHERE user_id = %(target_id)s",
            {"target_id": target_id, "replacement_id": replacement_id},
        ),
        (
            "peppro_orders.payload",
            "UPDATE peppro_orders SET payload = REPLACE(payload, %(target_id)s, %(replacement_id)s) WHERE payload LIKE %(needle)s",
            params_base,
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
