import sys
import types
import unittest
from unittest.mock import patch


def _install_test_stubs() -> None:
    if "flask" not in sys.modules:
        flask = types.ModuleType("flask")

        class Response:  # minimal stub
            pass

        flask.Response = Response
        flask.request = types.SimpleNamespace(method="GET", path="/")
        flask.g = types.SimpleNamespace(current_user=None)
        flask.jsonify = lambda payload=None, *args, **kwargs: payload
        sys.modules["flask"] = flask

    if "werkzeug" not in sys.modules:
        werkzeug = types.ModuleType("werkzeug")
        exceptions = types.ModuleType("werkzeug.exceptions")

        class HTTPException(Exception):
            code = 500
            description = ""

        exceptions.HTTPException = HTTPException
        sys.modules["werkzeug"] = werkzeug
        sys.modules["werkzeug.exceptions"] = exceptions

    if "cryptography" not in sys.modules:
        cryptography = types.ModuleType("cryptography")
        hazmat = types.ModuleType("cryptography.hazmat")
        primitives = types.ModuleType("cryptography.hazmat.primitives")
        ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
        aead = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")

        class AESGCM:
            def __init__(self, *_args, **_kwargs):
                pass

            def encrypt(self, _iv, data, _aad):
                return data

            def decrypt(self, _iv, data, _aad):
                return data

        aead.AESGCM = AESGCM
        sys.modules["cryptography"] = cryptography
        sys.modules["cryptography.hazmat"] = hazmat
        sys.modules["cryptography.hazmat.primitives"] = primitives
        sys.modules["cryptography.hazmat.primitives.ciphers"] = ciphers
        sys.modules["cryptography.hazmat.primitives.ciphers.aead"] = aead

    if "pymysql" not in sys.modules:
        pymysql = types.ModuleType("pymysql")
        pymysql_cursors = types.ModuleType("pymysql.cursors")

        class DictCursor:
            pass

        pymysql_cursors.DictCursor = DictCursor

        class _Connections(types.SimpleNamespace):
            class Connection:
                pass

        pymysql.connections = _Connections()

        def connect(*_args, **_kwargs):
            raise RuntimeError("pymysql.connect called during unit test")

        pymysql.connect = connect
        sys.modules["pymysql"] = pymysql
        sys.modules["pymysql.cursors"] = pymysql_cursors

    storage_stub = sys.modules.get("python_backend.storage")
    if storage_stub is None:
        storage_stub = types.ModuleType("python_backend.storage")
        sys.modules["python_backend.storage"] = storage_stub
    storage_stub.user_store = getattr(storage_stub, "user_store", None)
    storage_stub.order_store = getattr(storage_stub, "order_store", None)
    storage_stub.sales_rep_store = getattr(storage_stub, "sales_rep_store", None)
    storage_stub.referral_code_store = getattr(storage_stub, "referral_code_store", None)
    storage_stub.referral_store = getattr(storage_stub, "referral_store", None)
    storage_stub.sales_prospect_store = getattr(storage_stub, "sales_prospect_store", None)
    storage_stub.credit_ledger_store = getattr(storage_stub, "credit_ledger_store", None)
    storage_stub.contact_form_store = getattr(storage_stub, "contact_form_store", None)
    storage_stub.bug_report_store = getattr(storage_stub, "bug_report_store", None)
    storage_stub.contact_form_status_store = getattr(storage_stub, "contact_form_status_store", None)
    storage_stub.settings_store = getattr(storage_stub, "settings_store", None)
    storage_stub.peptide_forum_store = getattr(storage_stub, "peptide_forum_store", None)
    storage_stub.seamless_store = getattr(storage_stub, "seamless_store", None)

    if "requests" not in sys.modules:
        requests = types.ModuleType("requests")
        requests_auth = types.ModuleType("requests.auth")

        def _blocked(*_args, **_kwargs):
            raise RuntimeError("requests used during unit test")

        class HTTPBasicAuth:
            def __init__(self, *_args, **_kwargs):
                pass

        requests.get = _blocked
        requests.post = _blocked
        requests.put = _blocked
        requests.patch = _blocked
        requests.delete = _blocked
        requests_auth.HTTPBasicAuth = HTTPBasicAuth
        sys.modules["requests"] = requests
        sys.modules["requests.auth"] = requests_auth


class ContactFormEncryptedReadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        import python_backend.services as services_package
        from python_backend.services import order_service, referral_service

        cls.services_package = services_package
        cls.order_service = order_service
        cls.referral_service = referral_service

    def test_fetch_contact_form_ids_by_email_uses_blind_index_and_decrypts_email(self):
        service = self.referral_service
        original_fetch_all = service.mysql_client.fetch_all
        original_compute = service.compute_blind_index
        original_decrypt = service.decrypt_text
        captured = {}
        try:
            service.compute_blind_index = lambda value, *, label: f"idx:{value}"

            def fake_fetch_all(query, params):
                captured["query"] = query
                captured["params"] = dict(params)
                return [
                    {
                        "id": 7,
                        "email": "cipher-email",
                        "created_at": "2026-03-24T00:00:00Z",
                    }
                ]

            service.mysql_client.fetch_all = fake_fetch_all
            service.decrypt_text = (
                lambda value, aad=None: "doctor@example.com" if value == "cipher-email" else None
            )

            mapping = service._fetch_contact_form_ids_by_email([" Doctor@example.com "])

            self.assertEqual(mapping, {"doctor@example.com": "contact_form:7"})
            self.assertIn("email_blind_index IN", captured["query"])
            self.assertEqual(captured["params"]["blind_0"], "idx:doctor@example.com")
        finally:
            service.mysql_client.fetch_all = original_fetch_all
            service.compute_blind_index = original_compute
            service.decrypt_text = original_decrypt

    def test_load_contact_form_referrals_decrypts_fields_for_dashboard(self):
        service = self.referral_service
        original_get_config = service.get_config
        original_fetch_all = service.mysql_client.fetch_all
        original_upsert = service.sales_prospect_repository.upsert
        original_decrypt = service.decrypt_text
        original_apply_account_fields = service._apply_referred_contact_account_fields
        captured = {}
        try:
            service.get_config = lambda: types.SimpleNamespace(mysql={"enabled": True})

            def fake_fetch_all(_query, _params=None):
                return [
                    {
                        "id": 7,
                        "name": "cipher-name",
                        "email": "cipher-email",
                        "phone": "cipher-phone",
                        "source": "WEB",
                        "created_at": "2026-03-24T00:00:00Z",
                        "prospect_sales_rep_id": None,
                        "prospect_doctor_id": None,
                        "prospect_status": None,
                        "prospect_notes": None,
                        "prospect_updated_at": None,
                        "reseller_permit_exempt": 0,
                        "reseller_permit_file_path": None,
                        "reseller_permit_file_name": None,
                        "reseller_permit_uploaded_at": None,
                    }
                ]

            def fake_upsert(payload):
                captured["upsert"] = dict(payload)
                return dict(payload)

            def fake_decrypt(value, aad=None):
                mapping = {
                    "cipher-name": "Encrypted Lead",
                    "cipher-email": "lead@example.com",
                    "cipher-phone": "555-0100",
                }
                return mapping.get(value)

            service.mysql_client.fetch_all = fake_fetch_all
            service.sales_prospect_repository.upsert = fake_upsert
            service.decrypt_text = fake_decrypt
            service._apply_referred_contact_account_fields = lambda record: record

            records = service._load_contact_form_referrals()

            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["referredContactName"], "Encrypted Lead")
            self.assertEqual(records[0]["referredContactEmail"], "lead@example.com")
            self.assertEqual(records[0]["referredContactPhone"], "555-0100")
            self.assertEqual(captured["upsert"]["contactName"], "Encrypted Lead")
            self.assertEqual(captured["upsert"]["contactEmail"], "lead@example.com")
            self.assertEqual(captured["upsert"]["contactPhone"], "555-0100")
        finally:
            service.get_config = original_get_config
            service.mysql_client.fetch_all = original_fetch_all
            service.sales_prospect_repository.upsert = original_upsert
            service.decrypt_text = original_decrypt
            service._apply_referred_contact_account_fields = original_apply_account_fields

    def test_load_contact_form_emails_from_mysql_decrypts_contact_form_rows(self):
        service = self.order_service
        services_package = self.services_package
        original_get_config = services_package.get_config
        original_fetch_all = service.mysql_client.fetch_all
        original_decrypt = service.decrypt_text
        try:
            services_package.get_config = lambda: types.SimpleNamespace(mysql={"enabled": True})

            def fake_fetch_all(query, _params=None):
                if "FROM contact_forms" in query:
                    return [
                        {"email": "cipher-email"},
                        {"email": "plaintext@example.com"},
                    ]
                if "FROM contact_form" in query:
                    return [{"email": "legacy@example.com"}]
                return []

            service.mysql_client.fetch_all = fake_fetch_all
            service.decrypt_text = (
                lambda value, aad=None: "encrypted@example.com" if value == "cipher-email" else None
            )

            emails = service._load_contact_form_emails_from_mysql()

            self.assertEqual(
                emails,
                {"encrypted@example.com", "plaintext@example.com", "legacy@example.com"},
            )
        finally:
            services_package.get_config = original_get_config
            service.mysql_client.fetch_all = original_fetch_all
            service.decrypt_text = original_decrypt

    def test_resolve_referred_contact_account_skips_woo_fallback_by_default(self):
        service = self.referral_service
        with patch.object(
            service.user_repository,
            "find_by_email",
            return_value={"id": "doctor-1", "email": "lead@example.com"},
        ), patch.object(
            service.order_repository,
            "count_by_user_id",
            return_value=0,
        ), patch.object(
            service.woo_commerce,
            "fetch_orders_by_email",
            side_effect=AssertionError("Woo fallback should not run for dashboard reads"),
        ):
            account, order_count = service._resolve_referred_contact_account(
                {"referredContactEmail": "lead@example.com"}
            )

        self.assertEqual(account["id"], "doctor-1")
        self.assertEqual(order_count, 0)

    def test_manually_add_credit_uses_woo_fallback_for_order_verification(self):
        service = self.referral_service
        with patch.object(
            service.user_repository,
            "find_by_id",
            return_value={"id": "doctor-1", "salesRepId": "rep-1", "referralCredits": 100},
        ), patch.object(
            service.referral_repository,
            "find_by_id",
            return_value={"id": "ref-1", "referredContactName": "Lead", "referredContactEmail": "lead@example.com"},
        ), patch.object(
            service,
            "_resolve_referred_contact_account",
            return_value=({"id": "doctor-2"}, 1),
        ) as mock_resolve, patch.object(
            service.credit_ledger_repository,
            "insert",
            return_value={"id": "ledger-1"},
        ), patch.object(
            service.referral_repository,
            "update",
            side_effect=lambda payload: dict(payload),
        ), patch.object(
            service.user_repository,
            "adjust_referral_credits",
            return_value={"id": "doctor-1", "referralCredits": 75},
        ), patch.object(
            service.sales_prospect_repository,
            "find_all_by_referral_id",
            return_value=[],
        ), patch.object(
            service.sales_prospect_repository,
            "upsert",
            side_effect=lambda payload: dict(payload),
        ), patch.object(
            service.sales_prospect_repository,
            "mark_doctor_as_nurturing_after_credit",
            return_value=1,
        ):
            result = service.manually_add_credit(
                "doctor-1",
                25.0,
                "manual adjustment",
                "admin-1",
                referral_id="ref-1",
            )

        self.assertEqual(result["ledgerEntry"]["id"], "ledger-1")
        mock_resolve.assert_called_once_with(
            {"id": "ref-1", "referredContactName": "Lead", "referredContactEmail": "lead@example.com"},
            include_woo_fallback=True,
        )


if __name__ == "__main__":
    unittest.main()
