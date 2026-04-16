from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault("bcrypt", types.SimpleNamespace())
sys.modules.setdefault("jwt", types.SimpleNamespace())
fake_requests = types.ModuleType("requests")
fake_requests_auth = types.ModuleType("requests.auth")

class _FakeHTTPBasicAuth:
    def __init__(self, *args, **kwargs):
        pass


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
except ModuleNotFoundError:
    fake_flask = types.ModuleType("flask")
    fake_flask.Response = object
    fake_flask.jsonify = lambda value=None, *args, **kwargs: value
    fake_flask.request = types.SimpleNamespace(headers={}, args={}, json=None)
    fake_flask.g = types.SimpleNamespace(current_user=None)
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


class AuthServiceTests(unittest.TestCase):
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
            patch.object(auth_service, "_sanitize_user", side_effect=lambda value: value):
            result = auth_service.login({"email": "doctor@example.com", "password": "secret"})

        record_login.assert_called_once()
        self.assertEqual(result["token"], "token-123")
        self.assertEqual(result["user"]["id"], "doctor-1")
        self.assertEqual(result["user"]["sessionId"], "session-new")

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
