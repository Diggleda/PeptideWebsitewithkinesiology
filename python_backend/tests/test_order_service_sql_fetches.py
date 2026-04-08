import sys
import types
import unittest
from unittest.mock import patch


def _install_test_stubs() -> None:
    if "flask" not in sys.modules:
        flask = types.ModuleType("flask")

        class Response:
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


class OrderServiceSqlFetchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import order_service

        cls.order_service = order_service

    def test_get_orders_for_user_skips_woo_and_returns_local_payload(self):
        service = self.order_service
        local_order = {
            "id": "order-1",
            "userId": "doctor-1",
            "wooOrderId": "9001",
            "wooOrderNumber": "1491",
            "status": "processing",
            "grandTotal": 125.0,
            "itemsSubtotal": 100.0,
            "taxTotal": 10.0,
            "shippingTotal": 15.0,
            "currency": "USD",
            "createdAt": "2026-04-08T00:00:00+00:00",
            "items": [{"name": "Test Item", "quantity": 1}],
        }

        with patch.object(
            service.user_repository,
            "find_by_id",
            return_value={"id": "doctor-1", "email": "doctor@example.com"},
        ), patch.object(
            service.order_repository,
            "list_user_overlay_fields",
            return_value=[local_order],
        ), patch.object(
            service,
            "_enrich_with_shipstation",
            side_effect=lambda order: order,
        ) as mock_enrich, patch.object(
            service.woo_commerce,
            "fetch_orders_by_email",
            side_effect=AssertionError("user order fetch should be SQL-only"),
        ) as mock_fetch:
            result = service.get_orders_for_user("doctor-1")

        mock_fetch.assert_not_called()
        mock_enrich.assert_called_once()
        self.assertEqual(result["woo"], [])
        self.assertIsNone(result["wooError"])
        self.assertEqual(len(result["local"]), 1)
        self.assertEqual(result["local"][0]["source"], "peppro")
        self.assertEqual(result["local"][0]["wooOrderNumber"], "1491")

    def test_get_orders_for_sales_rep_skips_woo_and_uses_local_orders(self):
        service = self.order_service
        doctor = {
            "id": "doctor-1",
            "name": "Doctor One",
            "email": "doctor@example.com",
            "role": "doctor",
            "salesRepId": "rep-1",
        }
        rep = {"id": "rep-1", "name": "Rep One", "email": "rep@example.com"}
        local_order = {
            "id": "order-1",
            "userId": "doctor-1",
            "wooOrderId": "9001",
            "wooOrderNumber": "1491",
            "status": "processing",
            "grandTotal": 125.0,
            "taxTotal": 10.0,
            "shippingTotal": 15.0,
            "currency": "USD",
            "pricingMode": "wholesale",
            "createdAt": "2026-04-08T00:00:00+00:00",
            "items": [{"name": "Test Item", "quantity": 1}],
            "doctorSalesRepId": "rep-1",
        }

        with patch.object(
            service.user_repository,
            "get_all",
            return_value=[doctor],
        ), patch.object(
            service.sales_rep_repository,
            "get_all",
            return_value=[rep],
        ), patch.object(
            service.referral_service,
            "backfill_lead_types_for_doctors",
            return_value=[doctor],
        ), patch.object(
            service.sales_prospect_repository,
            "get_all",
            return_value=[],
        ), patch.object(
            service.order_repository,
            "find_by_user_ids",
            return_value=[local_order],
        ), patch.object(
            service.order_repository,
            "list_recent_sales_tracking",
            return_value=[],
        ), patch.object(
            service.sales_prospect_repository,
            "mark_doctor_as_nurturing_if_purchased",
            return_value=None,
        ), patch.object(
            service,
            "_enrich_with_shipstation",
            side_effect=lambda order: order,
        ) as mock_enrich, patch.object(
            service.woo_commerce,
            "fetch_catalog_proxy",
            side_effect=AssertionError("sales rep order fetch should be SQL-only"),
        ) as mock_fetch:
            result = service.get_orders_for_sales_rep("rep-1")

        mock_fetch.assert_not_called()
        mock_enrich.assert_called_once()
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["source"], "peppro")
        self.assertEqual(result[0]["doctorId"], "doctor-1")
        self.assertEqual(result[0]["doctorSalesRepId"], "rep-1")


if __name__ == "__main__":
    unittest.main()
