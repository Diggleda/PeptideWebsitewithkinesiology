from __future__ import annotations

import unittest
from unittest.mock import patch

from python_backend.services import account_deletion_service as service


class AccountDeletionServiceTests(unittest.TestCase):
    def test_rewrite_mysql_json_field_rewrites_inline_orders_payload(self) -> None:
        executed = []

        def fake_decrypt(value, aad=None):
            if value == "cipher-payload" and aad == {
                "table": "orders",
                "record_ref": "order-1",
                "field": "payload",
            }:
                return {
                    "userId": "doctor-1",
                    "nested": {"ownerId": "doctor-1"},
                }
            return None

        def fake_encrypt(value, aad=None):
            return f"cipher:{aad['table']}:{aad['field']}:{value['userId']}:{value['nested']['ownerId']}"

        with patch.object(service.mysql_client, "fetch_all", return_value=[{"id": "order-1", "payload": "cipher-payload"}]), \
            patch.object(service.mysql_client, "execute", side_effect=lambda query, params: executed.append((query, params)) or 1), \
            patch.object(service, "decrypt_json", side_effect=fake_decrypt), \
            patch.object(service, "encrypt_json", side_effect=fake_encrypt):
            result = service._rewrite_mysql_json_field(
                table_name="orders",
                field_name="payload",
                label="orders.payload",
                target_id="doctor-1",
                replacement_id=service.DELETED_USER_ID,
            )

        self.assertEqual(result["affectedRows"], 1)
        self.assertEqual(
            executed,
            [
                (
                    "UPDATE orders SET payload = %(value)s WHERE id = %(id)s",
                    {
                        "id": "order-1",
                        "value": (
                            f"cipher:orders:payload:{service.DELETED_USER_ID}:{service.DELETED_USER_ID}"
                        ),
                    },
                )
            ],
        )

    def test_rewrite_mysql_json_field_reads_legacy_peppro_sidecar_payload(self) -> None:
        executed = []

        def fake_decrypt(value, aad=None):
            if value == "legacy-payload" and aad == {
                "table": "peppro_orders",
                "record_ref": "legacy-ref",
                "field": "payload",
            }:
                return {"order": {"userId": "doctor-1"}}
            return None

        def fake_encrypt(value, aad=None):
            return f"cipher:{aad['table']}:{aad['record_ref']}:{value['order']['userId']}"

        with patch.object(
            service.mysql_client,
            "fetch_all",
            return_value=[{"id": "order-2", "payload_encrypted": "legacy-payload", "phi_payload_ref": "legacy-ref"}],
        ), \
            patch.object(service.mysql_client, "execute", side_effect=lambda query, params: executed.append((query, params)) or 1), \
            patch.object(service, "decrypt_json", side_effect=fake_decrypt), \
            patch.object(service, "encrypt_json", side_effect=fake_encrypt):
            result = service._rewrite_mysql_json_field(
                table_name="peppro_orders",
                field_name="payload",
                label="peppro_orders.payload",
                target_id="doctor-1",
                replacement_id=service.DELETED_USER_ID,
                legacy_fields=["payload_encrypted"],
                record_ref_fields=["phi_payload_ref"],
            )

        self.assertEqual(result["affectedRows"], 1)
        self.assertEqual(
            executed,
            [
                (
                    "UPDATE peppro_orders SET payload = %(value)s WHERE id = %(id)s",
                    {
                        "id": "order-2",
                        "value": f"cipher:peppro_orders:legacy-ref:{service.DELETED_USER_ID}",
                    },
                )
            ],
        )


if __name__ == "__main__":
    unittest.main()
