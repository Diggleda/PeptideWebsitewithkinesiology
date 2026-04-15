import sys
import types
import unittest
import json
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


class SalesRepOrderDetailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import order_service

        cls.order_service = order_service

    def test_detail_uses_local_sql_order_without_live_woo_lookup(self):
        service = self.order_service
        original_is_configured = service.woo_commerce.is_configured
        original_fetch_order = service.woo_commerce.fetch_order
        original_fetch_by_number = service.woo_commerce.fetch_order_by_number
        original_invoice_url = service.woo_commerce._build_invoice_url
        original_shipstation = service.ship_station.fetch_order_status
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_find_by_id = service.order_repository.find_by_id
        original_find_email = service.user_repository.find_by_email
        original_find_user_by_id = service.user_repository.find_by_id
        try:
            fetch_calls = []
            local_order = {
                "id": "local-1491",
                "userId": "doctor-1",
                "wooOrderId": "9001",
                "wooOrderNumber": "1491",
                "shippingAddress": {
                    "name": "Jennifer Ellen Blankenship",
                    "addressLine1": "123 Main St",
                    "city": "Nashville",
                    "state": "TN",
                    "postalCode": "37201",
                    "country": "US",
                    "email": "jen@example.com",
                },
                "billingAddress": {
                    "name": "Jennifer Ellen Blankenship",
                    "addressLine1": "123 Main St",
                    "city": "Nashville",
                    "state": "TN",
                    "postalCode": "37201",
                    "country": "US",
                    "email": "jen@example.com",
                },
                "paymentMethod": "bacs",
                "status": "on-hold",
            }

            service.woo_commerce.is_configured = lambda: True
            service.woo_commerce._build_invoice_url = lambda *_args, **_kwargs: None

            def fake_fetch_order(candidate):
                fetch_calls.append(str(candidate))
                return None

            service.woo_commerce.fetch_order = fake_fetch_order
            service.woo_commerce.fetch_order_by_number = lambda _candidate: None
            service.ship_station.fetch_order_status = lambda _order_number: None
            service.order_repository.find_by_order_identifier = lambda value: local_order if str(value) in {"1491", "9001"} else None
            service.order_repository.find_by_id = lambda value: local_order if str(value) == "local-1491" else None
            service.user_repository.find_by_email = lambda _email: None
            service.user_repository.find_by_id = (
                lambda value: {
                    "id": "doctor-1",
                    "name": "Jennifer Ellen Blankenship",
                    "email": "jen@example.com",
                    "salesRepId": "rep-1",
                }
                if str(value) == "doctor-1"
                else None
            )

            result = service.get_sales_rep_order_detail("1491", "admin-1", token_role="admin")

            self.assertEqual(fetch_calls, [])
            self.assertEqual(result["doctorId"], "doctor-1")
            self.assertEqual(result["doctorEmail"], "jen@example.com")
            self.assertEqual(result["shippingAddress"]["addressLine1"], "123 Main St")
            self.assertEqual(result["billingAddress"]["addressLine1"], "123 Main St")
            self.assertEqual(result["billingEmail"], "jen@example.com")
            self.assertEqual(result["paymentMethod"], "bacs")
            self.assertEqual(result["paymentDetails"], "bacs")
            self.assertEqual(result["number"], "1491")
            self.assertEqual(result["wooOrderId"], "9001")
        finally:
            service.woo_commerce.is_configured = original_is_configured
            service.woo_commerce.fetch_order = original_fetch_order
            service.woo_commerce.fetch_order_by_number = original_fetch_by_number
            service.woo_commerce._build_invoice_url = original_invoice_url
            service.ship_station.fetch_order_status = original_shipstation
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.find_by_id = original_find_by_id
            service.user_repository.find_by_email = original_find_email
            service.user_repository.find_by_id = original_find_user_by_id

    def test_detail_refreshes_local_only_ups_status_from_live_tracking(self):
        service = self.order_service
        original_is_configured = service.woo_commerce.is_configured
        original_fetch_order = service.woo_commerce.fetch_order
        original_fetch_by_number = service.woo_commerce.fetch_order_by_number
        original_invoice_url = service.woo_commerce._build_invoice_url
        original_shipstation = service.ship_station.fetch_order_status
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_find_by_id = service.order_repository.find_by_id
        original_update_ups_status = service.order_repository.update_ups_tracking_status
        original_fetch_tracking_status = service.ups_tracking.fetch_tracking_status
        original_find_email = service.user_repository.find_by_email
        original_find_user_by_id = service.user_repository.find_by_id
        try:
            local_order = {
                "id": "local-ups-1492",
                "userId": "doctor-1",
                "wooOrderId": "9002",
                "wooOrderNumber": "1492",
                "trackingNumber": "1ZTEST001",
                "shippingCarrier": "ups",
                "shippingEstimate": {"status": "in_transit", "carrierId": "ups"},
                "upsTrackingStatus": "in_transit",
                "status": "completed",
            }
            persisted_updates = []

            service.woo_commerce.is_configured = lambda: True
            service.woo_commerce._build_invoice_url = lambda *_args, **_kwargs: None
            service.woo_commerce.fetch_order = lambda candidate: {
                "id": 9002,
                "number": "1492",
            } if str(candidate) == "9002" else None
            service.woo_commerce.fetch_order_by_number = lambda _candidate: None
            service.ship_station.fetch_order_status = lambda _order_number: None
            service.order_repository.find_by_order_identifier = lambda value: local_order if str(value) in {"1492", "9002"} else None
            service.order_repository.find_by_id = lambda value: local_order if str(value) == "local-ups-1492" else None
            service.order_repository.update_ups_tracking_status = (
                lambda order_id, *, ups_tracking_status, delivered_at=None, estimated_arrival_date=None, delivery_date_guaranteed=None, expected_shipment_window=None: persisted_updates.append((order_id, ups_tracking_status, delivered_at)) or {
                    **local_order,
                    "upsTrackingStatus": ups_tracking_status,
                    "upsDeliveredAt": delivered_at,
                    "shippingEstimate": {
                        "status": ups_tracking_status,
                        "carrierId": "ups",
                        **({"deliveredAt": delivered_at} if delivered_at else {}),
                    },
                }
            )
            service.ups_tracking.fetch_tracking_status = lambda tracking_number: {
                "carrier": "ups",
                "trackingNumber": tracking_number,
                "trackingStatus": "Delivered",
                "trackingStatusRaw": "Delivered",
                "deliveredAt": "2026-04-02T10:15:00",
            }
            service.user_repository.find_by_email = lambda _email: None
            service.user_repository.find_by_id = (
                lambda value: {
                    "id": "doctor-1",
                    "name": "Jennifer Ellen Blankenship",
                    "email": "jen@example.com",
                    "salesRepId": "rep-1",
                }
                if str(value) == "doctor-1"
                else None
            )

            result = service.get_sales_rep_order_detail("1492", "admin-1", token_role="admin")

            self.assertEqual(
                persisted_updates,
                [("local-ups-1492", "delivered", "2026-04-02T10:15:00")],
            )
            self.assertEqual(result["upsTrackingStatus"], "delivered")
            self.assertEqual(result["shippingEstimate"]["status"], "delivered")
            self.assertEqual(result["trackingNumber"], "1ZTEST001")
        finally:
            service.woo_commerce.is_configured = original_is_configured
            service.woo_commerce.fetch_order = original_fetch_order
            service.woo_commerce.fetch_order_by_number = original_fetch_by_number
            service.woo_commerce._build_invoice_url = original_invoice_url
            service.ship_station.fetch_order_status = original_shipstation
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.find_by_id = original_find_by_id
            service.order_repository.update_ups_tracking_status = original_update_ups_status
            service.ups_tracking.fetch_tracking_status = original_fetch_tracking_status
            service.user_repository.find_by_email = original_find_email
            service.user_repository.find_by_id = original_find_user_by_id

    def test_detail_keeps_shipstation_tracking_when_local_tracking_is_blank(self):
        service = self.order_service
        original_is_configured = service.woo_commerce.is_configured
        original_fetch_order = service.woo_commerce.fetch_order
        original_fetch_by_number = service.woo_commerce.fetch_order_by_number
        original_invoice_url = service.woo_commerce._build_invoice_url
        original_shipstation = service.ship_station.fetch_order_status
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_find_by_id = service.order_repository.find_by_id
        original_update = service.order_repository.update
        original_update_ups_status = service.order_repository.update_ups_tracking_status
        original_fetch_tracking_status = service.ups_tracking.fetch_tracking_status
        original_find_email = service.user_repository.find_by_email
        original_find_user_by_id = service.user_repository.find_by_id
        try:
            persisted = []
            persisted_ups_updates = []
            local_order = {
                "id": "local-1505",
                "userId": "doctor-1",
                "wooOrderId": "9505",
                "wooOrderNumber": "1505",
                "integrationDetails": {
                    "wooCommerce": json.dumps({"pepproOrderId": "local-1505"})
                },
                "trackingNumber": "",
                "shippingEstimate": {"status": "exception"},
                "status": "completed",
            }

            service.woo_commerce.is_configured = lambda: True
            service.woo_commerce._build_invoice_url = lambda *_args, **_kwargs: None
            service.woo_commerce.fetch_order = lambda candidate: {
                "id": 9505,
                "number": "1505",
                "status": "completed",
            } if str(candidate) == "9505" else None
            service.woo_commerce.fetch_order_by_number = lambda _candidate: None
            service.ship_station.fetch_order_status = lambda _order_number: {
                "status": "shipped",
                "trackingNumber": "1ZSHIP1505",
                "carrierCode": "ups",
                "serviceCode": "ups_2nd_day_air_am",
                "shipDate": "2026-04-15T12:00:00Z",
                "shipments": [
                    {
                        "trackingNumber": "1ZSHIP1505",
                        "voided": False,
                    }
                ],
            }
            service.order_repository.find_by_order_identifier = lambda value: local_order if str(value) in {"1505", "9505"} else None
            service.order_repository.find_by_id = lambda value: local_order if str(value) == "local-1505" else None
            service.order_repository.update = lambda order: persisted.append(order) or order
            service.order_repository.update_ups_tracking_status = (
                lambda order_id, *, ups_tracking_status, delivered_at=None, estimated_arrival_date=None, delivery_date_guaranteed=None, expected_shipment_window=None: persisted_ups_updates.append(
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
                    "trackingNumber": "1ZSHIP1505",
                    "upsTrackingStatus": ups_tracking_status,
                    "shippingEstimate": {
                        **(local_order.get("shippingEstimate") or {}),
                        "status": ups_tracking_status,
                        "carrierId": "ups",
                        **({"estimatedArrivalDate": estimated_arrival_date} if estimated_arrival_date else {}),
                        **({"deliveryDateGuaranteed": delivery_date_guaranteed} if delivery_date_guaranteed else {}),
                    },
                }
            )
            service.ups_tracking.fetch_tracking_status = lambda tracking_number: {
                "carrier": "ups",
                "trackingNumber": tracking_number,
                "trackingStatus": "label_created",
                "trackingStatusRaw": "Shipper created a label, UPS has not received the package yet.",
                "deliveredAt": None,
                "estimatedArrivalDate": None,
                "deliveryDateGuaranteed": None,
                "expectedShipmentWindow": None,
            }
            service.user_repository.find_by_email = lambda _email: None
            service.user_repository.find_by_id = (
                lambda value: {
                    "id": "doctor-1",
                    "name": "Holly O'Quin",
                    "email": "holly@example.com",
                    "salesRepId": "rep-1",
                }
                if str(value) == "doctor-1"
                else None
            )

            result = service.get_sales_rep_order_detail("1505", "admin-1", token_role="admin")

            self.assertEqual(result["trackingNumber"], "1ZSHIP1505")
            self.assertEqual(result["upsTrackingStatus"], "label_created")
            self.assertEqual(result["shippingEstimate"]["status"], "label_created")
            self.assertEqual(
                result["integrationDetails"]["shipStation"]["trackingNumber"],
                "1ZSHIP1505",
            )
            self.assertEqual(
                result["integrationDetails"]["wooCommerce"],
                json.dumps({"pepproOrderId": "local-1505"}),
            )
            self.assertEqual(
                persisted_ups_updates,
                [("local-1505", "label_created", None, None, None, None)],
            )
            self.assertTrue(any(entry.get("trackingNumber") == "1ZSHIP1505" for entry in persisted))
        finally:
            service.woo_commerce.is_configured = original_is_configured
            service.woo_commerce.fetch_order = original_fetch_order
            service.woo_commerce.fetch_order_by_number = original_fetch_by_number
            service.woo_commerce._build_invoice_url = original_invoice_url
            service.ship_station.fetch_order_status = original_shipstation
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.find_by_id = original_find_by_id
            service.order_repository.update = original_update
            service.order_repository.update_ups_tracking_status = original_update_ups_status
            service.ups_tracking.fetch_tracking_status = original_fetch_tracking_status
            service.user_repository.find_by_email = original_find_email
            service.user_repository.find_by_id = original_find_user_by_id

    def test_detail_prefers_sql_snapshot_images_and_persists_them(self):
        service = self.order_service
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_find_by_id = service.order_repository.find_by_id
        original_update_items = service.order_repository.update_items
        original_find_email = service.user_repository.find_by_email
        original_find_user_by_id = service.user_repository.find_by_id
        original_mysql_fetch_one = service.mysql_client.fetch_one
        original_fetch_catalog = service.woo_commerce.fetch_catalog
        original_find_product_by_sku = service.woo_commerce.find_product_by_sku
        try:
            local_order = {
                "id": "local-1511",
                "userId": "doctor-1",
                "wooOrderId": "9011",
                "wooOrderNumber": "1511",
                "status": "processing",
                "items": [
                    {
                        "id": "line-1",
                        "productId": 1511,
                        "sku": "SKU-1511",
                        "name": "Peptide 1511",
                        "quantity": 1,
                        "total": 49.0,
                    }
                ],
            }
            persisted = []

            def fake_fetch_one(query, params=None):
                if "FROM product_documents" in query:
                    return {
                        "data": json.dumps(
                            {
                                "id": 1511,
                                "images": [{"src": "https://img.example/sql-1511.jpg"}],
                            }
                        )
                    }
                return None

            service.order_repository.find_by_order_identifier = lambda value: local_order if str(value) in {"1511", "9011"} else None
            service.order_repository.find_by_id = lambda value: local_order if str(value) == "local-1511" else None
            service.order_repository.update_items = (
                lambda order_id, items: persisted.append((order_id, items)) or {**local_order, "items": items}
            )
            service.user_repository.find_by_email = lambda _email: None
            service.user_repository.find_by_id = (
                lambda value: {
                    "id": "doctor-1",
                    "name": "Jennifer Ellen Blankenship",
                    "email": "jen@example.com",
                    "salesRepId": "rep-1",
                }
                if str(value) == "doctor-1"
                else None
            )
            service.mysql_client.fetch_one = fake_fetch_one
            service.woo_commerce.fetch_catalog = lambda *_args, **_kwargs: self.fail("Woo fallback should not run when SQL snapshot has an image")
            service.woo_commerce.find_product_by_sku = lambda *_args, **_kwargs: self.fail("SKU fallback should not run when SQL snapshot has an image")

            result = service.get_sales_rep_order_detail("1511", "admin-1", token_role="admin")

            self.assertEqual(result["lineItems"][0]["image"], "https://img.example/sql-1511.jpg")
            self.assertEqual(result["lineItems"][0]["imageUrl"], "https://img.example/sql-1511.jpg")
            self.assertEqual(persisted[0][0], "local-1511")
            self.assertEqual(persisted[0][1][0]["image"], "https://img.example/sql-1511.jpg")
        finally:
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.find_by_id = original_find_by_id
            service.order_repository.update_items = original_update_items
            service.user_repository.find_by_email = original_find_email
            service.user_repository.find_by_id = original_find_user_by_id
            service.mysql_client.fetch_one = original_mysql_fetch_one
            service.woo_commerce.fetch_catalog = original_fetch_catalog
            service.woo_commerce.find_product_by_sku = original_find_product_by_sku

    def test_detail_falls_back_to_woo_images_when_sql_order_items_have_none(self):
        service = self.order_service
        original_find_identifier = service.order_repository.find_by_order_identifier
        original_find_by_id = service.order_repository.find_by_id
        original_update_items = service.order_repository.update_items
        original_find_email = service.user_repository.find_by_email
        original_find_user_by_id = service.user_repository.find_by_id
        original_mysql_fetch_one = service.mysql_client.fetch_one
        original_fetch_catalog = service.woo_commerce.fetch_catalog
        original_find_product_by_sku = service.woo_commerce.find_product_by_sku
        try:
            local_order = {
                "id": "local-1512",
                "userId": "doctor-1",
                "wooOrderId": "9012",
                "wooOrderNumber": "1512",
                "status": "processing",
                "items": [
                    {
                        "id": "line-1",
                        "productId": 1512,
                        "sku": "SKU-1512",
                        "name": "Peptide 1512",
                        "quantity": 1,
                        "total": 59.0,
                    }
                ],
            }
            persisted = []
            fetch_endpoints = []

            service.order_repository.find_by_order_identifier = lambda value: local_order if str(value) in {"1512", "9012"} else None
            service.order_repository.find_by_id = lambda value: local_order if str(value) == "local-1512" else None
            service.order_repository.update_items = (
                lambda order_id, items: persisted.append((order_id, items)) or {**local_order, "items": items}
            )
            service.user_repository.find_by_email = lambda _email: None
            service.user_repository.find_by_id = (
                lambda value: {
                    "id": "doctor-1",
                    "name": "Jennifer Ellen Blankenship",
                    "email": "jen@example.com",
                    "salesRepId": "rep-1",
                }
                if str(value) == "doctor-1"
                else None
            )
            service.mysql_client.fetch_one = lambda *_args, **_kwargs: None

            def fake_fetch_catalog(endpoint, params=None):
                del params
                fetch_endpoints.append(endpoint)
                if endpoint == "products/1512":
                    return {"id": 1512, "images": [{"src": "https://img.example/woo-1512.jpg"}]}
                return None

            service.woo_commerce.fetch_catalog = fake_fetch_catalog
            service.woo_commerce.find_product_by_sku = lambda *_args, **_kwargs: None

            result = service.get_sales_rep_order_detail("1512", "admin-1", token_role="admin")

            self.assertEqual(fetch_endpoints, ["products/1512"])
            self.assertEqual(result["lineItems"][0]["image"], "https://img.example/woo-1512.jpg")
            self.assertEqual(result["lineItems"][0]["thumbnail"], "https://img.example/woo-1512.jpg")
            self.assertEqual(persisted[0][0], "local-1512")
            self.assertEqual(persisted[0][1][0]["image"], "https://img.example/woo-1512.jpg")
        finally:
            service.order_repository.find_by_order_identifier = original_find_identifier
            service.order_repository.find_by_id = original_find_by_id
            service.order_repository.update_items = original_update_items
            service.user_repository.find_by_email = original_find_email
            service.user_repository.find_by_id = original_find_user_by_id
            service.mysql_client.fetch_one = original_mysql_fetch_one
            service.woo_commerce.fetch_catalog = original_fetch_catalog
            service.woo_commerce.find_product_by_sku = original_find_product_by_sku

    def test_modal_detail_uses_sales_rep_phone_fallback_for_summary_profiles(self):
        service = self.order_service
        actor = {
            "id": "rep-user-1",
            "role": "sales_rep",
            "email": "rep@example.com",
        }
        target = {
            "id": "admin-1",
            "role": "admin",
            "name": "Admin One",
            "email": "admin-profile@example.com",
            "phone": None,
        }
        rep_record = {
            "id": "rep-1",
            "legacyUserId": "rep-user-1",
            "email": "admin-profile@example.com",
            "phone": "317-555-0101",
            "isPartner": True,
            "allowedRetail": False,
        }

        with patch.object(service.user_repository, "get_all", return_value=[actor, target]), \
            patch.object(service.sales_rep_repository, "get_all", return_value=[rep_record]):
            result = service.get_sales_modal_detail(actor=actor, target_user_id="admin-1")

        self.assertEqual(result["summaryOnly"], True)
        self.assertEqual(result["user"]["phone"], "317-555-0101")
        self.assertEqual(result["user"]["salesRepId"], "rep-1")
        self.assertEqual(result["user"]["isPartner"], True)
        self.assertEqual(result["user"]["allowedRetail"], False)

    def test_modal_detail_allows_summary_only_sales_actor_lookup_without_rep_overlap(self):
        service = self.order_service
        actor = {
            "id": "rep-user-1",
            "role": "sales_rep",
            "email": "rep@example.com",
        }
        target = {
            "id": "admin-1",
            "role": "admin",
            "name": "Admin One",
            "email": "admin@example.com",
            "phone": "317-555-0199",
        }
        actor_rep_record = {
            "id": "rep-1",
            "legacyUserId": "rep-user-1",
            "email": "rep@example.com",
            "phone": "317-555-0101",
        }

        with patch.object(service.user_repository, "get_all", return_value=[actor, target]), \
            patch.object(service.sales_rep_repository, "get_all", return_value=[actor_rep_record]):
            result = service.get_sales_modal_detail(actor=actor, target_user_id="admin-1")

        self.assertEqual(result["summaryOnly"], True)
        self.assertEqual(result["user"]["phone"], "317-555-0199")
        self.assertEqual(result["user"]["email"], "admin@example.com")


if __name__ == "__main__":
    unittest.main()
