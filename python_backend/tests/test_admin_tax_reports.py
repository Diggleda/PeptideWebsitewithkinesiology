import sys
import types
import unittest
from datetime import datetime, timezone
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


class AdminTaxesByStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import order_service

        cls.order_service = order_service

    def setUp(self) -> None:
        self.order_service.invalidate_admin_taxes_by_state_cache()

    def test_get_taxes_by_state_reads_local_orders_instead_of_woo(self):
        service = self.order_service
        local_orders = [
            {
                "id": "101",
                "wooOrderId": 101,
                "wooOrderNumber": "1501",
                "status": "processing",
                "createdAt": "2026-04-10T12:00:00+00:00",
                "shippingAddress": {"state": "CA"},
                "billingAddress": {},
                "taxTotal": 5.25,
                "total": 10.0,
                "grandTotal": 10.0,
            },
            {
                "id": "102",
                "wooOrderId": 102,
                "wooOrderNumber": "1502",
                "status": "completed",
                "createdAt": "2026-04-11T12:00:00+00:00",
                "shippingAddress": {},
                "billingAddress": {"state": "NV"},
                "taxTotal": 2.50,
                "total": 20.0,
                "grandTotal": 20.0,
            },
        ]

        with patch.object(service.order_repository, "list_for_tax_reporting", return_value=local_orders) as list_mock, patch.object(
            service.woo_commerce,
            "fetch_catalog_proxy",
            side_effect=AssertionError("Woo should not be used for taxes-by-state"),
        ), patch.object(
            service.tax_tracking_service,
            "get_tax_tracking_snapshot",
            return_value={"rows": [], "summary": {}},
        ), patch.object(service.time, "time", return_value=1_776_280_000):
            result = service.get_taxes_by_state_for_admin(period_start="2026-04-01", period_end="2026-04-15")

        list_mock.assert_called_once()
        self.assertEqual(result["totals"]["orderCount"], 2)
        self.assertEqual(result["totals"]["taxTotal"], 7.75)
        self.assertEqual([row["stateCode"] for row in result["rows"]], ["CA", "NV"])
        self.assertEqual(
            [(line["orderNumber"], line["taxTotal"], line["taxSource"]) for line in result["orderTaxes"]],
            [("1501", 5.25, "local:taxTotal"), ("1502", 2.5, "local:taxTotal")],
        )


class TaxTrackingSnapshotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import tax_tracking_service

        cls.tax_tracking_service = tax_tracking_service

    def setUp(self) -> None:
        self.tax_tracking_service.invalidate_tax_tracking_cache()

    def test_fetch_trailing_metrics_reads_local_orders_instead_of_woo(self):
        service = self.tax_tracking_service
        start_dt = datetime(2026, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        end_dt = datetime(2026, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        local_orders = [
            {
                "id": "201",
                "status": "processing",
                "createdAt": "2026-06-01T00:00:00+00:00",
                "shippingAddress": {"state": "CA"},
                "billingAddress": {},
                "total": 10.0,
                "grandTotal": 10.0,
                "taxTotal": 0.0,
            },
            {
                "id": "202",
                "status": "completed",
                "createdAt": "2026-06-02T00:00:00+00:00",
                "shippingAddress": {},
                "billingAddress": {"state": "NV"},
                "total": 20.0,
                "grandTotal": 20.0,
                "taxTotal": 0.0,
            },
        ]

        with patch.object(
            service,
            "_rolling_twelve_month_bounds",
            return_value=(start_dt, end_dt, 2026, start_dt.isoformat(), end_dt.isoformat()),
        ), patch.object(service.order_repository, "list_for_tax_reporting", return_value=local_orders) as list_mock:
            metrics, tracking_year, period_start, period_end = service._fetch_trailing_twelve_month_metrics()

        list_mock.assert_called_once_with(start_dt, end_dt)
        self.assertEqual(tracking_year, 2026)
        self.assertEqual(period_start, start_dt.isoformat())
        self.assertEqual(period_end, end_dt.isoformat())
        self.assertEqual(metrics["CA"]["trailing12MonthRevenueUsd"], 10.0)
        self.assertEqual(metrics["CA"]["trailing12MonthTransactionCount"], 1)
        self.assertEqual(metrics["NV"]["trailing12MonthRevenueUsd"], 20.0)
        self.assertEqual(metrics["NV"]["trailing12MonthTransactionCount"], 1)


if __name__ == "__main__":
    unittest.main()
