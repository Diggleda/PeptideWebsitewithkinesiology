from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from webauthn import (
    base64url_to_bytes,
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import bytes_to_base64url
from webauthn.helpers.structs import (
    AttestationConveyancePreference,
    AuthenticatorAttachment,
    AuthenticatorSelectionCriteria,
    AuthenticatorTransport,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from ..repositories import user_repository
from ..services import get_config
from . import auth_service

_DEFAULT_ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}

_registration_challenges: Dict[str, Dict[str, Any]] = {}
_authentication_challenges: Dict[str, Dict[str, Any]] = {}


def generate_registration_options_for_user(
    user_id: str,
    *,
    origin: Optional[str],
    rp_id: Optional[str],
) -> Dict[str, Any]:
    user = user_repository.find_by_id(user_id)
    if not user:
        raise _error("USER_NOT_FOUND", 404)

    rp_id_value = _resolve_rp_id(rp_id)
    options = generate_registration_options(
        rp_id=rp_id_value,
        rp_name=_rp_name(),
        user_name=user.get("email") or user.get("name") or "PepPro User",
        user_id=str(user.get("id") or "").encode("utf-8"),
        user_display_name=user.get("name") or user.get("email") or "PepPro User",
        attestation=AttestationConveyancePreference.NONE,
        authenticator_selection=AuthenticatorSelectionCriteria(
            authenticator_attachment=AuthenticatorAttachment.PLATFORM,
            resident_key=ResidentKeyRequirement.PREFERRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
        exclude_credentials=_passkey_descriptors(user.get("passkeys") or []),
    )

    request_id = _random_id()
    _registration_challenges[request_id] = {
        "challenge": bytes_to_base64url(options.challenge),
        "userId": user.get("id"),
        "origin": origin,
        "rpId": rp_id_value,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    public_key = _options_to_dict(options)
    public_key.setdefault("excludeCredentials", [])

    return {
        "requestId": request_id,
        "publicKey": public_key,
    }


def verify_registration_response_for_user(
    payload: Dict[str, Any],
    user_id: str,
    *,
    origin: Optional[str],
    rp_id: Optional[str],
) -> Dict[str, Any]:
    request_id = (payload.get("requestId") or "").strip()
    pending = _registration_challenges.pop(request_id, None)
    if not pending or pending.get("userId") != user_id:
        raise _error("PASSKEY_CHALLENGE_NOT_FOUND", 400)

    attestation = payload.get("attestationResponse") or {}
    label = (payload.get("label") or "").strip() or None

    expected_origin = _expected_origin(pending.get("origin"), origin)
    expected_rp_id = pending.get("rpId") or _resolve_rp_id(rp_id)

    verification = verify_registration_response(
        credential=attestation,
        expected_challenge=base64url_to_bytes(pending["challenge"]),
        expected_origin=expected_origin,
        expected_rp_id=expected_rp_id,
        require_user_verification=True,
    )

    user = user_repository.find_by_id(user_id)
    if not user:
        raise _error("USER_NOT_FOUND", 404)

    new_passkey = {
        "credentialID": bytes_to_base64url(verification.credential_id),
        "publicKey": bytes_to_base64url(verification.credential_public_key),
        "counter": verification.sign_count,
        "transports": _transports_from_attestation(attestation),
        "deviceType": getattr(verification.credential_device_type, "value", None),
        "backedUp": bool(verification.credential_backed_up),
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "label": label,
    }

    existing = user.get("passkeys") or []
    if any(pk.get("credentialID") == new_passkey["credentialID"] for pk in existing if isinstance(pk, dict)):
        raise _error("PASSKEY_ALREADY_REGISTERED", 409)

    next_passkeys = existing + [new_passkey]
    updated = user_repository.update({**user, "passkeys": next_passkeys}) or {**user, "passkeys": next_passkeys}

    return {
        "verified": True,
        "user": auth_service._sanitize_user(updated),  # pylint: disable=protected-access
    }


def generate_authentication_options_for_user(
    email: Optional[str],
    *,
    origin: Optional[str],
    rp_id: Optional[str],
) -> Dict[str, Any]:
    user = None
    passkeys: List[Dict[str, Any]] = []

    if email:
        user = user_repository.find_by_email(email)
        if not user:
            raise _error("EMAIL_NOT_FOUND", 404)
        passkeys = user.get("passkeys") or []
        if not passkeys:
            raise _error("PASSKEY_NOT_REGISTERED", 404)

    rp_id_value = _resolve_rp_id(rp_id)

    options = generate_authentication_options(
        rp_id=rp_id_value,
        user_verification=UserVerificationRequirement.REQUIRED,
        allow_credentials=_passkey_descriptors(passkeys),
    )

    request_id = _random_id()
    _authentication_challenges[request_id] = {
        "challenge": bytes_to_base64url(options.challenge),
        "origin": origin,
        "rpId": rp_id_value,
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }

    public_key = _options_to_dict(options)
    public_key.setdefault("allowCredentials", [])

    return {
        "requestId": request_id,
        "publicKey": public_key,
    }


def verify_authentication_response_for_user(
    payload: Dict[str, Any],
    *,
    origin: Optional[str],
    rp_id: Optional[str],
) -> Dict[str, Any]:
    request_id = (payload.get("requestId") or "").strip()
    pending = _authentication_challenges.pop(request_id, None)
    if not pending:
        raise _error("PASSKEY_CHALLENGE_NOT_FOUND", 400)

    assertion = payload.get("assertionResponse") or {}
    credential_id = (assertion.get("id") or "").strip()
    if not credential_id:
        raise _error("PASSKEY_ID_REQUIRED", 400)

    user = user_repository.find_by_passkey_id(credential_id)
    if not user:
        raise _error("PASSKEY_NOT_FOUND", 404)

    passkeys = user.get("passkeys") or []
    entry = next((pk for pk in passkeys if pk.get("credentialID") == credential_id), None)
    if not entry:
        raise _error("PASSKEY_NOT_FOUND", 404)
    public_key_b64 = entry.get("publicKey")
    if not public_key_b64:
        raise _error("PASSKEY_PUBLIC_KEY_MISSING", 400)

    expected_origin = _expected_origin(pending.get("origin"), origin)
    expected_rp_id = pending.get("rpId") or _resolve_rp_id(rp_id)

    verification = verify_authentication_response(
        credential=assertion,
        expected_challenge=base64url_to_bytes(pending["challenge"]),
        expected_origin=expected_origin,
        expected_rp_id=expected_rp_id,
        credential_public_key=base64url_to_bytes(public_key_b64),
        credential_current_sign_count=int(entry.get("counter") or 0),
        require_user_verification=True,
    )

    updated_passkeys: List[Dict[str, Any]] = []
    for pk in passkeys:
        if pk.get("credentialID") == credential_id:
            updated = {
                **pk,
                "counter": verification.new_sign_count,
                "deviceType": getattr(verification.credential_device_type, "value", pk.get("deviceType")),
                "backedUp": bool(verification.credential_backed_up),
                "lastUsedAt": datetime.now(timezone.utc).isoformat(),
            }
            updated_passkeys.append(updated)
        else:
            updated_passkeys.append(pk)

    updated_user = user_repository.update({**user, "passkeys": updated_passkeys}) or {
        **user,
        "passkeys": updated_passkeys,
    }

    token = auth_service._create_auth_token({"id": updated_user["id"], "email": updated_user["email"]})  # pylint: disable=protected-access

    return {
        "token": token,
        "user": auth_service._sanitize_user(updated_user),  # pylint: disable=protected-access
    }


def _passkey_descriptors(passkeys: List[Dict[str, Any]]) -> List[PublicKeyCredentialDescriptor]:
    descriptors: List[PublicKeyCredentialDescriptor] = []
    for entry in passkeys:
        credential_id = (entry.get("credentialID") or "").strip()
        if not credential_id:
            continue
        transports = entry.get("transports") or []
        transports_enum: Optional[List[AuthenticatorTransport]] = None
        if isinstance(transports, list) and transports:
            transports_enum = []
            for transport in transports:
                try:
                    transports_enum.append(AuthenticatorTransport(transport))
                except ValueError:
                    continue
        descriptors.append(
            PublicKeyCredentialDescriptor(
                type="public-key",
                id=base64url_to_bytes(credential_id),
                transports=transports_enum,
            )
        )
    return descriptors


def _transports_from_attestation(attestation: Dict[str, Any]) -> List[str]:
    transports = attestation.get("response", {}).get("transports")
    if isinstance(transports, list):
        return [t for t in transports if isinstance(t, str) and t]
    hinted = attestation.get("transports")
    if isinstance(hinted, list):
        return [t for t in hinted if isinstance(t, str) and t]
    return []


def _options_to_dict(options) -> Dict[str, Any]:
    return json.loads(options_to_json(options))


def _resolve_rp_id(rp_id_hint: Optional[str]) -> str:
    candidate = (rp_id_hint or "").strip().lower()
    config = get_config()
    configured = (config.passkeys.get("rp_id") or "").strip().lower()

    if configured:
        if not candidate:
            return configured
        if candidate == configured or candidate.endswith(f".{configured}"):
            return configured
    if candidate:
        return candidate
    if configured:
        return configured
    return "localhost"


def _rp_name() -> str:
    config = get_config()
    return (config.passkeys.get("rp_name") or "PepPro").strip() or "PepPro"


def _expected_origin(pending_origin: Optional[str], request_origin: Optional[str]) -> List[str]:
    origins = set(_DEFAULT_ALLOWED_ORIGINS)
    config = get_config()
    configured = config.passkeys.get("allowed_origins") or []
    origins.update([value.strip() for value in configured if value])
    if pending_origin:
        origins.add(pending_origin)
    if request_origin:
        origins.add(request_origin)
    cleaned = [origin for origin in origins if origin]
    if not cleaned:
        cleaned = ["http://localhost:5173"]
    return cleaned


def _random_id() -> str:
    return secrets.token_urlsafe(24)


def _error(message: str, status: int) -> Exception:
    err = ValueError(message)
    setattr(err, "status", status)
    return err
