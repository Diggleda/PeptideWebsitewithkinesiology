import sys
import types
import unittest
from unittest.mock import patch

if "requests" not in sys.modules:
    requests = types.ModuleType("requests")
    requests_auth = types.ModuleType("requests.auth")

    class HTTPBasicAuth:
        def __init__(self, *_args, **_kwargs):
            pass

    requests.RequestException = Exception
    requests.HTTPError = Exception
    requests.auth = requests_auth
    requests_auth.HTTPBasicAuth = HTTPBasicAuth
    sys.modules["requests"] = requests
    sys.modules["requests.auth"] = requests_auth

if "pymysql" not in sys.modules:
    pymysql_stub = types.ModuleType("pymysql")
    pymysql_stub.connect = lambda *args, **kwargs: None
    pymysql_stub.connections = types.SimpleNamespace(Connection=object)
    pymysql_stub.err = types.SimpleNamespace(
        Error=Exception,
        OperationalError=Exception,
        InterfaceError=Exception,
    )
    cursors_stub = types.ModuleType("pymysql.cursors")
    cursors_stub.DictCursor = object
    pymysql_stub.cursors = cursors_stub
    sys.modules["pymysql"] = pymysql_stub
    sys.modules["pymysql.cursors"] = cursors_stub

if "python_backend.storage" not in sys.modules:
    storage_stub = types.ModuleType("python_backend.storage")
    storage_stub.order_store = None
    sys.modules["python_backend.storage"] = storage_stub

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


class TestUpsStatusSyncService(unittest.TestCase):
    def test_fetch_orders_for_sync_filters_non_ups_terminal_and_delivered_orders(self):
        from python_backend.services import ups_status_sync_service as svc

        orders = [
            {
                "id": "ups-1",
                "trackingNumber": "1ZTEST001",
                "shippingCarrier": "ups",
                "status": "processing",
                "createdAt": "2026-04-01T12:00:00Z",
            },
            {
                "id": "ups-2",
                "trackingNumber": "1ZTEST002",
                "shippingCarrier": "ups",
                "upsTrackingStatus": "delivered",
                "status": "processing",
                "createdAt": "2026-04-01T12:00:00Z",
            },
            {
                "id": "fedex-1",
                "trackingNumber": "999999",
                "shippingCarrier": "fedex",
                "status": "processing",
                "createdAt": "2026-04-01T12:00:00Z",
            },
            {
                "id": "cancelled-1",
                "trackingNumber": "1ZTEST003",
                "shippingCarrier": "ups",
                "status": "cancelled",
                "createdAt": "2026-04-01T12:00:00Z",
            },
            {
                "id": "hand-1",
                "trackingNumber": "1ZTEST004",
                "shippingCarrier": "ups",
                "status": "processing",
                "handDelivery": True,
                "createdAt": "2026-04-01T12:00:00Z",
            },
        ]

        with patch.object(svc.order_repository, "list_recent", return_value=orders):
            selected = svc._fetch_orders_for_sync(lookback_days=60, max_orders=10)

        self.assertEqual([order["id"] for order in selected], ["ups-1"])

    def test_run_sync_once_updates_persisted_ups_tracking_status(self):
        from python_backend.services import ups_status_sync_service as svc

        candidate_orders = [
            {
                "id": "ups-1",
                "trackingNumber": "1ZTEST001",
                "shippingCarrier": "ups",
                "status": "processing",
                "createdAt": "2026-04-01T12:00:00Z",
            }
        ]

        with patch.object(svc, "_enabled", return_value=True), \
            patch.object(svc.ups_tracking, "is_configured", return_value=True), \
            patch.object(svc, "_try_acquire_lease", return_value="lease-1"), \
            patch.object(svc, "_release_lease"), \
            patch.object(svc, "_get_last_run_at", return_value=None), \
            patch.object(svc, "_set_last_run_at"), \
            patch.object(svc, "_fetch_orders_for_sync", return_value=candidate_orders), \
            patch.object(svc, "_max_runtime_seconds", return_value=45), \
            patch.object(svc, "_throttle_ms", return_value=0), \
            patch.object(svc.ups_tracking, "fetch_tracking_status", return_value={"trackingStatus": "Out for Delivery"}), \
            patch.object(svc.order_repository, "update_ups_tracking_status") as update_status:
            result = svc.run_sync_once(ignore_cooldown=True)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["processed"], 1)
        self.assertEqual(result["updated"], 1)
        update_status.assert_called_once_with(
            "ups-1",
            ups_tracking_status="out_for_delivery",
            delivered_at=None,
            estimated_arrival_date=None,
            delivery_date_guaranteed=None,
            expected_shipment_window=None,
        )

    def test_run_sync_once_persists_delivered_at_for_delivered_orders(self):
        from python_backend.services import ups_status_sync_service as svc

        candidate_orders = [
            {
                "id": "ups-1",
                "trackingNumber": "1ZTEST001",
                "shippingCarrier": "ups",
                "status": "processing",
                "createdAt": "2026-04-01T12:00:00Z",
            }
        ]

        with patch.object(svc, "_enabled", return_value=True), \
            patch.object(svc.ups_tracking, "is_configured", return_value=True), \
            patch.object(svc, "_try_acquire_lease", return_value="lease-1"), \
            patch.object(svc, "_release_lease"), \
            patch.object(svc, "_get_last_run_at", return_value=None), \
            patch.object(svc, "_set_last_run_at"), \
            patch.object(svc, "_fetch_orders_for_sync", return_value=candidate_orders), \
            patch.object(svc, "_max_runtime_seconds", return_value=45), \
            patch.object(svc, "_throttle_ms", return_value=0), \
            patch.object(
                svc.ups_tracking,
                "fetch_tracking_status",
                return_value={"trackingStatus": "Delivered", "deliveredAt": "2026-04-02T10:15:00"},
            ), \
            patch.object(svc.order_repository, "update_ups_tracking_status") as update_status:
            result = svc.run_sync_once(ignore_cooldown=True)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["processed"], 1)
        self.assertEqual(result["updated"], 1)
        update_status.assert_called_once_with(
            "ups-1",
            ups_tracking_status="delivered",
            delivered_at="2026-04-02T10:15:00",
            estimated_arrival_date=None,
            delivery_date_guaranteed=None,
            expected_shipment_window=None,
        )

    def test_run_sync_once_does_not_persist_unknown_ups_status(self):
        from python_backend.services import ups_status_sync_service as svc

        candidate_orders = [
            {
                "id": "ups-1",
                "trackingNumber": "1ZTEST001",
                "shippingCarrier": "ups",
                "status": "processing",
                "createdAt": "2026-04-01T12:00:00Z",
            }
        ]

        with patch.object(svc, "_enabled", return_value=True), \
            patch.object(svc.ups_tracking, "is_configured", return_value=True), \
            patch.object(svc, "_try_acquire_lease", return_value="lease-1"), \
            patch.object(svc, "_release_lease"), \
            patch.object(svc, "_get_last_run_at", return_value=None), \
            patch.object(svc, "_set_last_run_at"), \
            patch.object(svc, "_fetch_orders_for_sync", return_value=candidate_orders), \
            patch.object(svc, "_max_runtime_seconds", return_value=45), \
            patch.object(svc, "_throttle_ms", return_value=0), \
            patch.object(svc.ups_tracking, "fetch_tracking_status", return_value={"trackingStatus": "Unknown"}), \
            patch.object(svc.order_repository, "update_ups_tracking_status") as update_status:
            result = svc.run_sync_once(ignore_cooldown=True)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["processed"], 1)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["missing"], 1)
        update_status.assert_not_called()

    def test_run_sync_once_persists_estimate_when_status_is_unchanged(self):
        from python_backend.services import ups_status_sync_service as svc

        candidate_orders = [
            {
                "id": "ups-2",
                "trackingNumber": "1ZTEST002",
                "shippingCarrier": "ups",
                "status": "processing",
                "upsTrackingStatus": "in_transit",
                "shippingEstimate": {"status": "in_transit", "carrierId": "ups"},
                "createdAt": "2026-04-01T12:00:00Z",
            }
        ]

        with patch.object(svc, "_enabled", return_value=True), \
            patch.object(svc.ups_tracking, "is_configured", return_value=True), \
            patch.object(svc, "_try_acquire_lease", return_value="lease-1"), \
            patch.object(svc, "_release_lease"), \
            patch.object(svc, "_get_last_run_at", return_value=None), \
            patch.object(svc, "_set_last_run_at"), \
            patch.object(svc, "_fetch_orders_for_sync", return_value=candidate_orders), \
            patch.object(svc, "_max_runtime_seconds", return_value=45), \
            patch.object(svc, "_throttle_ms", return_value=0), \
            patch.object(
                svc.ups_tracking,
                "fetch_tracking_status",
                return_value={
                    "trackingStatus": "In Transit",
                    "estimatedArrivalDate": "2026-04-07T18:00:00",
                    "deliveryDateGuaranteed": "2026-04-07T00:00:00",
                    "expectedShipmentWindow": "Tuesday, April 7, 2026, between 2:00 PM - 6:00 PM",
                },
            ), \
            patch.object(svc.order_repository, "update_ups_tracking_status") as update_status:
            result = svc.run_sync_once(ignore_cooldown=True)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["processed"], 1)
        self.assertEqual(result["updated"], 1)
        update_status.assert_called_once_with(
            "ups-2",
            ups_tracking_status="in_transit",
            delivered_at=None,
            estimated_arrival_date="2026-04-07T18:00:00",
            delivery_date_guaranteed="2026-04-07T00:00:00",
            expected_shipment_window="Tuesday, April 7, 2026, between 2:00 PM - 6:00 PM",
        )


if __name__ == "__main__":
    unittest.main()
