from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse
from unittest.mock import ANY, patch

sys.modules.setdefault("bcrypt", types.SimpleNamespace())
sys.modules.setdefault("jwt", types.SimpleNamespace())
fake_requests = types.ModuleType("requests")
fake_requests_auth = types.ModuleType("requests.auth")


class _FakeRequestException(Exception):
    pass


class _FakeTimeout(_FakeRequestException):
    pass


class _FakeHTTPBasicAuth:
    def __init__(self, *args, **kwargs):
        pass


fake_requests.RequestException = _FakeRequestException
fake_requests.Timeout = _FakeTimeout
fake_requests_auth.HTTPBasicAuth = _FakeHTTPBasicAuth
fake_requests.auth = fake_requests_auth
sys.modules.setdefault("requests", fake_requests)
sys.modules.setdefault("requests.auth", fake_requests_auth)
fake_pymysql = types.ModuleType("pymysql")
fake_pymysql.connect = lambda *args, **kwargs: None
fake_pymysql.connections = types.SimpleNamespace(Connection=object)
fake_pymysql_cursors = types.ModuleType("pymysql.cursors")
fake_pymysql_cursors.DictCursor = object
fake_pymysql.cursors = fake_pymysql_cursors
sys.modules.setdefault("pymysql", fake_pymysql)
sys.modules.setdefault("pymysql.cursors", fake_pymysql_cursors)
fake_cryptography = types.ModuleType("cryptography")
fake_hazmat = types.ModuleType("cryptography.hazmat")
fake_primitives = types.ModuleType("cryptography.hazmat.primitives")
fake_ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
fake_aead = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")

class _FakeAESGCM:
    def __init__(self, *args, **kwargs):
        pass

    def encrypt(self, *args, **kwargs):
        return b""

    def decrypt(self, *args, **kwargs):
        return b""


fake_aead.AESGCM = _FakeAESGCM
fake_ciphers.aead = fake_aead
fake_primitives.ciphers = fake_ciphers
fake_hazmat.primitives = fake_primitives
fake_cryptography.hazmat = fake_hazmat
sys.modules.setdefault("cryptography", fake_cryptography)
sys.modules.setdefault("cryptography.hazmat", fake_hazmat)
sys.modules.setdefault("cryptography.hazmat.primitives", fake_primitives)
sys.modules.setdefault("cryptography.hazmat.primitives.ciphers", fake_ciphers)
sys.modules.setdefault("cryptography.hazmat.primitives.ciphers.aead", fake_aead)
try:
    import flask  # noqa: F401
    from flask import Flask
except (ModuleNotFoundError, ImportError):
    Flask = None
    fake_flask = types.ModuleType("flask")
    fake_flask.__trufusion_fake__ = True
    fake_flask.Response = object
    fake_flask.jsonify = lambda value=None, *args, **kwargs: value
    fake_flask.request = types.SimpleNamespace(headers={}, args={}, json=None)
    fake_flask.g = types.SimpleNamespace(current_user=None)
    fake_flask.has_request_context = lambda: False
    sys.modules.setdefault("flask", fake_flask)

try:
    from werkzeug import exceptions as _werkzeug_exceptions  # noqa: F401
except ModuleNotFoundError:
    fake_werkzeug = types.ModuleType("werkzeug")
    fake_werkzeug_exceptions = types.ModuleType("werkzeug.exceptions")

    class _FakeHTTPException(Exception):
        code = None


    fake_werkzeug_exceptions.HTTPException = _FakeHTTPException
    fake_werkzeug.exceptions = fake_werkzeug_exceptions
    sys.modules.setdefault("werkzeug", fake_werkzeug)
    sys.modules.setdefault("werkzeug.exceptions", fake_werkzeug_exceptions)

from python_backend.services import auth_service
from python_backend.repositories import email_verification_token_repository


class AuthServiceTests(unittest.TestCase):
    def test_email_verification_token_ttl_is_ten_minutes(self) -> None:
        self.assertEqual(email_verification_token_repository.DEFAULT_TTL_SECONDS, 10 * 60)

    def test_resolve_sales_user_role_preserves_sales_lead_role(self) -> None:
        self.assertEqual(
            auth_service._resolve_sales_user_role({"role": "sales_lead", "isPartner": False}),
            "sales_lead",
        )
        self.assertEqual(
            auth_service._resolve_sales_user_role({"role": "Sales Lead", "isPartner": False}),
            "sales_lead",
        )

    def test_resolve_sales_user_role_still_handles_partners_and_reps(self) -> None:
        self.assertEqual(
            auth_service._resolve_sales_user_role({"role": "sales_rep", "isPartner": True}),
            "sales_partner",
        )
        self.assertEqual(
            auth_service._resolve_sales_user_role({"role": "sales_rep", "isPartner": False}),
            "sales_rep",
        )

    def test_sanitize_user_rewrites_embedded_media_to_auth_routes(self) -> None:
        if Flask is None:
            self.skipTest("flask not installed")
        app = Flask(__name__)
        user = {
            "id": "doctor-1",
            "email": "doctor@example.com",
            "profileImageUrl": "data:image/png;base64,QUJD",
            "delegateLogoUrl": "data:image/png;base64,REVG",
            "delegateBackgroundImageUrl": "data:image/jpeg;base64,R0hJ",
        }

        with app.test_request_context("/api/auth/me", base_url="https://api.example.com"):
            sanitized = auth_service._sanitize_user(user)

        profile_url = urlparse(str(sanitized["profileImageUrl"]))
        delegate_url = urlparse(str(sanitized["delegateLogoUrl"]))
        background_url = urlparse(str(sanitized["delegateBackgroundImageUrl"]))
        self.assertEqual(
            f"{profile_url.scheme}://{profile_url.netloc}{profile_url.path}",
            "https://api.example.com/api/auth/me/profile-image",
        )
        self.assertEqual(
            f"{delegate_url.scheme}://{delegate_url.netloc}{delegate_url.path}",
            "https://api.example.com/api/auth/me/delegate-logo",
        )
        self.assertEqual(
            f"{background_url.scheme}://{background_url.netloc}{background_url.path}",
            "https://api.example.com/api/auth/me/delegate-background",
        )
        self.assertTrue(parse_qs(profile_url.query).get("v"))
        self.assertTrue(parse_qs(delegate_url.query).get("v"))
        self.assertTrue(parse_qs(background_url.query).get("v"))

    def test_update_profile_does_not_persist_self_profile_image_route(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "profileImageUrl": "data:image/png;base64,QUJD",
            "delegateBackgroundImageUrl": "data:image/jpeg;base64,R0hJ",
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile(
                "doctor-1",
                {
                    "profileImageUrl": "https://api.example.com/api/auth/me/profile-image?v=abc123",
                    "delegateBackgroundImageUrl": "https://api.example.com/api/auth/me/delegate-background?v=abc123",
                },
            )

        self.assertEqual(saved_payloads[0]["profileImageUrl"], "data:image/png;base64,QUJD")
        self.assertEqual(saved_payloads[0]["delegateBackgroundImageUrl"], "data:image/jpeg;base64,R0hJ")
        self.assertEqual(updated["profileImageUrl"], "data:image/png;base64,QUJD")
        self.assertEqual(updated["delegateBackgroundImageUrl"], "data:image/jpeg;base64,R0hJ")

    def test_login_uses_targeted_login_update(self) -> None:
        auth_record = {
            "id": "doctor-1",
            "email": "doctor@example.com",
            "password": "hashed",
            "role": "doctor",
            "visits": 4,
            "sessionId": "session-old",
        }
        updated_record = {
            "id": "doctor-1",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "role": "doctor",
            "visits": 5,
            "sessionId": "session-new",
            "isOnline": True,
        }

        with patch.object(auth_service.user_repository, "find_auth_by_email", return_value=auth_record), \
            patch.object(auth_service.user_repository, "record_successful_login", return_value=updated_record) as record_login, \
            patch.object(auth_service, "_safe_check_password", return_value=True), \
            patch.object(auth_service, "_create_auth_token", return_value="token-123"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value), \
            patch.object(auth_service.presence_service, "record_ping") as record_ping:
            result = auth_service.login({"email": "doctor@example.com", "password": "secret"})

        record_login.assert_called_once()
        record_ping.assert_called_once_with("doctor-1", kind="interaction", is_idle=False)
        self.assertEqual(result["token"], "token-123")
        self.assertEqual(result["user"]["id"], "doctor-1")
        self.assertEqual(result["user"]["sessionId"], "session-new")

    def test_register_creates_pending_user_and_sends_verification_email(self) -> None:
        inserted_payloads = []

        def fake_insert(payload):
            inserted_payloads.append(payload)
            return {**payload, "id": payload.get("id") or "doctor-1"}

        with patch.object(auth_service.sales_rep_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "find_by_npi_number", return_value=None), \
            patch.object(auth_service.npi_service, "normalize_npi", return_value="1234567890"), \
            patch.object(auth_service.npi_service, "verify_npi", return_value={"npiNumber": "1234567890"}), \
            patch.object(auth_service.sales_rep_repository, "find_by_sales_code", return_value={"id": "rep-1"}), \
            patch.object(auth_service.referral_service, "backfill_lead_types_for_doctors", side_effect=lambda users: users), \
            patch.object(auth_service.user_repository, "insert", side_effect=fake_insert), \
            patch.object(auth_service, "_ensure_converted_sales_prospect_for_doctor"), \
            patch.object(auth_service, "_send_email_verification", return_value=True) as send_verification, \
            patch.object(auth_service.bcrypt, "gensalt", return_value=b"salt", create=True), \
            patch.object(auth_service.bcrypt, "hashpw", return_value=b"hashed", create=True):
            result = auth_service.register(
                {
                    "name": "Doctor One",
                    "email": "doctor@example.com",
                    "password": "secret",
                    "code": "AB123",
                    "npiNumber": "1234567890",
                }
            )

        self.assertEqual(result, {"status": "verification_required", "email": "doctor@example.com", "emailSent": True})
        self.assertEqual(inserted_payloads[0]["status"], "pending_email_verification")
        self.assertIsNone(inserted_payloads[0]["sessionId"])
        self.assertIsNone(inserted_payloads[0]["lastLoginAt"])
        self.assertFalse(inserted_payloads[0]["isOnline"])
        send_verification.assert_called_once()

    def test_register_with_admin_sales_code_creates_house_lead(self) -> None:
        inserted_payloads = []

        def fake_insert(payload):
            inserted_payloads.append(payload)
            return {**payload, "id": payload.get("id") or "doctor-1"}

        with patch.object(auth_service.sales_rep_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "find_by_npi_number", return_value=None), \
            patch.object(auth_service.npi_service, "normalize_npi", return_value="1234567890"), \
            patch.object(auth_service.npi_service, "verify_npi", return_value={"npiNumber": "1234567890"}), \
            patch.object(auth_service.sales_rep_repository, "find_by_sales_code", return_value={
                "id": "admin-rep",
                "role": "admin",
            }), \
            patch.object(auth_service.referral_service, "backfill_lead_types_for_doctors", side_effect=lambda users: users), \
            patch.object(auth_service.user_repository, "insert", side_effect=fake_insert), \
            patch.object(auth_service, "_ensure_converted_sales_prospect_for_doctor"), \
            patch.object(auth_service, "_send_email_verification", return_value=True), \
            patch.object(auth_service.bcrypt, "gensalt", return_value=b"salt", create=True), \
            patch.object(auth_service.bcrypt, "hashpw", return_value=b"hashed", create=True):
            result = auth_service.register(
                {
                    "name": "Doctor One",
                    "email": "doctor@example.com",
                    "password": "secret",
                    "code": "AD123",
                    "npiNumber": "1234567890",
                }
            )

        self.assertEqual(result["status"], "verification_required")
        self.assertEqual(inserted_payloads[0]["salesRepId"], "house")
        self.assertEqual(inserted_payloads[0]["leadType"], "house")
        self.assertEqual(inserted_payloads[0]["leadTypeSource"], "admin_code:AD123")
        self.assertTrue(inserted_payloads[0]["leadTypeLockedAt"])

    def test_pending_email_verification_login_is_blocked_after_password_check(self) -> None:
        auth_record = {
            "id": "doctor-1",
            "email": "doctor@example.com",
            "password": "hashed",
            "role": "doctor",
            "status": "pending_email_verification",
            "emailVerifiedAt": None,
        }

        with patch.object(auth_service.user_repository, "find_auth_by_email", return_value=auth_record), \
            patch.object(auth_service, "_safe_check_password", return_value=True), \
            patch.object(auth_service.user_repository, "record_successful_login") as record_login:
            with self.assertRaises(Exception) as ctx:
                auth_service.login({"email": "doctor@example.com", "password": "secret"})

        self.assertEqual(str(ctx.exception), "EMAIL_NOT_VERIFIED")
        self.assertEqual(getattr(ctx.exception, "status", None), 403)
        record_login.assert_not_called()

    def test_active_account_without_email_verified_at_can_login(self) -> None:
        auth_record = {
            "id": "doctor-1",
            "email": "legacy@example.com",
            "password": "hashed",
            "role": "doctor",
            "status": "active",
            "emailVerifiedAt": None,
            "visits": 2,
            "sessionId": "session-old",
        }
        updated_record = {
            **auth_record,
            "visits": 3,
            "sessionId": "session-new",
            "isOnline": True,
        }

        with patch.object(auth_service.user_repository, "find_auth_by_email", return_value=auth_record), \
            patch.object(auth_service.user_repository, "record_successful_login", return_value=updated_record) as record_login, \
            patch.object(auth_service, "_safe_check_password", return_value=True), \
            patch.object(auth_service, "_create_auth_token", return_value="token-123"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value), \
            patch.object(auth_service.presence_service, "record_ping"):
            result = auth_service.login({"email": "legacy@example.com", "password": "secret"})

        record_login.assert_called_once()
        self.assertEqual(result["token"], "token-123")
        self.assertEqual(result["user"]["email"], "legacy@example.com")

    def test_verify_email_code_activates_user_consumes_token_and_logs_in(self) -> None:
        code = "123456"
        config = types.SimpleNamespace(mysql={"enabled": False}, jwt_secret="test-secret")
        with patch.object(auth_service, "get_config", return_value=config):
            lookup_token = auth_service._email_verification_lookup_token("doctor@example.com", code)
        auth_service._EMAIL_VERIFICATION_TOKENS.clear()
        auth_service._EMAIL_VERIFICATION_TOKENS[lookup_token] = {
            "user_id": "doctor-1",
            "recipient_email": "doctor@example.com",
            "expires": datetime.now(timezone.utc) + timedelta(hours=1),
        }
        saved_payloads = []
        user = {
            "id": "doctor-1",
            "email": "doctor@example.com",
            "role": "doctor",
            "status": "pending_email_verification",
            "emailVerifiedAt": None,
        }
        logged_in_user = {
            **user,
            "status": "active",
            "emailVerifiedAt": "verified-at",
            "sessionId": "session-new",
            "isOnline": True,
        }

        with patch.object(auth_service, "get_config", return_value=config), \
            patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "update", side_effect=lambda payload: saved_payloads.append(payload) or payload), \
            patch.object(auth_service.user_repository, "record_successful_login", return_value=logged_in_user) as record_login, \
            patch.object(auth_service, "_create_auth_token", return_value="token-123"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value), \
            patch.object(auth_service.presence_service, "record_ping") as record_ping:
            result = auth_service.verify_email({"email": "doctor@example.com", "code": code})

        self.assertEqual(result["status"], "verified")
        self.assertEqual(result["email"], "doctor@example.com")
        self.assertEqual(result["token"], "token-123")
        self.assertEqual(result["user"]["sessionId"], "session-new")
        self.assertNotIn(lookup_token, auth_service._EMAIL_VERIFICATION_TOKENS)
        self.assertEqual(saved_payloads[0]["status"], "active")
        self.assertTrue(saved_payloads[0]["emailVerifiedAt"])
        self.assertFalse(saved_payloads[0]["isOnline"])
        record_login.assert_called_once()
        record_ping.assert_called_once_with("doctor-1", kind="interaction", is_idle=False)

    def test_verify_email_rejects_expired_memory_token(self) -> None:
        code = "123456"
        config = types.SimpleNamespace(mysql={"enabled": False}, jwt_secret="test-secret")
        with patch.object(auth_service, "get_config", return_value=config):
            lookup_token = auth_service._email_verification_lookup_token("doctor@example.com", code)
        auth_service._EMAIL_VERIFICATION_TOKENS.clear()
        auth_service._EMAIL_VERIFICATION_TOKENS[lookup_token] = {
            "user_id": "doctor-1",
            "recipient_email": "doctor@example.com",
            "expires": datetime.now(timezone.utc) - timedelta(seconds=1),
        }

        with patch.object(auth_service, "get_config", return_value=config), \
            patch.object(auth_service.user_repository, "update") as update:
            with self.assertRaises(Exception) as ctx:
                auth_service.verify_email({"email": "doctor@example.com", "code": code})

        self.assertEqual(str(ctx.exception), "CODE_INVALID")
        update.assert_not_called()

    def test_resend_email_verification_is_non_enumerating(self) -> None:
        with patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service, "_send_email_verification") as send_verification:
            result = auth_service.resend_email_verification("missing@example.com")

        self.assertEqual(result, {"status": "ok"})
        send_verification.assert_not_called()

        active_user = {
            "id": "doctor-1",
            "email": "legacy@example.com",
            "status": "active",
            "emailVerifiedAt": None,
        }
        with patch.object(auth_service.user_repository, "find_by_email", return_value=active_user), \
            patch.object(auth_service, "_send_email_verification") as send_verification:
            result = auth_service.resend_email_verification("legacy@example.com")

        self.assertEqual(result, {"status": "ok"})
        send_verification.assert_not_called()

        pending_user = {
            "id": "doctor-1",
            "email": "doctor@example.com",
            "status": "pending_email_verification",
            "emailVerifiedAt": None,
        }
        with patch.object(auth_service.user_repository, "find_by_email", return_value=pending_user), \
            patch.object(auth_service, "_send_email_verification", return_value=True) as send_verification:
            result = auth_service.resend_email_verification("doctor@example.com")

        self.assertEqual(result, {"status": "ok"})
        send_verification.assert_called_once_with(pending_user)

    def test_update_profile_clears_explicit_office_address_fields(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "phone": "555-0100",
            "officeAddressLine1": "123 Main St",
            "officeAddressLine2": "Suite 200",
            "officeCity": "Indianapolis",
            "officeState": "IN",
            "officePostalCode": "46204",
            "officeCountry": "US",
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.legal_acceptance_repository, "record_acceptances", return_value=3) as record_acceptances, \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile(
                "doctor-1",
                {
                    "officeAddressLine1": "",
                    "officeAddressLine2": "   ",
                    "officeCity": None,
                    "officeState": "",
                    "officePostalCode": " ",
                    "officeCountry": None,
                },
            )

        self.assertEqual(len(saved_payloads), 1)
        for field in (
            "officeAddressLine1",
            "officeAddressLine2",
            "officeCity",
            "officeState",
            "officePostalCode",
            "officeCountry",
        ):
            self.assertIsNone(saved_payloads[0][field], field)
            self.assertIsNone(updated[field], field)

    def test_update_profile_preserves_existing_office_address_when_fields_are_omitted(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "phone": "555-0100",
            "officeAddressLine1": "123 Main St",
            "officeAddressLine2": "Suite 200",
            "officeCity": "Indianapolis",
            "officeState": "IN",
            "officePostalCode": "46204",
            "officeCountry": "US",
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile("doctor-1", {"name": "Doctor One Updated"})

        self.assertEqual(len(saved_payloads), 1)
        for field, expected in (
            ("officeAddressLine1", "123 Main St"),
            ("officeAddressLine2", "Suite 200"),
            ("officeCity", "Indianapolis"),
            ("officeState", "IN"),
            ("officePostalCode", "46204"),
            ("officeCountry", "US"),
        ):
            self.assertEqual(saved_payloads[0][field], expected, field)
            self.assertEqual(updated[field], expected, field)

    def test_delete_reseller_permit_clears_permit_fields_and_tax_exemption(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "email": "doctor@example.com",
            "isTaxExempt": True,
            "taxExemptSource": "RESELLER_PERMIT",
            "taxExemptReason": "Reseller permit on file",
            "resellerPermitOnboardingPresented": True,
            "resellerPermitFilePath": "uploads/reseller-permits/permit.pdf",
            "resellerPermitFileName": "permit.pdf",
            "resellerPermitUploadedAt": "2026-04-02T12:00:00Z",
            "resellerPermitApprovedByRep": True,
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service, "_delete_reseller_permit_file") as delete_file, \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.delete_reseller_permit("doctor-1")

        delete_file.assert_called_once_with(user)
        self.assertEqual(saved_payloads[0]["isTaxExempt"], False)
        self.assertIsNone(saved_payloads[0]["taxExemptSource"])
        self.assertIsNone(saved_payloads[0]["taxExemptReason"])
        self.assertIsNone(saved_payloads[0]["resellerPermitFilePath"])
        self.assertIsNone(saved_payloads[0]["resellerPermitFileName"])
        self.assertIsNone(saved_payloads[0]["resellerPermitUploadedAt"])
        self.assertEqual(saved_payloads[0]["resellerPermitApprovedByRep"], False)
        self.assertEqual(updated["resellerPermitOnboardingPresented"], True)

    def test_upload_reseller_permit_resets_rep_approval_and_tax_exemption(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "email": "doctor@example.com",
            "isTaxExempt": True,
            "taxExemptSource": "RESELLER_PERMIT",
            "taxExemptReason": "Reseller permit approved by sales rep",
            "resellerPermitApprovedByRep": True,
            "resellerPermitFilePath": "uploads/reseller-permits/old-permit.pdf",
            "resellerPermitFileName": "old-permit.pdf",
            "resellerPermitUploadedAt": "2026-04-02T12:00:00Z",
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service, "_delete_reseller_permit_file"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value), \
            patch.object(auth_service.secrets, "token_hex", return_value="deadbeef"), \
            patch.object(auth_service.time, "time", return_value=1_777_000_000.123), \
            patch.object(auth_service.Path, "mkdir", return_value=None), \
            patch.object(auth_service.Path, "write_bytes", return_value=None):
            updated = auth_service.upload_reseller_permit(
                "doctor-1",
                filename="permit.pdf",
                content=b"permit",
            )

        self.assertEqual(saved_payloads[0]["isTaxExempt"], False)
        self.assertIsNone(saved_payloads[0]["taxExemptSource"])
        self.assertIsNone(saved_payloads[0]["taxExemptReason"])
        self.assertEqual(saved_payloads[0]["resellerPermitApprovedByRep"], False)
        self.assertEqual(updated["resellerPermitApprovedByRep"], False)

    def test_approve_reseller_permit_marks_user_tax_exempt(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "email": "doctor@example.com",
            "isTaxExempt": False,
            "taxExemptSource": None,
            "taxExemptReason": None,
            "resellerPermitFilePath": "uploads/reseller-permits/permit.pdf",
            "resellerPermitFileName": "permit.pdf",
            "resellerPermitUploadedAt": "2026-04-02T12:00:00Z",
            "resellerPermitApprovedByRep": False,
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.approve_reseller_permit("doctor-1")

        self.assertEqual(saved_payloads[0]["isTaxExempt"], True)
        self.assertEqual(saved_payloads[0]["taxExemptSource"], "RESELLER_PERMIT")
        self.assertEqual(saved_payloads[0]["taxExemptReason"], "Reseller permit approved by sales rep")
        self.assertEqual(saved_payloads[0]["resellerPermitApprovedByRep"], True)
        self.assertEqual(updated["resellerPermitApprovedByRep"], True)

    def test_update_profile_persists_network_presence_agreement(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "networkPresenceAgreement": False,
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile(
                "doctor-1",
                {"networkPresenceAgreement": True},
            )

        self.assertEqual(len(saved_payloads), 1)
        self.assertTrue(saved_payloads[0]["networkPresenceAgreement"])
        self.assertEqual(saved_payloads[0]["network_presence_agreement"], 1)
        self.assertTrue(updated["networkPresenceAgreement"])

    def test_update_profile_records_research_terms_versions_and_timestamp(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "researchTermsAgreement": False,
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.legal_acceptance_repository, "record_acceptances", return_value=3) as record_acceptances, \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile(
                "doctor-1",
                {
                    "researchTermsAgreement": True,
                    "researchTermsAgreementVersion": "2026.05.23",
                    "researchShippingPolicyVersion": "2026.05.23",
                    "researchPrivacyPolicyVersion": "2026.05.23",
                },
                legal_acceptance_context={
                    "ip": "203.0.113.10",
                    "userAgent": "UnitTest/1.0",
                },
            )

        self.assertEqual(len(saved_payloads), 1)
        self.assertTrue(saved_payloads[0]["researchTermsAgreement"])
        self.assertEqual(saved_payloads[0]["researchTermsAgreementVersion"], "2026.05.23")
        self.assertEqual(saved_payloads[0]["researchShippingPolicyVersion"], "2026.05.23")
        self.assertEqual(saved_payloads[0]["researchPrivacyPolicyVersion"], "2026.05.23")
        self.assertRegex(saved_payloads[0]["researchTermsAgreementAcceptedAt"], r"^\d{4}-\d{2}-\d{2}T")
        self.assertTrue(updated["researchTermsAgreement"])
        record_acceptances.assert_called_once_with(
            user_id="doctor-1",
            documents=[
                {"document_key": "terms", "document_version": "2026.05.23"},
                {"document_key": "shipping", "document_version": "2026.05.23"},
                {"document_key": "privacy", "document_version": "2026.05.23"},
            ],
            accepted_at=saved_payloads[0]["researchTermsAgreementAcceptedAt"],
            acceptance_context="research_terms_agreement",
            ip_hash=ANY,
            user_agent_hash=ANY,
        )
        self.assertEqual(len(record_acceptances.call_args.kwargs["ip_hash"]), 64)
        self.assertEqual(len(record_acceptances.call_args.kwargs["user_agent_hash"]), 64)

    def test_update_profile_persists_patient_link_email_preference(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "receivePatientLinkUpdateEmails": True,
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile(
                "doctor-1",
                {"receivePatientLinkUpdateEmails": False},
            )

        self.assertEqual(len(saved_payloads), 1)
        self.assertFalse(saved_payloads[0]["receivePatientLinkUpdateEmails"])
        self.assertFalse(updated["receivePatientLinkUpdateEmails"])

    def test_update_profile_normalizes_greater_area(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "greaterArea": "Midwest",
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile(
                "doctor-1",
                {"greaterArea": "  new   orleans, la  "},
            )

        self.assertEqual(len(saved_payloads), 1)
        self.assertEqual(saved_payloads[0]["greaterArea"], "New Orleans, LA")
        self.assertEqual(updated["greaterArea"], "New Orleans, LA")

    def test_update_profile_marks_doctor_onboarding_complete_only_when_required_fields_exist(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "greaterArea": "Midwest",
            "studyFocus": None,
            "profileOnboarding": False,
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            incomplete = auth_service.update_profile(
                "doctor-1",
                {"profileOnboarding": True},
            )

        self.assertEqual(len(saved_payloads), 1)
        self.assertFalse(saved_payloads[0]["profileOnboarding"])
        self.assertFalse(incomplete["profileOnboarding"])

        saved_payloads.clear()

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            complete = auth_service.update_profile(
                "doctor-1",
                {"studyFocus": "Recovery research"},
            )

        self.assertEqual(len(saved_payloads), 1)
        self.assertTrue(saved_payloads[0]["profileOnboarding"])
        self.assertTrue(complete["profileOnboarding"])
        self.assertEqual(saved_payloads[0]["studyFocus"], "Recovery research")

    def test_update_profile_accepts_snake_case_network_presence_agreement(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "network_presence_agreement": 0,
        }
        saved_payloads = []

        def fake_update(payload):
            saved_payloads.append(payload)
            return payload

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_email", return_value=None), \
            patch.object(auth_service.user_repository, "update", side_effect=fake_update), \
            patch.object(auth_service.sales_prospect_repository, "sync_contact_for_doctor"), \
            patch.object(auth_service.referral_repository, "sync_referred_contact_for_account"), \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            updated = auth_service.update_profile(
                "doctor-1",
                {"network_presence_agreement": True},
            )

        self.assertEqual(len(saved_payloads), 1)
        self.assertTrue(saved_payloads[0]["networkPresenceAgreement"])
        self.assertEqual(saved_payloads[0]["network_presence_agreement"], 1)
        self.assertTrue(updated["networkPresenceAgreement"])

    def test_get_profile_maps_legacy_network_presence_agreement_to_camel_case(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "network_presence_agreement": 1,
        }

        with patch.object(auth_service.user_repository, "find_by_id", return_value=user):
            profile = auth_service.get_profile("doctor-1")

        self.assertTrue(profile["networkPresenceAgreement"])

    def test_get_profile_normalizes_greater_area_for_response(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "greater_area": "new orleans",
        }

        with patch.object(auth_service.user_repository, "find_profile_by_id", return_value=user), \
            patch.object(auth_service.user_repository, "find_by_id", return_value=None):
            profile = auth_service.get_profile("doctor-1")

        self.assertEqual(profile["greaterArea"], "New Orleans")
        self.assertEqual(profile["greater_area"], "New Orleans")

    def test_get_profile_prefers_projected_lookup_before_full_lookup(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
        }

        with patch.object(auth_service.user_repository, "find_profile_by_id", return_value=user) as find_profile, \
            patch.object(auth_service.user_repository, "find_by_id", return_value=None) as find_full, \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: dict(value)):
            profile = auth_service.get_profile("doctor-1")

        self.assertEqual(profile["id"], "doctor-1")
        find_profile.assert_called_once_with("doctor-1")
        find_full.assert_not_called()

    def test_get_session_prefers_lightweight_lookup(self) -> None:
        user = {
            "id": "doctor-1",
            "role": "doctor",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "sessionId": "session-1",
        }

        with patch.object(auth_service.user_repository, "find_session_by_id", return_value=user) as find_session, \
            patch.object(auth_service.user_repository, "find_by_id", return_value=None) as find_full, \
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: dict(value)):
            profile = auth_service.get_session("doctor-1")

        self.assertEqual(profile["id"], "doctor-1")
        find_session.assert_called_once_with("doctor-1")
        find_full.assert_not_called()


if __name__ == "__main__":
    unittest.main()
