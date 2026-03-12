import sys
import types
import unittest


def _install_test_stubs() -> None:
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


class DelegationServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import delegation_service

        cls.delegation_service = delegation_service

    def test_validate_non_phi_label_rejects_email(self):
        with self.assertRaises(ValueError) as ctx:
            self.delegation_service._validate_non_phi_label(
                "subject@example.com",
                field_name="subjectLabel",
            )
        self.assertEqual(getattr(ctx.exception, "status", None), 400)

    def test_validate_research_note_rejects_dosing_language(self):
        with self.assertRaises(ValueError) as ctx:
            self.delegation_service._validate_research_note(
                "Use this dosage schedule for treatment.",
                field_name="instructions",
            )
        self.assertEqual(getattr(ctx.exception, "status", None), 400)

    def test_validate_delegate_items_enforces_allowed_products(self):
        service = self.delegation_service
        original_find = service.patient_links_repository.find_by_token
        original_audit = service._audit_event
        try:
            service.patient_links_repository.find_by_token = lambda *_args, **_kwargs: {
                "doctorId": "doc-1",
                "allowedProducts": ["BPC-157-5MG"],
            }
            service._audit_event = lambda *_args, **_kwargs: None

            allowed = service.validate_delegate_items(
                "abc123",
                [{"sku": "BPC-157-5MG", "name": "BPC-157", "quantity": 1}],
            )
            self.assertEqual(len(allowed.get("validatedItems") or []), 1)

            with self.assertRaises(ValueError) as ctx:
                service.validate_delegate_items(
                    "abc123",
                    [{"sku": "TB-500-10MG", "name": "TB-500", "quantity": 1}],
                )
            self.assertEqual(getattr(ctx.exception, "status", None), 403)
        finally:
            service.patient_links_repository.find_by_token = original_find
            service._audit_event = original_audit


if __name__ == "__main__":
    unittest.main()
