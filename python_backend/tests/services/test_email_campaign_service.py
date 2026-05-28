from __future__ import annotations

import unittest
import sys
import types
from unittest.mock import patch

fake_pymysql = types.ModuleType("pymysql")
fake_pymysql.connect = lambda *args, **kwargs: None
fake_pymysql.connections = types.SimpleNamespace(Connection=object)
fake_pymysql.err = types.SimpleNamespace(OperationalError=Exception, InterfaceError=Exception)
fake_pymysql_cursors = types.ModuleType("pymysql.cursors")
fake_pymysql_cursors.DictCursor = object
fake_pymysql.cursors = fake_pymysql_cursors
sys.modules.setdefault("pymysql", fake_pymysql)
sys.modules.setdefault("pymysql.cursors", fake_pymysql_cursors)

fake_crypto = types.ModuleType("cryptography")
fake_hazmat = types.ModuleType("cryptography.hazmat")
fake_primitives = types.ModuleType("cryptography.hazmat.primitives")
fake_ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
fake_aead = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")


class _FakeAESGCM:
    def __init__(self, _key):
        pass

    def encrypt(self, _nonce, data, _aad):
        return data

    def decrypt(self, _nonce, data, _aad):
        return data


fake_aead.AESGCM = _FakeAESGCM
sys.modules.setdefault("cryptography", fake_crypto)
sys.modules.setdefault("cryptography.hazmat", fake_hazmat)
sys.modules.setdefault("cryptography.hazmat.primitives", fake_primitives)
sys.modules.setdefault("cryptography.hazmat.primitives.ciphers", fake_ciphers)
sys.modules.setdefault("cryptography.hazmat.primitives.ciphers.aead", fake_aead)

from python_backend.services import email_campaign_service


class EmailCampaignServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        email_campaign_service.clear_manifest_cache()

    def test_manifest_loads_delegate_links_announcement_first(self) -> None:
        payload = email_campaign_service.list_templates()

        self.assertEqual(
            payload["categories"]["announcements"][0]["id"],
            "delegate_links_announcement",
        )
        self.assertEqual(payload["templates"][0]["id"], "delegate_links_announcement")

    def test_delegate_links_template_renders_with_cid_assets(self) -> None:
        rendered = email_campaign_service.render_email_template(
            "delegate_links_announcement",
            {
                "doctor_name": "Dr. Ada Lovelace",
                "clinic_name": "Analytical Clinic",
                "delegate_links_url": "https://trufusionlabs.com/account?tab=delegate-links",
                "unsubscribe_url": "https://trufusionlabs.com/unsubscribe",
                "support_email": "support@trufusionlabs.com",
            },
        )

        self.assertIn("Delegate Links: Extending Physician Reach", rendered["html"])
        self.assertIn("Distribute and manage white-labeled research material sessions.", rendered["html"])
        self.assertIn("Brochure", rendered["html"])
        self.assertIn("Proposal", rendered["html"])
        self.assertIn('src="cid:trufusion-logo"', rendered["html"])
        self.assertIn('src="cid:delegate-links-create-dialog"', rendered["html"])
        self.assertIn('src="cid:delegate-links-proposal-session"', rendered["html"])
        self.assertNotIn("data:image", rendered["html"])
        self.assertIn("Dr. Ada Lovelace", rendered["plainText"])

    def test_test_send_token_is_required_for_real_campaign(self) -> None:
        admin = {"id": "admin_1", "role": "admin"}
        base_payload = {
            "templateId": "delegate_links_announcement",
            "subject": "Delegate Links are now available",
            "variables": {
                "doctor_name": "Dr. Ada Lovelace",
                "clinic_name": "Analytical Clinic",
                "delegate_links_url": "https://trufusionlabs.com/account?tab=delegate-links",
                "support_email": "support@trufusionlabs.com",
            },
        }

        with patch.object(email_campaign_service.email_service, "send_campaign_test_email") as send_test, \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"), \
            patch.object(email_campaign_service.email_campaign_repository, "create_campaign", side_effect=lambda campaign, _recipients: campaign), \
            patch.object(email_campaign_service.email_campaign_repository, "count_recipients_by_status", return_value={"pending": 1}):
            test_response = email_campaign_service.send_test_email(
                {**base_payload, "recipientEmail": "admin@example.com"},
                admin=admin,
            )
            campaign_response = email_campaign_service.create_campaign(
                {
                    **base_payload,
                    "recipientSelection": {"mode": "test", "testEmail": "admin@example.com"},
                    "confirmationText": "SEND",
                    "testToken": test_response["testToken"],
                },
                admin=admin,
            )

        send_test.assert_called_once()
        self.assertEqual(campaign_response["campaign"]["status"], "sending")
        self.assertEqual(campaign_response["campaign"]["recipientCount"], 1)

        with self.assertRaises(Exception):
            email_campaign_service.create_campaign(
                {
                    **base_payload,
                    "subject": "Changed subject",
                    "recipientSelection": {"mode": "test", "testEmail": "admin@example.com"},
                    "confirmationText": "SEND",
                    "testToken": test_response["testToken"],
                },
                admin=admin,
            )

    def test_worker_marks_sent_recipients(self) -> None:
        updates: list[tuple[str, str]] = []
        campaign_updates: list[tuple[str, str]] = []

        def update_recipient(recipient_id, status, **_kwargs):
            updates.append((recipient_id, status))

        def update_campaign(campaign_id, status, **_kwargs):
            campaign_updates.append((campaign_id, status))

        with patch.object(
            email_campaign_service.email_campaign_repository,
            "list_due_pending_recipients",
            return_value=[
                {
                    "recipient_id": "emr_1",
                    "campaign_id": "emc_1",
                    "recipient_email": "doctor@example.com",
                    "recipient_name": "Dr. Example",
                    "recipient_type": "physician",
                    "recipient_variables_json": {
                        "doctor_name": "Dr. Example",
                        "clinic_name": "Example Clinic",
                        "delegate_links_url": "https://trufusionlabs.com/account?tab=delegate-links",
                        "unsubscribe_url": "https://trufusionlabs.com/unsubscribe",
                        "support_email": "support@trufusionlabs.com",
                    },
                    "template_id": "delegate_links_announcement",
                    "campaign_type": "announcement",
                    "subject": "Delegate Links are now available",
                    "campaign_status": "sending",
                    "campaign_variables_json": {},
                }
            ],
        ), patch.object(email_campaign_service.email_campaign_repository, "is_unsubscribed", return_value=False), \
            patch.object(email_campaign_service.email_campaign_repository, "update_recipient_status", side_effect=update_recipient), \
            patch.object(email_campaign_service.email_campaign_repository, "update_campaign_status", side_effect=update_campaign), \
            patch.object(email_campaign_service.email_campaign_repository, "count_recipients_by_status", return_value={"pending": 0, "sent": 1}), \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"), \
            patch.object(email_campaign_service.email_service, "send_campaign_email") as send_email:
            result = email_campaign_service.process_pending_campaign_emails(limit=1, throttle_seconds=0)

        self.assertTrue(result["ok"])
        self.assertEqual(result["sent"], 1)
        self.assertIn(("emr_1", "sent"), updates)
        self.assertIn(("emc_1", "sent"), campaign_updates)
        send_email.assert_called_once()


if __name__ == "__main__":
    unittest.main()
