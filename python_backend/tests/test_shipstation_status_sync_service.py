import os
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


class ShipStationStatusSyncServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import shipstation_status_sync_service

        cls.service = shipstation_status_sync_service

    def test_interval_clamps_to_thirty_second_minimum(self):
        with patch.dict(os.environ, {"SHIPSTATION_STATUS_SYNC_INTERVAL_SECONDS": "10"}, clear=False):
            self.assertEqual(self.service._interval_seconds(), 30)

    def test_interval_ms_override_respects_thirty_second_minimum(self):
        with patch.dict(os.environ, {"SHIPSTATION_STATUS_SYNC_INTERVAL_MS": "5000"}, clear=False):
            self.assertEqual(self.service._interval_seconds(), 30)

    def test_persist_local_order_shipping_update_sends_shipped_notification_once(self):
        local_order = {
            "id": "local-1505",
            "wooOrderId": "9505",
            "wooOrderNumber": "1505",
            "trackingNumber": None,
            "shippingEstimate": {"status": "label_created"},
            "integrations": {},
        }
        shipstation_info = {
            "status": "shipped",
            "trackingNumber": "1ZSHIP1505",
            "carrierCode": "ups",
            "serviceCode": "ups_2nd_day_air_am",
            "shipDate": "2026-04-15T12:00:00Z",
        }

        with patch.object(self.service.order_repository, "find_by_order_identifier", return_value=local_order), \
            patch.object(self.service.order_repository, "update", return_value={**local_order, "id": "local-1505"}), \
            patch.object(self.service.shipping_notification_service, "notify_customer_order_shipping_status") as notify_status:
            self.service._persist_local_order_shipping_update("9505", shipstation_info)

        notify_status.assert_called_once_with("local-1505", "shipped")


if __name__ == "__main__":
    unittest.main()
