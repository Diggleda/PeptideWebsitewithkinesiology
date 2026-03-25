import unittest
import sys
import types
from datetime import datetime
from unittest.mock import patch

if "pymysql" not in sys.modules:
    pymysql_stub = types.ModuleType("pymysql")
    pymysql_stub.connect = lambda *args, **kwargs: None
    pymysql_stub.connections = types.SimpleNamespace(Connection=object)
    pymysql_stub.err = types.SimpleNamespace(Error=Exception, OperationalError=Exception)
    cursors_stub = types.ModuleType("pymysql.cursors")
    cursors_stub.DictCursor = object
    pymysql_stub.cursors = cursors_stub
    sys.modules["pymysql"] = pymysql_stub
    sys.modules["pymysql.cursors"] = cursors_stub

if "python_backend.storage" not in sys.modules:
    storage_stub = types.ModuleType("python_backend.storage")
    storage_stub.order_store = None
    sys.modules["python_backend.storage"] = storage_stub

from python_backend.repositories import order_repository


class TestOrderRepositoryShippedAt(unittest.TestCase):
    def setUp(self):
        self.encrypt_json_patcher = patch(
            "python_backend.repositories.order_repository.encrypt_json",
            side_effect=lambda value, aad=None: f"cipher:{aad['field']}" if value is not None else None,
        )
        self.encrypt_json_patcher.start()

    def tearDown(self):
        self.encrypt_json_patcher.stop()

    def test_to_db_params_uses_explicit_shipstation_ship_date(self):
        params = order_repository._to_db_params(
            {
                "id": "order-1",
                "userId": "user-1",
                "status": "completed",
                "trackingNumber": "1Z999",
                "integrationDetails": {
                    "shipStation": {
                        "shipDate": "2026-01-24",
                    }
                },
            }
        )

        self.assertEqual(params["shipped_at"], "2026-01-24 00:00:00")

    def test_to_db_params_does_not_invent_shipped_at_from_status_and_tracking(self):
        params = order_repository._to_db_params(
            {
                "id": "order-2",
                "userId": "user-2",
                "status": "completed",
                "trackingNumber": "1Z999",
            }
        )

        self.assertIsNone(params["shipped_at"])

    @patch("python_backend.repositories.order_repository.find_by_id", return_value={"id": "order-3"})
    @patch("python_backend.repositories.order_repository.mysql_client.execute")
    @patch("python_backend.repositories.order_repository._using_mysql", return_value=True)
    def test_insert_preserves_existing_shipped_at(self, _using_mysql, mock_execute, _find_by_id):
        order_repository.insert(
            {
                "id": "order-3",
                "userId": "user-3",
                "status": "completed",
            }
        )

        sql = mock_execute.call_args[0][0]
        self.assertIn("WHEN VALUES(shipped_at) IS NOT NULL THEN VALUES(shipped_at)", sql)

    @patch("python_backend.repositories.order_repository.find_by_id", return_value={"id": "order-4"})
    @patch("python_backend.repositories.order_repository.mysql_client.execute")
    @patch("python_backend.repositories.order_repository._using_mysql", return_value=True)
    def test_update_preserves_existing_shipped_at(self, _using_mysql, mock_execute, _find_by_id):
        order_repository.update(
            {
                "id": "order-4",
                "userId": "user-4",
                "status": "completed",
            }
        )

        sql = mock_execute.call_args[0][0]
        self.assertIn("WHEN %(shipped_at)s IS NOT NULL THEN %(shipped_at)s", sql)

    def test_row_to_order_formats_naive_mysql_datetime_in_order_timezone(self):
        with patch.dict("os.environ", {"ORDER_TIMEZONE": "America/Los_Angeles"}):
            order = order_repository._row_to_order(
                {
                    "id": "order-5",
                    "user_id": "user-5",
                    "pricing_mode": "wholesale",
                    "items": "[]",
                    "total": 0,
                    "items_subtotal": 0,
                    "shipping_total": 0,
                    "shipping_rate": "{}",
                    "integrations": "{}",
                    "shipping_address": "{}",
                    "tracking_number": None,
                    "shipped_at": datetime(2026, 3, 5, 0, 0, 0),
                    "physician_certified": 0,
                    "status": "completed",
                    "created_at": datetime(2026, 3, 1, 12, 0, 0),
                    "updated_at": datetime(2026, 3, 1, 12, 0, 0),
                }
            )

        self.assertEqual(order["shippedAt"], "2026-03-05T00:00:00-08:00")

    def test_to_db_params_encrypts_payload_and_shipping_address_inline(self):
        params = order_repository._to_db_params(
            {
                "id": "order-6",
                "userId": "user-6",
                "shippingAddress": {"email": "doctor@example.com"},
                "items": [],
            }
        )

        self.assertEqual(params["shipping_address"], "cipher:shipping_address")
        self.assertEqual(params["payload"], "cipher:payload")
        self.assertEqual(order_repository.encrypt_json.call_args_list[0].kwargs["aad"]["record_ref"], "order-6")

    @patch("python_backend.repositories.order_repository.decrypt_json")
    def test_row_to_order_decrypts_inline_payload_and_shipping_address(self, mock_decrypt_json):
        def fake_decrypt(value, aad=None):
            if value == "cipher-payload":
                return {
                    "order": {
                        "items": [{"name": "BPC-157"}],
                        "handDelivery": True,
                        "fulfillmentMethod": "hand_delivered",
                    },
                    "handDelivery": True,
                }
            if value == "cipher-address":
                return {"email": "doctor@example.com"}
            return None

        mock_decrypt_json.side_effect = fake_decrypt

        order = order_repository._row_to_order(
            {
                "id": "order-7",
                "user_id": "user-7",
                "pricing_mode": "wholesale",
                "items": "[]",
                "total": 0,
                "items_subtotal": 0,
                "shipping_total": 0,
                "shipping_rate": "{}",
                "integrations": "{}",
                "shipping_address": "cipher-address",
                "payload": "cipher-payload",
                "tracking_number": None,
                "shipped_at": None,
                "physician_certified": 0,
                "status": "pending",
                "created_at": datetime(2026, 3, 1, 12, 0, 0),
                "updated_at": datetime(2026, 3, 1, 12, 0, 0),
            }
        )

        self.assertEqual(order["shippingAddress"], {"email": "doctor@example.com"})
        self.assertEqual(order["items"], [{"name": "BPC-157"}])
        self.assertTrue(order["handDelivery"])


if __name__ == "__main__":
    unittest.main()
