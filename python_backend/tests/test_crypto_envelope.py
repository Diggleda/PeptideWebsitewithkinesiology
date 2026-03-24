from __future__ import annotations

import sys
import types
import unittest
from types import SimpleNamespace

if "requests" not in sys.modules:
    requests = types.ModuleType("requests")
    requests_auth = types.ModuleType("requests.auth")

    class HTTPBasicAuth:
        def __init__(self, *_args, **_kwargs):
            pass

    def _blocked(*_args, **_kwargs):
        raise RuntimeError("requests used during unit test")

    requests.get = _blocked
    requests.post = _blocked
    requests.put = _blocked
    requests.patch = _blocked
    requests.delete = _blocked
    requests_auth.HTTPBasicAuth = HTTPBasicAuth
    sys.modules["requests"] = requests
    sys.modules["requests.auth"] = requests_auth

from python_backend.integrations import woo_commerce
try:
    from python_backend.utils import crypto_envelope
except ModuleNotFoundError:  # pragma: no cover - depends on local test env
    crypto_envelope = None


def _config_for_key(key: str) -> SimpleNamespace:
    return SimpleNamespace(
        encryption={
            "key": key,
            "blind_index_key": "blind-index-secret",
            "key_version": "test-v1",
            "kms_key_id": "kms-test",
        }
    )


@unittest.skipIf(crypto_envelope is None, "cryptography is unavailable in this test environment")
class CryptoEnvelopeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original_get_config = crypto_envelope.get_config
        crypto_envelope.get_config = lambda: _config_for_key("test-master-key")

    def tearDown(self) -> None:
        crypto_envelope.get_config = self._original_get_config

    def test_encrypt_text_round_trip(self) -> None:
        ciphertext = crypto_envelope.encrypt_text(
            "patient-123",
            aad={"table": "patient_links", "record_ref": "abc", "field": "patient_id"},
        )

        plaintext = crypto_envelope.decrypt_text(
            ciphertext,
            aad={"table": "patient_links", "record_ref": "abc", "field": "patient_id"},
        )

        self.assertEqual(plaintext, "patient-123")

    def test_aad_mismatch_is_rejected(self) -> None:
        ciphertext = crypto_envelope.encrypt_text(
            "patient-123",
            aad={"table": "patient_links", "record_ref": "abc", "field": "patient_id"},
        )

        with self.assertRaises(Exception):
            crypto_envelope.decrypt_text(
                ciphertext,
                aad={"table": "patient_links", "record_ref": "other", "field": "patient_id"},
            )

    def test_wrong_key_is_rejected(self) -> None:
        ciphertext = crypto_envelope.encrypt_text(
            "patient-123",
            aad={"table": "patient_links", "record_ref": "abc", "field": "patient_id"},
        )

        crypto_envelope.get_config = lambda: _config_for_key("different-master-key")

        with self.assertRaises(Exception):
            crypto_envelope.decrypt_text(
                ciphertext,
                aad={"table": "patient_links", "record_ref": "abc", "field": "patient_id"},
            )

    def test_blind_index_is_stable_for_normalized_email(self) -> None:
        first = crypto_envelope.compute_blind_index(
            "Doctor@Example.com ",
            label="contact_forms.email",
            normalizer=lambda value: value.strip().lower(),
        )
        second = crypto_envelope.compute_blind_index(
            "doctor@example.com",
            label="contact_forms.email",
            normalizer=lambda value: value.strip().lower(),
        )

        self.assertEqual(first, second)


class WooPayloadSanitizationTests(unittest.TestCase):
    def test_build_order_payload_preserves_customer_address_but_strips_extra_meta(self) -> None:
        payload = woo_commerce.build_order_payload(
            {
                "id": "order-1",
                "createdAt": "2026-03-24T15:00:00Z",
                "paymentMethod": "zelle",
                "paymentDetails": "john@example.com",
                "shippingTotal": 12.5,
                "shippingEstimate": {
                    "serviceType": "Hand Delivery",
                    "serviceCode": "hand_delivery",
                    "carrierId": "local_delivery",
                },
                "shippingAddress": {
                    "name": "John Doe",
                    "addressLine1": "123 Main St",
                    "city": "Indianapolis",
                    "state": "IN",
                    "postalCode": "46000",
                    "phone": "555-123-4567",
                },
                "items": [
                    {
                        "productId": "123",
                        "variantId": "456",
                        "sku": "BPC-157-5MG",
                        "name": "BPC-157",
                        "quantity": 1,
                        "price": 100,
                        "note": "leave at front desk",
                    }
                ],
            },
            {"name": "John Doe", "email": "john@example.com"},
        )

        meta_keys = {entry.get("key") for entry in payload.get("meta_data") or []}

        self.assertEqual(payload["billing"]["first_name"], "John")
        self.assertEqual(payload["billing"]["last_name"], "Doe")
        self.assertEqual(payload["billing"]["address_1"], "123 Main St")
        self.assertEqual(payload["shipping"]["address_1"], "123 Main St")
        self.assertEqual(payload["billing"]["email"], "john@example.com")
        self.assertEqual(payload["shipping"]["phone"], "555-123-4567")
        self.assertEqual(payload["line_items"][0]["meta_data"], [])
        self.assertNotIn("peppro_hand_delivery_address", meta_keys)
        self.assertNotIn("peppro_payment_method", meta_keys)
        self.assertEqual(payload["customer_note"], "PepPro Order order-1")


if __name__ == "__main__":
    unittest.main()
