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
        original_find_by_identifier = service.order_repository.find_by_order_identifier
        original_update = service.order_repository.update
        original_find_by_woo_id = service._find_order_by_woo_id
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
            service.order_repository.find_by_order_identifier = lambda _value: None
            service.order_repository.update = lambda value: persisted.append(dict(value)) or value
            service._find_order_by_woo_id = lambda _value: None
            service.storage.order_store = None

            service._enrich_with_shipstation(order)

            self.assertEqual(order["shippingEstimate"]["status"], "delivered")
            self.assertEqual(persisted[-1]["shippingEstimate"]["status"], "delivered")
        finally:
            service.ship_station.fetch_order_status = original_shipstation
            service.order_repository.find_by_id = original_find_by_id
            service.order_repository.find_by_order_identifier = original_find_by_identifier
            service.order_repository.update = original_update
            service._find_order_by_woo_id = original_find_by_woo_id
            service.storage.order_store = original_order_store

    def test_enrich_with_shipstation_persists_status_to_resolved_local_order(self):
        service = self.order_service
        original_shipstation = service.ship_station.fetch_order_status
        original_find_by_id = service.order_repository.find_by_id
        original_find_by_identifier = service.order_repository.find_by_order_identifier
        original_update = service.order_repository.update
        original_find_by_woo_id = service._find_order_by_woo_id
        original_order_store = service.storage.order_store
        try:
            order = {
                "id": "9002",
                "number": "1492",
                "wooOrderNumber": "1492",
                "trackingNumber": "1ZTEST002",
                "shippingEstimate": {"carrierId": "ups"},
            }
            local_order = {
                "id": "local-1492",
                "wooOrderId": "9002",
                "wooOrderNumber": "1492",
                "trackingNumber": "1ZTEST002",
                "shippingEstimate": {"carrierId": "ups"},
            }
            persisted = []

            service.ship_station.fetch_order_status = lambda _order_number: {
                "status": "shipped",
                "trackingStatus": "In Transit",
                "trackingNumber": "1ZTEST002",
                "carrierCode": "ups",
                "serviceCode": "ups_2nd_day_air",
                "shipDate": "2026-04-03",
                "orderNumber": "1492",
                "orderId": "9002",
            }
            service.order_repository.find_by_id = lambda value: local_order if str(value) == "local-1492" else None
            service.order_repository.find_by_order_identifier = (
                lambda value: local_order if str(value) in {"1492", "9002"} else None
            )
            service.order_repository.update = lambda value: persisted.append(dict(value)) or value
            service._find_order_by_woo_id = lambda value: local_order if str(value) in {"1492", "9002"} else None
            service.storage.order_store = None

            service._enrich_with_shipstation(order)

            self.assertTrue(persisted)
            self.assertEqual(persisted[-1]["id"], "local-1492")
            self.assertEqual(persisted[-1]["shippingEstimate"]["status"], "in_transit")
            self.assertEqual(persisted[-1]["integrationDetails"]["shipStation"]["trackingStatus"], "In Transit")
        finally:
            service.ship_station.fetch_order_status = original_shipstation
            service.order_repository.find_by_id = original_find_by_id
            service.order_repository.find_by_order_identifier = original_find_by_identifier
            service.order_repository.update = original_update
            service._find_order_by_woo_id = original_find_by_woo_id
            service.storage.order_store = original_order_store

    def test_refresh_ups_status_resolves_local_order_by_hash_prefixed_woo_number(self):
        service = self.order_service
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_update_ups_status = service.order_repository.update_ups_tracking_status
        original_fetch_tracking_status = service.ups_tracking.fetch_tracking_status
        try:
            lookups = []

            service.order_repository.find_by_order_identifier = lambda value: (
                lookups.append(str(value))
                or (
                    {
                        "id": "local-ups-1396",
                        "wooOrderNumber": "#1396",
                        "trackingNumber": "1ZTEST1396",
                        "shippingCarrier": "ups",
                        "shippingEstimate": {"status": "in_transit", "carrierId": "ups"},
                    }
                    if str(value) == "#1396"
                    else None
                )
            )
            persisted = []
            service.order_repository.update_ups_tracking_status = (
                lambda order_id, *, ups_tracking_status, delivered_at=None, estimated_arrival_date=None, delivery_date_guaranteed=None, expected_shipment_window=None: persisted.append((order_id, ups_tracking_status, delivered_at)) or {
                    "id": order_id,
                    "wooOrderNumber": "#1396",
                    "trackingNumber": "1ZTEST1396",
                    "upsTrackingStatus": ups_tracking_status,
                    "upsDeliveredAt": delivered_at,
                    "shippingEstimate": {
                        "status": ups_tracking_status,
                        "carrierId": "ups",
                        **({"deliveredAt": delivered_at} if delivered_at else {}),
                    },
                }
            )
            service.ups_tracking.fetch_tracking_status = lambda _tracking_number: {
                "carrier": "ups",
                "trackingNumber": "1ZTEST1396",
                "trackingStatus": "Delivered",
                "trackingStatusRaw": "Delivered",
                "deliveredAt": "2026-04-02T10:15:00",
            }

            order = {
                "id": "1396",
                "number": "1396",
                "wooOrderNumber": "1396",
                "trackingNumber": "1ZTEST1396",
                "shippingCarrier": "ups",
                "shippingEstimate": {"carrierId": "ups"},
            }

            refreshed = service._refresh_authoritative_ups_status_for_order_view(order, local_order=None)

            self.assertEqual(persisted, [("local-ups-1396", "delivered", "2026-04-02T10:15:00")])
            self.assertIn("1396", lookups)
            self.assertIn("#1396", lookups)
            self.assertEqual(order["upsTrackingStatus"], "delivered")
            self.assertEqual(order["shippingEstimate"]["status"], "delivered")
            self.assertEqual(order["shippingEstimate"]["deliveredAt"], "2026-04-02T10:15:00")
            self.assertEqual(refreshed["upsTrackingStatus"], "delivered")
            self.assertEqual(refreshed["shippingEstimate"]["deliveredAt"], "2026-04-02T10:15:00")
        finally:
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.update_ups_tracking_status = original_update_ups_status
            service.ups_tracking.fetch_tracking_status = original_fetch_tracking_status

    def test_refresh_ups_status_does_not_overwrite_known_status_with_unknown(self):
        service = self.order_service
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_update_ups_status = service.order_repository.update_ups_tracking_status
        original_fetch_tracking_status = service.ups_tracking.fetch_tracking_status
        try:
            local_order = {
                "id": "local-ups-2001",
                "wooOrderNumber": "#2001",
                "trackingNumber": "1ZTEST2001",
                "shippingCarrier": "ups",
                "upsTrackingStatus": "in_transit",
                "shippingEstimate": {"status": "in_transit", "carrierId": "ups"},
            }
            persisted = []

            service.order_repository.find_by_order_identifier = lambda value: local_order if str(value) in {"2001", "#2001"} else None
            service.order_repository.update_ups_tracking_status = (
                lambda order_id, *, ups_tracking_status, delivered_at=None, estimated_arrival_date=None, delivery_date_guaranteed=None, expected_shipment_window=None: persisted.append((order_id, ups_tracking_status, delivered_at)) or local_order
            )
            service.ups_tracking.fetch_tracking_status = lambda _tracking_number: {
                "carrier": "ups",
                "trackingNumber": "1ZTEST2001",
                "trackingStatus": "Unknown",
                "trackingStatusRaw": "Unknown",
            }

            order = {
                "id": "2001",
                "wooOrderNumber": "2001",
                "trackingNumber": "1ZTEST2001",
                "shippingCarrier": "ups",
                "upsTrackingStatus": "in_transit",
                "shippingEstimate": {"status": "in_transit", "carrierId": "ups"},
            }

            refreshed = service._refresh_authoritative_ups_status_for_order_view(order, local_order=local_order)

            self.assertEqual(persisted, [])
            self.assertEqual(order["upsTrackingStatus"], "in_transit")
            self.assertEqual(order["shippingEstimate"]["status"], "in_transit")
            self.assertEqual(refreshed["upsTrackingStatus"], "in_transit")
        finally:
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.update_ups_tracking_status = original_update_ups_status
            service.ups_tracking.fetch_tracking_status = original_fetch_tracking_status

    def test_refresh_ups_status_persists_estimate_when_status_is_unchanged(self):
        service = self.order_service
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_update_ups_status = service.order_repository.update_ups_tracking_status
        original_fetch_tracking_status = service.ups_tracking.fetch_tracking_status
        try:
            local_order = {
                "id": "local-ups-2002",
                "wooOrderNumber": "#2002",
                "trackingNumber": "1ZTEST2002",
                "shippingCarrier": "ups",
                "upsTrackingStatus": "in_transit",
                "shippingEstimate": {"status": "in_transit", "carrierId": "ups"},
            }
            persisted = []

            service.order_repository.find_by_order_identifier = lambda value: local_order if str(value) in {"2002", "#2002"} else None
            service.order_repository.update_ups_tracking_status = (
                lambda order_id, *, ups_tracking_status, delivered_at=None, estimated_arrival_date=None, delivery_date_guaranteed=None, expected_shipment_window=None: (
                    persisted.append(
                        (
                            order_id,
                            ups_tracking_status,
                            delivered_at,
                            estimated_arrival_date,
                            delivery_date_guaranteed,
                            expected_shipment_window,
                        )
                    )
                    or {
                        **local_order,
                        "upsTrackingStatus": ups_tracking_status,
                        "shippingEstimate": {
                            "status": ups_tracking_status,
                            "carrierId": "ups",
                            **({"estimatedArrivalDate": estimated_arrival_date} if estimated_arrival_date else {}),
                            **({"deliveryDateGuaranteed": delivery_date_guaranteed} if delivery_date_guaranteed else {}),
                        },
                        "expectedShipmentWindow": expected_shipment_window,
                    }
                )
            )
            service.ups_tracking.fetch_tracking_status = lambda _tracking_number: {
                "carrier": "ups",
                "trackingNumber": "1ZTEST2002",
                "trackingStatus": "In Transit",
                "trackingStatusRaw": "On the Way",
                "estimatedArrivalDate": "2026-04-07T18:00:00",
                "deliveryDateGuaranteed": "2026-04-07T00:00:00",
                "expectedShipmentWindow": "Tuesday, April 7, 2026, between 2:00 PM - 6:00 PM",
            }

            order = {
                "id": "2002",
                "wooOrderNumber": "2002",
                "trackingNumber": "1ZTEST2002",
                "shippingCarrier": "ups",
                "upsTrackingStatus": "in_transit",
                "shippingEstimate": {"status": "in_transit", "carrierId": "ups"},
            }

            refreshed = service._refresh_authoritative_ups_status_for_order_view(order, local_order=local_order)

            self.assertEqual(
                persisted,
                [
                    (
                        "local-ups-2002",
                        "in_transit",
                        None,
                        "2026-04-07T18:00:00",
                        "2026-04-07T00:00:00",
                        "Tuesday, April 7, 2026, between 2:00 PM - 6:00 PM",
                    )
                ],
            )
            self.assertEqual(order["shippingEstimate"]["estimatedArrivalDate"], "2026-04-07T18:00:00")
            self.assertEqual(order["shippingEstimate"]["deliveryDateGuaranteed"], "2026-04-07T00:00:00")
            self.assertEqual(
                order["expectedShipmentWindow"],
                "Tuesday, April 7, 2026, between 2:00 PM - 6:00 PM",
            )
            self.assertEqual(refreshed["shippingEstimate"]["estimatedArrivalDate"], "2026-04-07T18:00:00")
        finally:
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.update_ups_tracking_status = original_update_ups_status
            service.ups_tracking.fetch_tracking_status = original_fetch_tracking_status


if __name__ == "__main__":
    unittest.main()
