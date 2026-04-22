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
    requests.Timeout = TimeoutError
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


class ShippingNotificationServiceTests(unittest.TestCase):
    def test_notify_customer_order_shipping_status_marks_sent_and_skips_duplicates(self):
        from python_backend.services import shipping_notification_service as svc

        base_order = {
            "id": "order-1",
            "userId": "doctor-1",
            "wooOrderNumber": "1505",
            "trackingNumber": "1ZSHIP1505",
            "shippingCarrier": "ups",
            "shippingEstimate": {"status": "out_for_delivery"},
            "integrations": {},
        }
        stored_order = dict(base_order)
        sent_payloads = []

        def fake_find_by_id(order_id):
            if str(order_id) != "order-1":
                return None
            return dict(stored_order)

        def fake_update(order):
            stored_order.clear()
            stored_order.update(order)
            sent_payloads.append(dict(order))
            return dict(order)

        with patch.object(svc.order_repository, "find_by_id", side_effect=fake_find_by_id), \
            patch.object(svc.order_repository, "update", side_effect=fake_update), \
            patch.object(svc.user_repository, "find_by_id", return_value={"id": "doctor-1", "email": "holly@example.com", "name": "Holly O'Quin"}), \
            patch.object(svc.email_service, "send_order_shipping_status_email") as send_email:
            first = svc.notify_customer_order_shipping_status("order-1", "out_for_delivery")
            second = svc.notify_customer_order_shipping_status("order-1", "out_for_delivery")

        self.assertTrue(first)
        self.assertFalse(second)
        send_email.assert_called_once_with(
            "holly@example.com",
            status="out_for_delivery",
            customer_name="Holly O'Quin",
            order_number="1505",
            tracking_number="1ZSHIP1505",
            carrier_code="ups",
            delivery_label=None,
        )
        self.assertEqual(len(sent_payloads), 1)
        self.assertIn(
            "out_for_delivery",
            sent_payloads[0]["integrations"]["pepProNotifications"]["shippingStatusEmails"],
        )

    def test_notify_customer_order_shipping_status_does_not_mark_sent_when_email_fails(self):
        from python_backend.services import shipping_notification_service as svc

        base_order = {
            "id": "order-1",
            "userId": "doctor-1",
            "wooOrderNumber": "1505",
            "trackingNumber": "1ZSHIP1505",
            "shippingCarrier": "ups",
            "shippingEstimate": {"status": "delivered"},
            "integrations": {},
        }

        with patch.object(svc.order_repository, "find_by_id", return_value=dict(base_order)), \
            patch.object(svc.order_repository, "update") as update_order, \
            patch.object(svc.user_repository, "find_by_id", return_value={"id": "doctor-1", "email": "holly@example.com"}), \
            patch.object(svc.email_service, "send_order_shipping_status_email", side_effect=RuntimeError("mail failed")):
            with self.assertRaises(RuntimeError):
                svc.notify_customer_order_shipping_status("order-1", "delivered")

        update_order.assert_not_called()


if __name__ == "__main__":
    unittest.main()
