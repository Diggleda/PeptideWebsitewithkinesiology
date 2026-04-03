import sys
import types
import unittest


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


class OrderServiceUpsStatusRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import order_service

        cls.order_service = order_service

    def test_enrich_with_shipstation_keeps_authoritative_ups_status(self):
        service = self.order_service
        original_shipstation = service.ship_station.fetch_order_status
        original_find_by_id = service.order_repository.find_by_id
        original_update = service.order_repository.update
        original_order_store = service.storage.order_store
        try:
            order = {
                "id": "order-1",
                "number": "1491",
                "trackingNumber": "1ZTEST001",
                "upsTrackingStatus": "delivered",
                "shippingEstimate": {"status": "delivered"},
            }
            persisted = []

            service.ship_station.fetch_order_status = lambda _order_number: {
                "status": "shipped",
                "trackingNumber": "1ZTEST001",
                "carrierCode": "ups",
                "shipDate": "2026-04-02",
            }
            service.order_repository.find_by_id = lambda _order_id: {
                "id": "order-1",
                "trackingNumber": "1ZTEST001",
                "upsTrackingStatus": "delivered",
                "shippingEstimate": {"status": "delivered"},
            }
            service.order_repository.update = lambda value: persisted.append(dict(value)) or value
            service.storage.order_store = None

            service._enrich_with_shipstation(order)

            self.assertEqual(order["shippingEstimate"]["status"], "delivered")
            self.assertEqual(persisted[-1]["shippingEstimate"]["status"], "delivered")
        finally:
            service.ship_station.fetch_order_status = original_shipstation
            service.order_repository.find_by_id = original_find_by_id
            service.order_repository.update = original_update
            service.storage.order_store = original_order_store


if __name__ == "__main__":
    unittest.main()
