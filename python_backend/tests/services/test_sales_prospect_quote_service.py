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

if "requests" not in sys.modules:
    requests_stub = types.ModuleType("requests")
    requests_auth_stub = types.ModuleType("requests.auth")

    class _HttpBasicAuth:
        def __init__(self, *_args, **_kwargs):
            pass

    requests_auth_stub.HTTPBasicAuth = _HttpBasicAuth
    requests_stub.auth = requests_auth_stub
    sys.modules["requests"] = requests_stub
    sys.modules["requests.auth"] = requests_auth_stub

from python_backend.services import sales_prospect_quote_service as service


class SalesProspectQuoteServiceTests(unittest.TestCase):
    def test_import_cart_to_prospect_quote_reuses_existing_draft_revision(self) -> None:
        upserts = []

        with patch.object(
            service,
            "_ensure_prospect_record",
            return_value={
                "identifier": "doctor-1",
                "prospect": {"id": "prospect-1", "salesRepId": "rep-1", "contactName": "Dr. One"},
                "salesRepId": "rep-1",
            },
        ), patch.object(
            service.sales_prospect_quote_repository,
            "list_by_prospect_id",
            side_effect=[
                [
                    {
                        "id": "quote-draft",
                        "prospectId": "prospect-1",
                        "salesRepId": "rep-1",
                        "revisionNumber": 2,
                        "status": "draft",
                        "title": "Draft",
                        "currency": "USD",
                        "subtotal": 20,
                        "quotePayloadJson": {"notes": None},
                    }
                ],
                [
                    {
                        "id": "quote-draft",
                        "prospectId": "prospect-1",
                        "salesRepId": "rep-1",
                        "revisionNumber": 2,
                        "status": "draft",
                        "title": "New Draft",
                        "currency": "USD",
                        "subtotal": 55,
                        "quotePayloadJson": {"notes": None},
                    }
                ],
            ],
        ), patch.object(
            service,
            "_resolve_sales_rep_snapshot",
            return_value={"id": "rep-1", "name": "Rep One", "email": "rep@example.com"},
        ), patch.object(
            service.sales_prospect_quote_repository,
            "upsert",
            side_effect=lambda quote: upserts.append(quote) or {**quote, "id": quote.get("id") or "quote-draft"},
        ):
            result = service.import_cart_to_prospect_quote(
                identifier="doctor-1",
                user={"id": "rep-1", "role": "sales_rep", "name": "Rep One", "email": "rep@example.com"},
                payload={
                    "title": "New Draft",
                    "pricingMode": "wholesale",
                    "currency": "USD",
                    "subtotal": 55,
                    "items": [
                        {"productId": "prod-1", "name": "Item", "quantity": 2, "unitPrice": 27.5, "lineTotal": 55}
                    ],
                },
            )

        self.assertEqual(len(upserts), 1)
        self.assertEqual(upserts[0]["id"], "quote-draft")
        self.assertEqual(upserts[0]["revisionNumber"], 2)
        self.assertEqual(result["quote"]["title"], "New Draft")

    def test_export_prospect_quote_marks_draft_exported_before_rendering(self) -> None:
        upserts = []
        render_calls = []

        with patch.object(
            service,
            "_resolve_scoped_prospect_access",
            return_value={
                "identifier": "doctor-1",
                "prospect": {
                    "id": "prospect-1",
                    "salesRepId": "rep-1",
                    "contactName": "Example Lead",
                    "contactEmail": "example@lead.com",
                },
                "salesRepId": "rep-1",
            },
        ), patch.object(
            service.sales_prospect_quote_repository,
            "find_by_id",
            return_value={
                "id": "quote-draft",
                "prospectId": "prospect-1",
                "salesRepId": "rep-1",
                "revisionNumber": 1,
                "status": "draft",
                "title": "Quote",
                "currency": "USD",
                "subtotal": 50,
                "quotePayloadJson": {"prospect": {"identifier": "doctor-1"}, "items": []},
            },
        ), patch.object(
            service.sales_prospect_quote_repository,
            "upsert",
            side_effect=lambda quote: upserts.append(quote) or quote,
        ), patch.object(
            service,
            "generate_prospect_quote_pdf",
            side_effect=lambda quote: render_calls.append(quote)
            or {
                "pdf": b"%PDF-1.4 mock",
                "filename": "PepPro_Quote_Example_Lead_1.pdf",
                "diagnostics": {"renderer": "node_worker", "totalMs": 123.4},
            },
        ):
            result = service.export_prospect_quote(
                identifier="doctor-1",
                quote_id="quote-draft",
                user={"id": "rep-1", "role": "sales_rep"},
            )

        self.assertEqual(len(upserts), 1)
        self.assertEqual(upserts[0]["status"], "exported")
        self.assertEqual(result["filename"], "PepPro_Quote_Example_Lead_1.pdf")
        self.assertEqual(render_calls[0]["quotePayloadJson"]["prospect"]["contactName"], "Example Lead")
        self.assertEqual(result["diagnostics"]["pdf"]["renderer"], "node_worker")

    def test_delete_prospect_quote_removes_scoped_quote(self) -> None:
        deleted_ids = []

        with patch.object(
            service,
            "_resolve_scoped_prospect_access",
            return_value={
                "identifier": "doctor-1",
                "prospect": {"id": "prospect-1", "salesRepId": "rep-1"},
                "salesRepId": "rep-1",
            },
        ), patch.object(
            service.sales_prospect_quote_repository,
            "find_by_id",
            return_value={
                "id": "quote-2",
                "prospectId": "prospect-1",
                "salesRepId": "rep-1",
                "revisionNumber": 2,
                "status": "exported",
                "title": "Quote",
                "currency": "USD",
                "subtotal": 40,
            },
        ), patch.object(
            service.sales_prospect_quote_repository,
            "delete_by_id",
            side_effect=lambda quote_id: deleted_ids.append(quote_id) or True,
        ):
            result = service.delete_prospect_quote(
                identifier="doctor-1",
                quote_id="quote-2",
                user={"id": "rep-1", "role": "sales_rep"},
            )

        self.assertEqual(deleted_ids, ["quote-2"])
        self.assertEqual(result, {"deleted": True, "quoteId": "quote-2"})


if __name__ == "__main__":
    unittest.main()
