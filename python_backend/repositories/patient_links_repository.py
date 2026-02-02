from __future__ import annotations

import json
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from ..database import mysql_client
from ..services import get_config

TTL_HOURS = 72


def _using_mysql() -> bool:
    return bool(get_config().mysql.get("enabled"))


def _fmt_datetime(value: Any) -> Optional[str]:
    if not value:
        return None
    if isinstance(value, datetime):
        dt = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
        return dt.isoformat()
    return str(value)


def _serialize_json(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value)


def delete_expired() -> int:
    if not _using_mysql():
        return 0
    try:
        return int(
            mysql_client.execute(
                "DELETE FROM patient_links WHERE expires_at <= UTC_TIMESTAMP()",
            )
            or 0
        )
    except Exception:
        return 0


def create_link(doctor_id: str, *, label: Optional[str] = None) -> Dict[str, Any]:
    if not _using_mysql():
        raise RuntimeError("MySQL backend is required for patient links")
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        raise ValueError("doctor_id is required")

    label_value = str(label).strip() if isinstance(label, str) and str(label).strip() else None
    delete_expired()

    # Default markup is derived from the most-recent active link for this doctor.
    markup_percent = 0.0
    try:
        row = mysql_client.fetch_one(
            """
            SELECT markup_percent
            FROM patient_links
            WHERE doctor_id = %(doctor_id)s
              AND expires_at > UTC_TIMESTAMP()
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"doctor_id": doctor_id},
        )
        if row and row.get("markup_percent") is not None:
            markup_percent = float(row.get("markup_percent") or 0.0)
    except Exception:
        markup_percent = 0.0

    # Keep token URL-safe; collisions are extremely unlikely, but retry once on PK conflict.
    for attempt in range(2):
        token = secrets.token_urlsafe(24)
        now = datetime.now(timezone.utc)
        expires = now + timedelta(hours=TTL_HOURS)
        params = {
            "token": token,
            "doctor_id": doctor_id,
            "label": label_value,
            "created_at": now.replace(tzinfo=None),
            "expires_at": expires.replace(tzinfo=None),
            "markup_percent": float(markup_percent or 0.0),
        }
        try:
            mysql_client.execute(
                """
                INSERT INTO patient_links (token, doctor_id, label, created_at, expires_at, markup_percent)
                VALUES (%(token)s, %(doctor_id)s, %(label)s, %(created_at)s, %(expires_at)s, %(markup_percent)s)
                """,
                params,
            )
            return {
                "token": token,
                "label": label_value,
                "createdAt": now.isoformat(),
                "expiresAt": expires.isoformat(),
                "markupPercent": float(markup_percent or 0.0),
                "lastUsedAt": None,
                "revokedAt": None,
            }
        except Exception:
            if attempt >= 1:
                raise
            continue

    raise RuntimeError("Unable to create patient link")


def list_links(doctor_id: str) -> List[Dict[str, Any]]:
    if not _using_mysql():
        return []
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return []
    delete_expired()
    rows = mysql_client.fetch_all(
        """
        SELECT token, label, created_at, expires_at, markup_percent, last_used_at, revoked_at
        FROM patient_links
        WHERE doctor_id = %(doctor_id)s
          AND expires_at > UTC_TIMESTAMP()
        ORDER BY created_at DESC
        """,
        {"doctor_id": doctor_id},
    )
    results: List[Dict[str, Any]] = []
    for row in rows or []:
        results.append(
            {
                "token": row.get("token"),
                "label": row.get("label"),
                "createdAt": _fmt_datetime(row.get("created_at")),
                "expiresAt": _fmt_datetime(row.get("expires_at")),
                "markupPercent": float(row.get("markup_percent") or 0.0),
                "lastUsedAt": _fmt_datetime(row.get("last_used_at")),
                "revokedAt": _fmt_datetime(row.get("revoked_at")),
            }
        )
    return results


def find_by_token(token: str) -> Optional[Dict[str, Any]]:
    if not _using_mysql():
        return None
    token = str(token or "").strip()
    if not token:
        return None
    delete_expired()
    row = mysql_client.fetch_one(
        """
        SELECT token, doctor_id, label, created_at, expires_at, last_used_at, revoked_at,
               markup_percent,
               delegate_cart_json, delegate_shipping_json, delegate_payment_json,
               delegate_shared_at, delegate_order_id
        FROM patient_links
        WHERE token = %(token)s
          AND expires_at > UTC_TIMESTAMP()
        """,
        {"token": token},
    )
    if not row:
        return None

    def _parse_json(value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, (dict, list)):
            return value
        if isinstance(value, (bytes, bytearray)):
            try:
                value = value.decode("utf-8")
            except Exception:
                return None
        if isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            try:
                return json.loads(text)
            except Exception:
                return None
        return None

    return {
        "token": row.get("token"),
        "doctorId": row.get("doctor_id"),
        "label": row.get("label"),
        "createdAt": _fmt_datetime(row.get("created_at")),
        "expiresAt": _fmt_datetime(row.get("expires_at")),
        "markupPercent": float(row.get("markup_percent") or 0.0),
        "lastUsedAt": _fmt_datetime(row.get("last_used_at")),
        "revokedAt": _fmt_datetime(row.get("revoked_at")),
        "delegateCart": _parse_json(row.get("delegate_cart_json")),
        "delegateShipping": _parse_json(row.get("delegate_shipping_json")),
        "delegatePayment": _parse_json(row.get("delegate_payment_json")),
        "delegateSharedAt": _fmt_datetime(row.get("delegate_shared_at")),
        "delegateOrderId": row.get("delegate_order_id"),
    }


def touch_last_used(token: str) -> None:
    if not _using_mysql():
        return
    token = str(token or "").strip()
    if not token:
        return
    try:
        mysql_client.execute(
            "UPDATE patient_links SET last_used_at = UTC_TIMESTAMP() WHERE token = %(token)s",
            {"token": token},
        )
    except Exception:
        return


def update_link(
    doctor_id: str,
    token: str,
    *,
    label: Optional[str] = None,
    revoke: Optional[bool] = None,
) -> Optional[Dict[str, Any]]:
    if not _using_mysql():
        return None
    doctor_id = str(doctor_id or "").strip()
    token = str(token or "").strip()
    if not doctor_id or not token:
        return None

    updates: list[str] = []
    params: Dict[str, Any] = {"doctor_id": doctor_id, "token": token}

    if label is not None:
        label_value = str(label).strip() if isinstance(label, str) and str(label).strip() else None
        updates.append("label = %(label)s")
        params["label"] = label_value

    if revoke is True:
        updates.append("revoked_at = COALESCE(revoked_at, UTC_TIMESTAMP())")
    elif revoke is False:
        updates.append("revoked_at = NULL")

    if updates:
        delete_expired()
        mysql_client.execute(
            f"""
            UPDATE patient_links
            SET {", ".join(updates)}
            WHERE token = %(token)s
              AND doctor_id = %(doctor_id)s
              AND expires_at > UTC_TIMESTAMP()
            """,
            params,
        )

    row = mysql_client.fetch_one(
        """
        SELECT token, label, created_at, expires_at, markup_percent, last_used_at, revoked_at
        FROM patient_links
        WHERE token = %(token)s
          AND doctor_id = %(doctor_id)s
          AND expires_at > UTC_TIMESTAMP()
        """,
        {"token": token, "doctor_id": doctor_id},
    )
    if not row:
        return None
    return {
        "token": row.get("token"),
        "label": row.get("label"),
        "createdAt": _fmt_datetime(row.get("created_at")),
        "expiresAt": _fmt_datetime(row.get("expires_at")),
        "markupPercent": float(row.get("markup_percent") or 0.0),
        "lastUsedAt": _fmt_datetime(row.get("last_used_at")),
        "revokedAt": _fmt_datetime(row.get("revoked_at")),
    }


def get_doctor_markup_percent(doctor_id: str) -> float:
    if not _using_mysql():
        return 0.0
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return 0.0
    delete_expired()
    try:
        row = mysql_client.fetch_one(
            """
            SELECT markup_percent
            FROM patient_links
            WHERE doctor_id = %(doctor_id)s
              AND expires_at > UTC_TIMESTAMP()
            ORDER BY created_at DESC
            LIMIT 1
            """,
            {"doctor_id": doctor_id},
        )
        return float((row or {}).get("markup_percent") or 0.0)
    except Exception:
        return 0.0


def set_doctor_markup_percent(doctor_id: str, markup_percent: float) -> int:
    if not _using_mysql():
        return 0
    doctor_id = str(doctor_id or "").strip()
    if not doctor_id:
        return 0
    delete_expired()
    try:
        return int(
            mysql_client.execute(
                """
                UPDATE patient_links
                SET markup_percent = %(markup_percent)s
                WHERE doctor_id = %(doctor_id)s
                  AND expires_at > UTC_TIMESTAMP()
                """,
                {"doctor_id": doctor_id, "markup_percent": float(markup_percent or 0.0)},
            )
            or 0
        )
    except Exception:
        return 0


def store_delegate_payload(
    token: str,
    *,
    cart: Any,
    shipping: Any,
    payment: Any,
    order_id: Optional[str] = None,
    shared_at: Optional[datetime] = None,
) -> bool:
    if not _using_mysql():
        return False
    token = str(token or "").strip()
    if not token:
        return False
    delete_expired()
    when = shared_at.astimezone(timezone.utc) if isinstance(shared_at, datetime) else datetime.now(timezone.utc)
    try:
        affected = mysql_client.execute(
            """
            UPDATE patient_links
            SET
                delegate_cart_json = %(cart)s,
                delegate_shipping_json = %(shipping)s,
                delegate_payment_json = %(payment)s,
                delegate_shared_at = %(shared_at)s,
                delegate_order_id = COALESCE(%(order_id)s, delegate_order_id),
                last_used_at = UTC_TIMESTAMP()
            WHERE token = %(token)s
              AND expires_at > UTC_TIMESTAMP()
            """,
            {
                "token": token,
                "cart": _serialize_json(cart),
                "shipping": _serialize_json(shipping),
                "payment": _serialize_json(payment),
                "shared_at": when.replace(tzinfo=None),
                "order_id": str(order_id).strip() if order_id is not None and str(order_id).strip() else None,
            },
        )
        return int(affected or 0) > 0
    except Exception:
        return False
