from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
from typing import Any, Callable, Dict, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..services import get_config

ENVELOPE_VERSION = 1
ENVELOPE_ALGORITHM = "aes-256-gcm"


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _derive_key(secret: str) -> bytes:
    raw = str(secret or "").strip()
    if not raw:
        raise RuntimeError("DATA_ENCRYPTION_KEY is required for encrypted data access")
    try:
        decoded = base64.b64decode(raw, validate=True)
        if len(decoded) == 32:
            return decoded
    except Exception:
        pass
    return hashlib.sha256(raw.encode("utf-8")).digest()


def _master_key() -> bytes:
    config = get_config()
    key = str((config.encryption or {}).get("key") or "").strip()
    return _derive_key(key)


def _blind_index_key() -> bytes:
    config = get_config()
    configured = str((config.encryption or {}).get("blind_index_key") or "").strip()
    if configured:
        return _derive_key(configured)
    return _master_key()


def _key_version() -> str:
    config = get_config()
    return str((config.encryption or {}).get("key_version") or "local-v1").strip() or "local-v1"


def _kms_key_id() -> Optional[str]:
    config = get_config()
    value = str((config.encryption or {}).get("kms_key_id") or "").strip()
    return value or None


def _canonical_aad(aad: Optional[Dict[str, Any]]) -> bytes:
    if not aad:
        return b""
    return _stable_json(aad).encode("utf-8")


def _wrap_data_key(data_key: bytes) -> Dict[str, str]:
    wrapper = AESGCM(_master_key())
    iv = os.urandom(12)
    aad = _canonical_aad(
        {
            "purpose": "wrapped_data_key",
            "key_version": _key_version(),
            "kms_key_id": _kms_key_id(),
        }
    )
    wrapped = wrapper.encrypt(iv, data_key, aad)
    return {
        "alg": ENVELOPE_ALGORITHM,
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertext": base64.b64encode(wrapped).decode("ascii"),
    }


def _unwrap_data_key(wrapped_data_key: Any) -> bytes:
    if not isinstance(wrapped_data_key, dict):
        raise ValueError("wrapped_data_key must be an object")
    iv = base64.b64decode(str(wrapped_data_key.get("iv") or ""))
    ciphertext = base64.b64decode(str(wrapped_data_key.get("ciphertext") or ""))
    wrapper = AESGCM(_master_key())
    aad = _canonical_aad(
        {
            "purpose": "wrapped_data_key",
            "key_version": _key_version(),
            "kms_key_id": _kms_key_id(),
        }
    )
    return wrapper.decrypt(iv, ciphertext, aad)


def compute_blind_index(
    value: Any,
    *,
    label: str,
    normalizer: Optional[Callable[[str], str]] = None,
) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    normalized = normalizer(text) if callable(normalizer) else text
    digest = hmac.new(
        _blind_index_key(),
        f"{label}:{normalized}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return digest


def encrypt_text(
    value: Any,
    *,
    aad: Optional[Dict[str, Any]] = None,
    blind_index: Optional[str] = None,
) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    if not text:
        return None
    data_key = os.urandom(32)
    cipher = AESGCM(data_key)
    iv = os.urandom(12)
    ciphertext = cipher.encrypt(iv, text.encode("utf-8"), _canonical_aad(aad))
    envelope = {
        "version": ENVELOPE_VERSION,
        "alg": ENVELOPE_ALGORITHM,
        "kms_key_id": _kms_key_id(),
        "key_version": _key_version(),
        "wrapped_data_key": _wrap_data_key(data_key),
        "iv": base64.b64encode(iv).decode("ascii"),
        "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
        "aad": aad or {},
    }
    if blind_index:
        envelope["blind_index"] = blind_index
    return json.dumps(envelope, separators=(",", ":"), ensure_ascii=False)


def decrypt_text(value: Any, *, aad: Optional[Dict[str, Any]] = None) -> Optional[str]:
    if value is None:
        return None
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
        payload = json.loads(text)
    except Exception:
        return text
    if not isinstance(payload, dict):
        return text

    if payload.get("version") == ENVELOPE_VERSION and payload.get("wrapped_data_key"):
        data_key = _unwrap_data_key(payload.get("wrapped_data_key"))
        cipher = AESGCM(data_key)
        iv = base64.b64decode(str(payload.get("iv") or ""))
        ciphertext = base64.b64decode(str(payload.get("ciphertext") or ""))
        plaintext = cipher.decrypt(iv, ciphertext, _canonical_aad(aad or payload.get("aad") or {}))
        return plaintext.decode("utf-8")

    if "iv" in payload and "payload" in payload:
        legacy_key = _master_key()
        cipher = AESGCM(legacy_key)
        iv = base64.b64decode(payload["iv"])
        ciphertext = base64.b64decode(payload["payload"])
        plaintext = cipher.decrypt(iv, ciphertext, None)
        return plaintext.decode("utf-8")

    return text


def encrypt_json(
    value: Any,
    *,
    aad: Optional[Dict[str, Any]] = None,
    blind_index: Optional[str] = None,
) -> Optional[str]:
    if value is None:
        return None
    return encrypt_text(_stable_json(value), aad=aad, blind_index=blind_index)


def decrypt_json(value: Any, *, aad: Optional[Dict[str, Any]] = None) -> Any:
    text = decrypt_text(value, aad=aad)
    if text is None:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None
