from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch

if "cryptography.hazmat.primitives.ciphers.aead" not in sys.modules:
    cryptography_stub = types.ModuleType("cryptography")
    hazmat_stub = types.ModuleType("cryptography.hazmat")
    primitives_stub = types.ModuleType("cryptography.hazmat.primitives")
    ciphers_stub = types.ModuleType("cryptography.hazmat.primitives.ciphers")
    aead_stub = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")

    class _AesGcmStub:
        def __init__(self, *_args, **_kwargs):
            pass

        def encrypt(self, *_args, **_kwargs):
            return b""

        def decrypt(self, *_args, **_kwargs):
            return b"{}"

    aead_stub.AESGCM = _AesGcmStub
    sys.modules["cryptography"] = cryptography_stub
    sys.modules["cryptography.hazmat"] = hazmat_stub
    sys.modules["cryptography.hazmat.primitives"] = primitives_stub
    sys.modules["cryptography.hazmat.primitives.ciphers"] = ciphers_stub
    sys.modules["cryptography.hazmat.primitives.ciphers.aead"] = aead_stub

if "flask" not in sys.modules:
    flask_stub = types.ModuleType("flask")

    class _Response:
        pass

    flask_stub.Response = _Response
    flask_stub.jsonify = lambda payload=None: payload
    flask_stub.request = types.SimpleNamespace(method="GET", path="/")
    sys.modules["flask"] = flask_stub

if "werkzeug.exceptions" not in sys.modules:
    werkzeug_stub = types.ModuleType("werkzeug")
    exceptions_stub = types.ModuleType("werkzeug.exceptions")

    class _HttpException(Exception):
        code = 500
        description = ""

    exceptions_stub.HTTPException = _HttpException
    sys.modules["werkzeug"] = werkzeug_stub
    sys.modules["werkzeug.exceptions"] = exceptions_stub

if "pymysql" not in sys.modules:
    pymysql_stub = types.ModuleType("pymysql")
    pymysql_stub.connect = lambda *args, **kwargs: None
    pymysql_stub.connections = types.SimpleNamespace(Connection=object)
    pymysql_stub.err = types.SimpleNamespace(Error=Exception, OperationalError=Exception, InterfaceError=Exception)
    cursors_stub = types.ModuleType("pymysql.cursors")
    cursors_stub.DictCursor = object
    pymysql_stub.cursors = cursors_stub
    sys.modules["pymysql"] = pymysql_stub
    sys.modules["pymysql.cursors"] = cursors_stub

from python_backend.repositories import sales_prospect_quote_repository as repository


class SalesProspectQuoteRepositoryTests(unittest.TestCase):
    def test_to_db_params_encrypts_inline_quote_payload(self) -> None:
        with patch.object(
            repository,
            "encrypt_json",
            side_effect=lambda value, aad=None: f"cipher:{aad['field']}:{aad['record_ref']}:{value['title']}",
        ):
            params = repository._to_db_params(
                {
                    "id": "quote-1",
                    "prospectId": "prospect-1",
                    "salesRepId": "rep-1",
                    "revisionNumber": 1,
                    "status": "draft",
                    "title": "Revision 1",
                    "currency": "USD",
                    "subtotal": 150,
                    "quotePayloadJson": {"title": "Revision 1"},
                    "createdAt": "2026-03-29T00:00:00Z",
                    "updatedAt": "2026-03-29T00:00:00Z",
                }
            )

        self.assertEqual(
            params["quote_payload_json"],
            "cipher:quote_payload_json:quote-1:Revision 1",
        )

    @patch.object(repository, "_using_mysql", return_value=True)
    @patch.object(
        repository.mysql_client,
        "fetch_all",
        return_value=[
            {
                "id": "quote-1",
                "prospect_id": "prospect-1",
                "sales_rep_id": "rep-1",
                "revision_number": 1,
                "status": "exported",
                "title": "R1",
                "currency": "USD",
                "subtotal": 100,
                "quote_payload_json": "cipher-r1",
                "created_at": "2026-03-28T10:00:00Z",
                "updated_at": "2026-03-28T10:00:00Z",
            },
            {
                "id": "quote-2",
                "prospect_id": "prospect-1",
                "sales_rep_id": "rep-1",
                "revision_number": 2,
                "status": "draft",
                "title": "R2",
                "currency": "USD",
                "subtotal": 125,
                "quote_payload_json": "cipher-r2",
                "created_at": "2026-03-28T11:00:00Z",
                "updated_at": "2026-03-28T11:00:00Z",
            },
        ],
    )
    def test_list_by_prospect_id_decrypts_inline_payloads_and_sorts_latest_first(self, _fetch_all, _using_mysql) -> None:
        def fake_decrypt(value, aad=None):
            del aad
            if value == "cipher-r1":
                return {"title": "R1", "items": []}
            if value == "cipher-r2":
                return {"title": "R2", "items": []}
            return None

        with patch.object(repository, "decrypt_json", side_effect=fake_decrypt):
            records = repository.list_by_prospect_id("prospect-1")

        self.assertEqual(len(records), 2)
        self.assertEqual(records[0]["id"], "quote-2")
        self.assertEqual(records[0]["quotePayloadJson"]["title"], "R2")
        self.assertEqual(records[1]["id"], "quote-1")


if __name__ == "__main__":
    unittest.main()
