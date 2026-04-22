import contextlib
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
        flask.request = types.SimpleNamespace(method="POST", path="/api/orders/")
        flask.g = types.SimpleNamespace(current_user=None)
        flask.jsonify = lambda payload=None, *args, **kwargs: payload
        flask.has_request_context = lambda: False
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
        requests.Timeout = TimeoutError
        requests.RequestException = Exception
        requests.HTTPError = Exception
        requests_auth.HTTPBasicAuth = HTTPBasicAuth
        sys.modules["requests"] = requests
        sys.modules["requests.auth"] = requests_auth


class CreateOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.integrations.woo_commerce import IntegrationError
        from python_backend.services import order_service

        cls.IntegrationError = IntegrationError
        cls.order_service = order_service

    def _run_with_common_patches(self, forward_order_side_effect, *, items=None):
        service = self.order_service
        user = {
            "id": "doctor-1",
            "name": "Dr. Pepper",
            "email": "doctor@example.com",
            "role": "doctor",
            "referralCredits": 0,
        }
        items = items or [{"productId": 101, "name": "Test Product", "price": 25.0, "quantity": 2}]

        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(service.user_repository, "find_by_id", return_value=user))
            stack.enter_context(patch.object(service.settings_service, "get_settings", return_value={}))
            stack.enter_context(patch.object(service.referral_service, "handle_order_referral_effects", return_value={}))
            stack.enter_context(patch.object(service.discount_code_repository, "reserve_use_once"))
            stack.enter_context(patch.object(service.woo_commerce, "forward_order", side_effect=forward_order_side_effect))
            stack.enter_context(patch.object(service, "_is_tax_exempt_for_checkout", return_value=False))
            stack.enter_context(patch.object(service, "_resolve_order_exemption_snapshot", return_value={}))
            stack.enter_context(patch.object(service, "_resolve_sales_rep_context", return_value={}))
            stack.enter_context(patch.object(service, "_calculate_checkout_tax", return_value=(0.0, "none", None)))
            stack.enter_context(patch.object(service, "_can_user_use_hand_delivery_for_checkout", return_value=False))
            return service.create_order(
                user_id="doctor-1",
                items=items,
                total=50.0,
                referral_code=None,
                discount_code=None,
                payment_method="bacs",
                pricing_mode="wholesale",
                tax_total=0.0,
                shipping_total=0.0,
                shipping_address={},
                facility_pickup=False,
                shipping_rate=None,
                expected_shipment_window=None,
                physician_certified=True,
                as_delegate_label=None,
            )

    def test_create_order_aborts_when_woo_order_creation_fails(self):
        service = self.order_service

        def raise_woo_error(order, _user):
            raise self.IntegrationError(
                "WooCommerce order creation failed",
                response={"status": 525, "body": "<!DOCTYPE html>"},
            )

        with patch.object(service.order_repository, "insert") as insert_mock, patch.object(
            service.order_repository, "update"
        ) as update_mock, patch.object(
            service.order_repository, "update_woo_fields"
        ) as update_woo_fields_mock, patch.object(
            service.sales_prospect_repository, "mark_doctor_as_nurturing_if_purchased"
        ) as nurture_mock, patch.object(
            service.referral_service, "apply_referral_credit"
        ) as apply_credit_mock:
            with self.assertRaises(ValueError) as error:
                self._run_with_common_patches(raise_woo_error)

        self.assertEqual(str(error.exception), "Unable to submit order right now. Please try again soon.")
        self.assertEqual(getattr(error.exception, "status", None), 503)
        self.assertEqual(getattr(error.exception, "error_code", None), "WOO_ORDER_CREATE_FAILED")
        insert_mock.assert_not_called()
        update_mock.assert_not_called()
        update_woo_fields_mock.assert_not_called()
        nurture_mock.assert_not_called()
        apply_credit_mock.assert_not_called()

    def test_create_order_persists_only_after_woo_success(self):
        service = self.order_service
        events = []
        inserted_orders = []

        def succeed(order, _user):
            events.append("forward_order")
            return {
                "status": "success",
                "response": {
                    "id": 9001,
                    "number": "1491",
                    "status": "processing",
                    "orderKey": "wc_order_key_123",
                },
            }

        def capture_insert(order):
            events.append("insert")
            inserted_orders.append(dict(order))
            return dict(order)

        with patch.object(service.order_repository, "insert", side_effect=capture_insert) as insert_mock, patch.object(
            service.order_repository, "update", side_effect=lambda order: dict(order)
        ) as update_mock, patch.object(
            service.order_repository, "update_woo_fields"
        ) as update_woo_fields_mock, patch.object(
            service.sales_prospect_repository, "mark_doctor_as_nurturing_if_purchased"
        ) as nurture_mock:
            result = self._run_with_common_patches(succeed)

        self.assertTrue(result["success"])
        self.assertEqual(events[:2], ["forward_order", "insert"])
        insert_mock.assert_called_once()
        update_mock.assert_called_once()
        update_woo_fields_mock.assert_called_once()
        nurture_mock.assert_called_once()
        self.assertEqual(inserted_orders[0]["wooOrderId"], 9001)
        self.assertEqual(inserted_orders[0]["wooOrderNumber"], "1491")
        self.assertEqual(inserted_orders[0]["status"], "processing")
        self.assertEqual(result["order"]["wooOrderId"], 9001)
        self.assertEqual(result["order"]["integrations"]["wooCommerce"], "success")

    def test_create_order_sets_facility_pickup_flags_when_enabled(self):
        service = self.order_service
        inserted_orders = []

        def succeed(order, _user):
            return {
                "status": "success",
                "response": {
                    "id": 9003,
                    "number": "1493",
                    "status": "processing",
                    "orderKey": "wc_order_key_789",
                },
            }

        def capture_insert(order):
            inserted_orders.append(dict(order))
            return dict(order)

        with patch.object(service.order_repository, "insert", side_effect=capture_insert), patch.object(
            service.order_repository, "update", side_effect=lambda order: dict(order)
        ), patch.object(
            service.order_repository, "update_woo_fields"
        ), patch.object(
            service.sales_prospect_repository, "mark_doctor_as_nurturing_if_purchased"
        ), patch.object(
            service.user_repository, "find_by_id",
            return_value={
                "id": "admin-1",
                "name": "Admin Pepper",
                "email": "admin@example.com",
                "role": "admin",
                "referralCredits": 0,
            },
        ), patch.object(service.settings_service, "get_settings", return_value={}), patch.object(
            service.referral_service, "handle_order_referral_effects", return_value={}
        ), patch.object(
            service.discount_code_repository, "reserve_use_once"
        ), patch.object(
            service.woo_commerce, "forward_order", side_effect=succeed
        ), patch.object(
            service, "_is_tax_exempt_for_checkout", return_value=False
        ), patch.object(
            service, "_resolve_order_exemption_snapshot", return_value={}
        ), patch.object(
            service, "_resolve_sales_rep_context", return_value={}
        ), patch.object(
            service, "_calculate_checkout_tax", return_value=(0.0, "none", None)
        ), patch.object(
            service, "_can_user_use_hand_delivery_for_checkout", return_value=False
        ):
            service.create_order(
                user_id="admin-1",
                items=[{"productId": 101, "name": "Test Product", "price": 25.0, "quantity": 2}],
                total=50.0,
                referral_code=None,
                discount_code=None,
                payment_method="bacs",
                pricing_mode="wholesale",
                tax_total=0.0,
                shipping_total=7.5,
                shipping_address={
                    "name": "PepPro Facility Pickup",
                    "addressLine1": "640 S Grand Ave",
                    "addressLine2": "Unit #107",
                    "city": "Santa Ana",
                    "state": "CA",
                    "postalCode": "92705",
                    "country": "US",
                },
                facility_pickup=True,
                shipping_rate={
                    "carrierId": "facility_pickup",
                    "serviceCode": "facility_pickup",
                    "serviceType": "Facility pickup",
                },
                expected_shipment_window=None,
                physician_certified=True,
                as_delegate_label=None,
            )

        self.assertEqual(len(inserted_orders), 1)
        self.assertFalse(inserted_orders[0]["handDelivery"])
        self.assertTrue(inserted_orders[0]["facilityPickup"])
        self.assertTrue(inserted_orders[0]["facility_pickup"])
        self.assertTrue(inserted_orders[0]["fascility_pickup"])
        self.assertEqual(inserted_orders[0]["fulfillmentMethod"], "facility_pickup")
        self.assertEqual(inserted_orders[0]["shippingAddress"]["name"], "Admin Pepper")
        self.assertEqual(inserted_orders[0]["shippingEstimate"]["serviceCode"], "facility_pickup")
        self.assertEqual(inserted_orders[0]["shippingTotal"], 0.0)

    def test_facility_pickup_shipping_address_preserves_submitted_recipient_name(self):
        service = self.order_service

        address = service._build_facility_pickup_shipping_address(
            {"name": "Admin Pepper", "role": "admin"},
            {"name": "Recipient Patient"},
        )

        self.assertEqual(address["name"], "Recipient Patient")
        self.assertEqual(address["addressLine1"], "640 S Grand Ave")
        self.assertEqual(address["postalCode"], "92705")

    def test_sales_lead_can_use_facility_pickup(self):
        service = self.order_service

        self.assertTrue(service._can_user_use_facility_pickup_for_checkout({"role": "sales_lead"}))

    def test_create_order_preserves_facility_pickup_recipient_name(self):
        service = self.order_service
        inserted_orders = []

        def succeed(order, _user):
            self.assertEqual(order["shippingAddress"]["name"], "Recipient Patient")
            self.assertEqual(order["billingAddress"]["name"], "Recipient Patient")
            return {
                "status": "success",
                "response": {
                    "id": 9005,
                    "number": "1495",
                    "status": "processing",
                    "orderKey": "wc_order_key_791",
                },
            }

        def capture_insert(order):
            inserted_orders.append(dict(order))
            return dict(order)

        with patch.object(service.order_repository, "insert", side_effect=capture_insert), patch.object(
            service.order_repository, "update", side_effect=lambda order: dict(order)
        ), patch.object(
            service.order_repository, "update_woo_fields"
        ), patch.object(
            service.sales_prospect_repository, "mark_doctor_as_nurturing_if_purchased"
        ), patch.object(
            service.user_repository, "find_by_id",
            return_value={
                "id": "lead-1",
                "name": "Sales Lead User",
                "email": "lead@example.com",
                "role": "sales_lead",
                "referralCredits": 0,
            },
        ), patch.object(service.settings_service, "get_settings", return_value={}), patch.object(
            service.referral_service, "handle_order_referral_effects", return_value={}
        ), patch.object(
            service.discount_code_repository, "reserve_use_once"
        ), patch.object(
            service.woo_commerce, "forward_order", side_effect=succeed
        ), patch.object(
            service, "_is_tax_exempt_for_checkout", return_value=False
        ), patch.object(
            service, "_resolve_order_exemption_snapshot", return_value={}
        ), patch.object(
            service, "_resolve_sales_rep_context", return_value={}
        ), patch.object(
            service, "_resolve_sales_rep_record_for_user", return_value={}
        ), patch.object(
            service, "_calculate_checkout_tax", return_value=(0.0, "none", None)
        ):
            service.create_order(
                user_id="lead-1",
                items=[{"productId": 101, "name": "Test Product", "price": 25.0, "quantity": 2}],
                total=50.0,
                referral_code=None,
                discount_code=None,
                payment_method="bacs",
                pricing_mode="wholesale",
                tax_total=0.0,
                shipping_total=0.0,
                shipping_address={
                    "name": "Sales Lead User",
                    "addressLine1": "640 S Grand Ave",
                    "addressLine2": "Unit #107",
                    "city": "Santa Ana",
                    "state": "CA",
                    "postalCode": "92705",
                    "country": "US",
                },
                facility_pickup_recipient_name="Recipient Patient",
                facility_pickup=True,
                shipping_rate={
                    "carrierId": "facility_pickup",
                    "serviceCode": "facility_pickup",
                    "serviceType": "Facility pickup",
                },
                expected_shipment_window=None,
                physician_certified=True,
                as_delegate_label=None,
            )

        self.assertEqual(len(inserted_orders), 1)
        self.assertEqual(inserted_orders[0]["shippingAddress"]["name"], "Recipient Patient")
        self.assertEqual(inserted_orders[0]["billingAddress"]["name"], "Recipient Patient")
        self.assertEqual(inserted_orders[0]["facilityPickupRecipientName"], "Recipient Patient")
        self.assertEqual(inserted_orders[0]["fulfillmentMethod"], "facility_pickup")
        self.assertTrue(inserted_orders[0]["facilityPickup"])

    def test_woo_payload_preserves_facility_pickup_name_over_fallback_names(self):
        service = self.order_service

        payload = service.woo_commerce.build_order_payload(
            {
                "id": "order-1",
                "items": [
                    {
                        "productId": 101,
                        "name": "Test Product",
                        "price": 25.0,
                        "quantity": 1,
                    }
                ],
                "total": 25.0,
                "grandTotal": 25.0,
                "shippingTotal": 0.0,
                "taxTotal": 0.0,
                "facilityPickupRecipientName": "Recipient Patient",
                "shippingEstimate": {
                    "carrierId": "facility_pickup",
                    "serviceCode": "facility_pickup",
                    "serviceType": "Facility pickup",
                },
                "shippingAddress": {
                    "name": "Sales Lead User",
                    "addressLine1": "640 S Grand Ave",
                    "addressLine2": "Unit #107",
                    "city": "Santa Ana",
                    "state": "CA",
                    "postalCode": "92705",
                    "country": "US",
                },
                "billingAddress": {
                    "firstName": "Sales",
                    "lastName": "Lead",
                    "addressLine1": "640 S Grand Ave",
                    "addressLine2": "Unit #107",
                    "city": "Santa Ana",
                    "state": "CA",
                    "postalCode": "92705",
                    "country": "US",
                },
                "facilityPickup": True,
                "facility_pickup": True,
                "fulfillmentMethod": "facility_pickup",
                "createdAt": "2026-04-22T00:00:00Z",
            },
            {
                "name": "Sales Lead User",
                "email": "lead@example.com",
                "role": "sales_lead",
            },
        )

        self.assertEqual(payload["shipping"]["first_name"], "Recipient")
        self.assertEqual(payload["shipping"]["last_name"], "Patient")
        meta = {entry["key"]: entry.get("value") for entry in payload["meta_data"]}
        self.assertEqual(meta["peppro_facility_pickup_recipient_name"], "Recipient Patient")

    def test_woo_summary_restores_facility_pickup_name_from_metadata(self):
        service = self.order_service

        mapped = service.woo_commerce._map_woo_order_summary(
            {
                "id": 9005,
                "number": "1495",
                "status": "pending",
                "currency": "USD",
                "total": "50.00",
                "shipping_total": "0.00",
                "date_created": "2026-04-22T00:00:00",
                "meta_data": [
                    {"key": "peppro_fulfillment_method", "value": "facility_pickup"},
                    {
                        "key": "peppro_facility_pickup_recipient_name",
                        "value": "Recipient Patient",
                    },
                ],
                "shipping": {
                    "first_name": "Sales",
                    "last_name": "Lead",
                    "address_1": "640 S Grand Ave",
                    "address_2": "Unit #107",
                    "city": "Santa Ana",
                    "state": "CA",
                    "postcode": "92705",
                    "country": "US",
                },
                "billing": {
                    "first_name": "Sales",
                    "last_name": "Lead",
                    "address_1": "640 S Grand Ave",
                    "address_2": "Unit #107",
                    "city": "Santa Ana",
                    "state": "CA",
                    "postcode": "92705",
                    "country": "US",
                },
                "line_items": [],
            }
        )

        self.assertEqual(mapped["shippingAddress"]["name"], "Recipient Patient")
        self.assertEqual(mapped["billingAddress"]["name"], "Recipient Patient")

    def test_create_order_keeps_manual_hand_delivery_distinct_from_facility_pickup(self):
        service = self.order_service
        inserted_orders = []

        def succeed(order, _user):
            return {
                "status": "success",
                "response": {
                    "id": 9004,
                    "number": "1494",
                    "status": "processing",
                    "orderKey": "wc_order_key_790",
                },
            }

        def capture_insert(order):
            inserted_orders.append(dict(order))
            return dict(order)

        with patch.object(service.order_repository, "insert", side_effect=capture_insert), patch.object(
            service.order_repository, "update", side_effect=lambda order: dict(order)
        ), patch.object(
            service.order_repository, "update_woo_fields"
        ), patch.object(
            service.sales_prospect_repository, "mark_doctor_as_nurturing_if_purchased"
        ), patch.object(
            service.user_repository, "find_by_id",
            return_value={
                "id": "doctor-1",
                "name": "Dr. Pepper",
                "email": "doctor@example.com",
                "role": "doctor",
                "referralCredits": 0,
                "handDelivered": True,
            },
        ), patch.object(service.settings_service, "get_settings", return_value={}), patch.object(
            service.referral_service, "handle_order_referral_effects", return_value={}
        ), patch.object(
            service.discount_code_repository, "reserve_use_once"
        ), patch.object(
            service.woo_commerce, "forward_order", side_effect=succeed
        ), patch.object(
            service, "_is_tax_exempt_for_checkout", return_value=False
        ), patch.object(
            service, "_resolve_order_exemption_snapshot", return_value={}
        ), patch.object(
            service, "_resolve_sales_rep_context", return_value={}
        ), patch.object(
            service, "_calculate_checkout_tax", return_value=(0.0, "none", None)
        ), patch.object(
            service, "_can_user_use_hand_delivery_for_checkout", return_value=True
        ):
            service.create_order(
                user_id="doctor-1",
                items=[{"productId": 101, "name": "Test Product", "price": 25.0, "quantity": 2}],
                total=50.0,
                referral_code=None,
                discount_code=None,
                payment_method="bacs",
                pricing_mode="wholesale",
                tax_total=0.0,
                shipping_total=0.0,
                shipping_address={"addressLine1": "123 Doctor Way", "city": "Dallas", "state": "TX", "postalCode": "75201", "country": "US"},
                facility_pickup=True,
                shipping_rate={
                    "carrierId": "hand_delivery",
                    "serviceCode": "hand_delivery",
                    "serviceType": "Hand delivered",
                },
                expected_shipment_window=None,
                physician_certified=True,
                as_delegate_label=None,
            )

        self.assertEqual(len(inserted_orders), 1)
        self.assertTrue(inserted_orders[0]["handDelivery"])
        self.assertFalse(inserted_orders[0]["facilityPickup"])
        self.assertFalse(inserted_orders[0]["facility_pickup"])
        self.assertEqual(inserted_orders[0]["fulfillmentMethod"], "hand_delivered")
        self.assertEqual(inserted_orders[0]["shippingEstimate"]["serviceCode"], "hand_delivery")

    def test_create_order_forwards_add_on_items_like_regular_products(self):
        service = self.order_service
        submitted_orders = []
        built_line_items = []
        items = [
            {"productId": 101, "name": "Primary Product", "price": 25.0, "quantity": 2},
            {
                "productId": 202,
                "variantId": 303,
                "sku": "ADD-303",
                "name": "Accessory Pack - 5 pack",
                "price": 12.5,
                "quantity": 1,
            },
        ]

        def succeed(order, _user):
            submitted_orders.append(
                [
                    {
                        "productId": item.get("productId"),
                        "variantId": item.get("variantId"),
                        "sku": item.get("sku"),
                        "name": item.get("name"),
                        "price": item.get("price"),
                        "quantity": item.get("quantity"),
                    }
                    for item in (order.get("items") or [])
                    if isinstance(item, dict)
                ]
            )
            built_line_items.append(service.woo_commerce.build_line_items(order.get("items") or []))
            return {
                "status": "success",
                "response": {
                    "id": 9002,
                    "number": "1492",
                    "status": "processing",
                    "orderKey": "wc_order_key_456",
                },
            }

        with patch.object(service.order_repository, "insert", side_effect=lambda order: dict(order)), patch.object(
            service.order_repository, "update", side_effect=lambda order: dict(order)
        ), patch.object(
            service.order_repository, "update_woo_fields"
        ), patch.object(
            service.sales_prospect_repository, "mark_doctor_as_nurturing_if_purchased"
        ):
            result = self._run_with_common_patches(succeed, items=items)

        self.assertTrue(result["success"])
        self.assertEqual(len(submitted_orders), 1)
        self.assertEqual(submitted_orders[0][0]["productId"], 101)
        self.assertIsNone(submitted_orders[0][0]["variantId"])
        self.assertIsNone(submitted_orders[0][0]["sku"])
        self.assertEqual(submitted_orders[0][0]["quantity"], 2)
        self.assertEqual(submitted_orders[0][1]["productId"], 202)
        self.assertEqual(submitted_orders[0][1]["variantId"], 303)
        self.assertEqual(submitted_orders[0][1]["sku"], "ADD-303")
        self.assertEqual(submitted_orders[0][1]["quantity"], 1)
        self.assertEqual(len(built_line_items), 1)
        self.assertEqual(len(built_line_items[0]), 2)
        self.assertEqual(built_line_items[0][0]["product_id"], 101)
        self.assertNotIn("variation_id", built_line_items[0][0])
        self.assertEqual(built_line_items[0][0]["quantity"], 2)
        self.assertEqual(built_line_items[0][0]["total"], "50.00")
        self.assertEqual(built_line_items[0][1]["product_id"], 202)
        self.assertEqual(built_line_items[0][1]["variation_id"], 303)
        self.assertEqual(built_line_items[0][1]["sku"], "ADD-303")
        self.assertEqual(built_line_items[0][1]["quantity"], 1)
        self.assertEqual(built_line_items[0][1]["total"], "12.50")


if __name__ == "__main__":
    unittest.main()
