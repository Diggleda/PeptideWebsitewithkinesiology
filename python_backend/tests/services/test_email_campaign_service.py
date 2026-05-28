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

    def test_preview_template_rewrites_cids_to_signed_preview_assets(self) -> None:
        with patch.object(email_campaign_service.email_campaign_repository, "log_event"):
            rendered = email_campaign_service.preview_template(
                "delegate_links_announcement",
                {"doctor_name": "Dr. Ada Lovelace"},
                admin_id="admin_1",
                asset_base_url="https://api.example.test/api/admin/email/assets",
            )

        self.assertIn(
            'src="https://api.example.test/api/admin/email/assets/trufusion-logo?token=',
            rendered["html"],
        )
        self.assertIn(
            'src="https://api.example.test/api/admin/email/assets/delegate-links-create-dialog?token=',
            rendered["html"],
        )
        self.assertIn(
            'src="https://api.example.test/api/admin/email/assets/delegate-links-proposal-session?token=',
            rendered["html"],
        )
        self.assertNotIn('src="cid:trufusion-logo"', rendered["html"])
        self.assertNotIn("data:image", rendered["html"])
        self.assertEqual(
            set(rendered["previewAssetUrls"]),
            {
                "trufusion-logo",
                "delegate-links-create-dialog",
                "delegate-links-proposal-session",
            },
        )

    def test_draft_counts_test_recipient_and_preserves_schedule(self) -> None:
        admin = {"id": "admin_1", "role": "admin"}
        captured: list[tuple[dict, list]] = []

        def create_campaign(campaign, recipients):
            captured.append((campaign, list(recipients)))
            return campaign

        with patch.object(email_campaign_service.email_campaign_repository, "create_campaign", side_effect=create_campaign), \
            patch.object(email_campaign_service.email_campaign_repository, "count_recipients_by_status", return_value={}), \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"):
            response = email_campaign_service.create_campaign(
                {
                    "templateId": "delegate_links_announcement",
                    "subject": "Delegate Links are now available",
                    "variables": {
                        "doctor_name": "Dr. Ada Lovelace",
                        "clinic_name": "Analytical Clinic",
                        "delegate_links_url": "https://trufusionlabs.com/account?tab=delegate-links",
                        "support_email": "support@trufusionlabs.com",
                    },
                    "recipientSelection": {"mode": "test", "testEmail": "admin@example.com"},
                    "status": "draft",
                    "scheduledAt": "2030-01-02T03:04:00Z",
                },
                admin=admin,
            )

        self.assertEqual(response["campaign"]["status"], "draft")
        self.assertEqual(response["campaign"]["recipientCount"], 1)
        self.assertEqual(response["campaign"]["scheduledAt"], "2030-01-02T03:04:00Z")
        self.assertEqual(captured[0][0]["recipient_count"], 1)
        self.assertEqual(captured[0][1], [])

    def test_delete_draft_campaign_rejects_non_drafts(self) -> None:
        with patch.object(
            email_campaign_service.email_campaign_repository,
            "get_campaign",
            return_value={"id": "emc_1", "status": "sending"},
        ), patch.object(email_campaign_service.email_campaign_repository, "delete_draft_campaign") as delete_draft:
            with self.assertRaises(Exception):
                email_campaign_service.delete_draft_campaign("emc_1", admin={"id": "admin_1"})

        delete_draft.assert_not_called()

    def test_unsubscribe_records_address_and_event_without_campaign_id(self) -> None:
        token = email_campaign_service._build_unsubscribe_token("diggleda@icloud.com")

        with patch.object(
            email_campaign_service.email_campaign_repository,
            "add_unsubscribe",
            return_value={"recipient_email": "diggleda@icloud.com"},
        ) as add_unsubscribe, patch.object(
            email_campaign_service.email_campaign_repository,
            "log_event",
        ) as log_event:
            result = email_campaign_service.unsubscribe("diggleda@icloud.com", token, "")

        self.assertTrue(result["ok"])
        add_unsubscribe.assert_called_once()
        self.assertEqual(add_unsubscribe.call_args.kwargs["email"], "diggleda@icloud.com")
        self.assertIsNone(add_unsubscribe.call_args.kwargs["campaign_id"])
        log_event.assert_called_once()
        self.assertEqual(log_event.call_args.kwargs["event_type"], "unsubscribed")
        self.assertEqual(log_event.call_args.kwargs["recipient_email"], "diggleda@icloud.com")

    def test_estimate_recipients_counts_bulk_groups(self) -> None:
        users = [
            {"email": "verified@example.com", "role": "doctor", "emailVerifiedAt": "2026-01-01T00:00:00Z"},
            {"email": "testdoctor@example.com", "role": "test_doctor", "email_verified_at": "2026-01-01T00:00:00Z"},
            {"email": "doctor-account@example.com", "role": "doctor"},
            {"email": "inactive@example.com", "role": "doctor", "emailVerifiedAt": "2026-01-01T00:00:00Z", "status": "inactive"},
            {"email": "rep-user@example.com", "role": "sales_rep", "emailVerifiedAt": "2026-01-01T00:00:00Z"},
        ]
        reps = [
            {"email": "active.rep@example.com", "name": "Active Rep", "status": "active"},
            {"email": "disabled.rep@example.com", "name": "Disabled Rep", "status": "disabled"},
            {"email": None, "name": "Missing Email", "status": "active"},
        ]
        fake_user_repository = types.ModuleType("python_backend.repositories.user_repository")
        fake_user_repository.get_all = lambda: users
        fake_sales_rep_repository = types.ModuleType("python_backend.repositories.sales_rep_repository")
        fake_sales_rep_repository.get_all = lambda: reps

        with patch.dict(
            sys.modules,
            {
                "python_backend.repositories.user_repository": fake_user_repository,
                "python_backend.repositories.sales_rep_repository": fake_sales_rep_repository,
            },
        ):
            physicians = email_campaign_service.estimate_recipients(
                {
                    "templateId": "delegate_links_announcement",
                    "recipientSelection": {"mode": "all_verified_physicians"},
                }
            )
            sales_reps = email_campaign_service.estimate_recipients(
                {
                    "templateId": "delegate_links_announcement",
                    "recipientSelection": {"mode": "sales_reps"},
                }
            )

        self.assertEqual(physicians["recipientCount"], 3)
        self.assertEqual(sales_reps["recipientCount"], 1)
        self.assertEqual(
            [recipient["email"] for recipient in physicians["recipients"]],
            ["verified@example.com", "testdoctor@example.com", "doctor-account@example.com"],
        )
        self.assertEqual(sales_reps["recipients"][0]["email"], "active.rep@example.com")

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
            self.assertEqual(test_response["recipientCount"], 1)
            campaign_response = email_campaign_service.create_campaign(
                {
                    **base_payload,
                    "recipientSelection": {"mode": "custom", "customEmails": "doctor@example.com"},
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
                    "recipientSelection": {"mode": "custom", "customEmails": "doctor@example.com"},
                    "confirmationText": "SEND",
                },
                admin=admin,
            )

        with self.assertRaises(Exception):
            email_campaign_service.create_campaign(
                {
                    **base_payload,
                    "subject": "Changed subject",
                    "recipientSelection": {"mode": "custom", "customEmails": "doctor@example.com"},
                    "confirmationText": "SEND",
                    "testToken": test_response["testToken"],
                },
                admin=admin,
            )

    def test_test_only_campaign_does_not_require_preflight_test_token(self) -> None:
        admin = {"id": "admin_1", "role": "admin"}

        with patch.object(email_campaign_service.email_campaign_repository, "create_campaign", side_effect=lambda campaign, _recipients: campaign), \
            patch.object(email_campaign_service.email_campaign_repository, "count_recipients_by_status", return_value={"pending": 1}), \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"):
            campaign_response = email_campaign_service.create_campaign(
                {
                    "templateId": "delegate_links_announcement",
                    "subject": "Delegate Links are now available",
                    "variables": {
                        "doctor_name": "Dr. Ada Lovelace",
                        "clinic_name": "Analytical Clinic",
                        "delegate_links_url": "https://trufusionlabs.com/account?tab=delegate-links",
                        "support_email": "support@trufusionlabs.com",
                    },
                    "recipientSelection": {"mode": "test", "testEmail": "admin@example.com"},
                    "confirmationText": "SEND",
                },
                admin=admin,
            )

        self.assertEqual(campaign_response["campaign"]["status"], "sending")
        self.assertEqual(campaign_response["campaign"]["recipientCount"], 1)

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

    def test_sent_campaign_list_promotes_due_scheduled_campaigns(self) -> None:
        campaign = {
            "id": "emc_1",
            "campaign_type": "announcement",
            "template_id": "delegate_links_announcement",
            "subject": "Delegate Links are now available",
            "created_by_admin_id": "admin_1",
            "status": "sending",
            "recipient_count": 1,
            "variables_json": {},
            "created_at": "2026-05-28T00:00:00Z",
            "scheduled_at": "2026-05-28T00:00:00Z",
            "sent_at": None,
        }

        with patch.object(
            email_campaign_service.email_campaign_repository,
            "promote_due_scheduled_campaigns",
            return_value=1,
        ) as promote_due, patch.object(
            email_campaign_service.email_campaign_repository,
            "list_campaigns",
            return_value=[campaign],
        ) as list_campaigns, patch.object(
            email_campaign_service.email_campaign_repository,
            "count_recipients_by_status",
            return_value={"pending": 1},
        ), patch.object(
            email_campaign_service,
            "_notify_email_campaigns_changed",
        ) as notify_changed, patch.object(
            email_campaign_service,
            "kick_due_campaign_processing",
        ) as kick_due:
            response = email_campaign_service.list_campaigns(status="sent")

        promote_due.assert_called_once()
        list_campaigns.assert_called_once_with(status="sent", limit=50)
        notify_changed.assert_called_once()
        kick_due.assert_called_once()
        self.assertEqual(response["campaigns"][0]["status"], "sending")


if __name__ == "__main__":
    unittest.main()
