from __future__ import annotations

import os
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
        email_campaign_service._BOUNCE_LAST_POLL_MONOTONIC = 0.0

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

    def test_approved_templates_use_site_container_squircle_css(self) -> None:
        for template in email_campaign_service.list_templates()["templates"]:
            with self.subTest(template=template["id"]):
                rendered = email_campaign_service.render_email_template(template["id"], {})
                self.assertIn("border-radius:28px", rendered["html"])
                self.assertIn("corner-shape:squircle", rendered["html"])

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

        self.assertEqual(physicians["recipientCount"], 2)
        self.assertEqual(sales_reps["recipientCount"], 1)
        self.assertEqual(
            [recipient["email"] for recipient in physicians["recipients"]],
            ["verified@example.com", "doctor-account@example.com"],
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

    def test_custom_preview_html_is_cleaned_stored_and_bound_to_test_token(self) -> None:
        admin = {"id": "admin_1", "role": "admin"}
        captured: list[tuple[dict, list]] = []

        def create_campaign(campaign, recipients):
            captured.append((campaign, recipients))
            return campaign

        base_payload = {
            "templateId": "delegate_links_announcement",
            "subject": "Delegate Links are now available",
            "variables": {
                "doctor_name": "Dr. Ada Lovelace",
                "clinic_name": "Analytical Clinic",
                "delegate_links_url": "https://trufusionlabs.com/account?tab=delegate-links",
                "support_email": "support@trufusionlabs.com",
            },
            "customHtml": (
                '<!DOCTYPE html><html><head><style data-email-center-preview-containment>body{}</style></head>'
                '<body><p data-email-center-edit-target="true" contenteditable="true">'
                "Edited copy for Dr. Ada Lovelace"
                "</p>"
                '<img src="http://localhost/api/admin/email/assets/trufusion-logo?token=abc" />'
                '<script data-email-center-preview-editor>window.bad=true</script>'
                "</body></html>"
            ),
        }

        with patch.object(email_campaign_service.email_service, "send_campaign_test_email") as send_test, \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"), \
            patch.object(email_campaign_service.email_campaign_repository, "create_campaign", side_effect=create_campaign), \
            patch.object(email_campaign_service.email_campaign_repository, "count_recipients_by_status", return_value={"pending": 1}):
            test_response = email_campaign_service.send_test_email(
                {**base_payload, "recipientEmail": "admin@example.com"},
                admin=admin,
            )
            campaign_response = email_campaign_service.create_campaign(
                {
                    **base_payload,
                    "recipientSelection": {"mode": "custom", "customEmails": "doctor@example.com"},
                    "confirmationText": "SEND",
                    "testToken": test_response["testToken"],
                },
                admin=admin,
            )

        sent_html = send_test.call_args.args[2]
        self.assertIn("Edited copy for Dr. Ada Lovelace", sent_html)
        self.assertIn('src="cid:trufusion-logo"', sent_html)
        self.assertNotIn("data-email-center-preview-editor", sent_html)
        self.assertNotIn("contenteditable", sent_html)

        campaign_record = captured[0][0]
        stored_html = campaign_record["variables_json"][email_campaign_service._CUSTOM_HTML_VARIABLE_KEY]
        self.assertIn("{{ doctor_name }}", stored_html)
        self.assertIn('src="cid:trufusion-logo"', stored_html)
        self.assertNotIn("data-email-center-edit-target", stored_html)
        self.assertEqual(campaign_response["campaign"]["status"], "sending")
        self.assertIn("Edited copy", campaign_response["campaign"]["customHtml"])
        self.assertNotIn(email_campaign_service._CUSTOM_HTML_VARIABLE_KEY, campaign_response["campaign"]["variables"])

        with self.assertRaises(Exception):
            email_campaign_service.create_campaign(
                {
                    **base_payload,
                    "customHtml": base_payload["customHtml"].replace("Edited copy", "Changed copy"),
                    "recipientSelection": {"mode": "custom", "customEmails": "doctor@example.com"},
                    "confirmationText": "SEND",
                    "testToken": test_response["testToken"],
                },
                admin=admin,
            )

    def test_campaign_recipient_variables_are_built_from_recipient_profile(self) -> None:
        admin = {"id": "admin_1", "role": "admin"}
        captured: list[tuple[dict, list]] = []
        users = [
            {
                "email": "physician@example.com",
                "name": "Dr. Dynamic Profile",
                "role": "doctor",
                "npiVerification": {
                    "organizationName": "Dynamic Research Clinic",
                },
            }
        ]
        fake_user_repository = types.ModuleType("python_backend.repositories.user_repository")
        fake_user_repository.get_all = lambda: users

        def create_campaign(campaign, recipients):
            captured.append((campaign, list(recipients)))
            return campaign

        with patch.dict(sys.modules, {"python_backend.repositories.user_repository": fake_user_repository}), \
            patch.object(email_campaign_service, "_verify_test_token"), \
            patch.object(email_campaign_service.email_campaign_repository, "create_campaign", side_effect=create_campaign), \
            patch.object(email_campaign_service.email_campaign_repository, "count_recipients_by_status", return_value={"pending": 1}), \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"):
            email_campaign_service.create_campaign(
                {
                    "templateId": "delegate_links_announcement",
                    "subject": "Delegate Links are now available",
                    "variables": {
                        "doctor_name": "Dr. Static",
                        "clinic_name": "Static Clinic",
                        "delegate_links_url": "https://static.example.test",
                        "support_email": "support@trufusionlabs.com",
                    },
                    "recipientSelection": {"mode": "all_verified_physicians"},
                    "confirmationText": "SEND",
                    "testToken": "token",
                },
                admin=admin,
            )

        campaign_record, recipient_records = captured[0]
        self.assertNotIn("doctor_name", campaign_record["variables_json"])
        self.assertNotIn("clinic_name", campaign_record["variables_json"])
        self.assertNotIn("delegate_links_url", campaign_record["variables_json"])
        self.assertEqual(campaign_record["variables_json"]["support_email"], "support@trufusionlabs.com")
        self.assertEqual(len(recipient_records), 1)
        recipient_variables = recipient_records[0]["variables_json"]
        self.assertEqual(recipient_variables["doctor_name"], "Dr. Dynamic Profile")
        self.assertEqual(recipient_variables["clinic_name"], "Dynamic Research Clinic")
        self.assertIn("physician%40example.com", recipient_variables["unsubscribe_url"])

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

        with patch.object(email_campaign_service, "poll_bounce_mailbox", return_value={"ok": True, "processed": 0}), patch.object(
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

    def test_worker_polls_bounces_during_send_and_after_finish(self) -> None:
        poll_forces: list[bool] = []

        def fake_poll_bounces(*, force=False):
            poll_forces.append(bool(force))
            if force:
                return {
                    "ok": True,
                    "enabled": True,
                    "configured": True,
                    "processed": 0,
                    "duplicates": 0,
                    "matched": 0,
                    "scanned": 3,
                    "failed": 0,
                    "skipped": 0,
                }
            if len(poll_forces) == 1:
                return {
                    "ok": True,
                    "enabled": True,
                    "configured": True,
                    "processed": 0,
                    "duplicates": 0,
                    "matched": 0,
                    "scanned": 3,
                    "failed": 0,
                    "skipped": 0,
                }
            return {
                "ok": True,
                "enabled": True,
                "configured": True,
                "skipped": True,
                "processed": 0,
                "duplicates": 0,
                "matched": 0,
                "scanned": 0,
                "failed": 0,
            }

        with patch.object(email_campaign_service, "poll_bounce_mailbox", side_effect=fake_poll_bounces), patch.object(
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
            patch.object(email_campaign_service.email_campaign_repository, "update_recipient_status"), \
            patch.object(email_campaign_service.email_campaign_repository, "update_recipient_status_by_campaign_and_email", return_value=True), \
            patch.object(email_campaign_service.email_campaign_repository, "update_campaign_status"), \
            patch.object(
                email_campaign_service.email_campaign_repository,
                "get_recipient_by_campaign_and_email",
                return_value={"recipient_email": "doctor@example.com", "status": "sent_pending_bounce_check"},
            ), \
            patch.object(email_campaign_service.email_campaign_repository, "get_campaign", return_value={"id": "emc_1", "status": "sending", "recipient_count": 1}), \
            patch.object(
                email_campaign_service.email_campaign_repository,
                "count_recipients_by_status",
                side_effect=[
                    {"pending": 0, "processing": 0, "sent_pending_bounce_check": 1},
                    {"pending": 0, "sent": 1},
                ],
            ), \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"), \
            patch.object(email_campaign_service.email_service, "send_campaign_email"), \
            patch.object(email_campaign_service, "_notify_email_campaigns_changed") as notify_changed:
            result = email_campaign_service.process_pending_campaign_emails(limit=1, throttle_seconds=0)

        self.assertEqual(poll_forces, [False, False, True])
        self.assertTrue(result["finalBouncePollForced"])
        self.assertEqual(result["bouncesProcessed"], 0)
        self.assertEqual(result["bouncePollSummary"]["processed"], 0)
        self.assertTrue(
            any(
                call.kwargs.get("event") == "campaign_recipient_status_changed"
                and call.kwargs.get("recipientStatus") == "sent"
                for call in notify_changed.call_args_list
            )
        )
        self.assertTrue(
            any(
                call.kwargs.get("event") == "campaign_recipient_status_changed"
                and call.kwargs.get("recipientStatus") == "sent_pending_bounce_check"
                for call in notify_changed.call_args_list
            )
        )

    def test_worker_does_not_mark_sent_when_bounce_poll_finds_failure(self) -> None:
        def fake_poll_bounces(*, force=False):
            return {
                "ok": True,
                "enabled": True,
                "configured": True,
                "processed": 1 if force else 0,
                "duplicates": 0,
                "matched": 1 if force else 0,
                "scanned": 3,
                "failed": 0,
                "skipped": 0,
            }

        with patch.object(email_campaign_service, "poll_bounce_mailbox", side_effect=fake_poll_bounces), patch.object(
            email_campaign_service.email_campaign_repository,
            "list_due_pending_recipients",
            return_value=[
                {
                    "recipient_id": "emr_1",
                    "campaign_id": "emc_1",
                    "recipient_email": "bad@example.com",
                    "recipient_name": "Bad Address",
                    "recipient_type": "custom",
                    "recipient_variables_json": {
                        "doctor_name": "Bad Address",
                        "clinic_name": "",
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
            patch.object(email_campaign_service.email_campaign_repository, "update_recipient_status"), \
            patch.object(email_campaign_service.email_campaign_repository, "update_recipient_status_by_campaign_and_email") as update_by_email, \
            patch.object(email_campaign_service.email_campaign_repository, "update_campaign_status"), \
            patch.object(
                email_campaign_service.email_campaign_repository,
                "get_recipient_by_campaign_and_email",
                return_value={"recipient_email": "bad@example.com", "status": "failed"},
            ), \
            patch.object(email_campaign_service.email_campaign_repository, "get_campaign", return_value={"id": "emc_1", "status": "sending", "recipient_count": 1}), \
            patch.object(
                email_campaign_service.email_campaign_repository,
                "count_recipients_by_status",
                side_effect=[
                    {"pending": 0, "processing": 0, "sent_pending_bounce_check": 1},
                    {"pending": 0, "failed": 1},
                ],
            ), \
            patch.object(email_campaign_service.email_campaign_repository, "log_event"), \
            patch.object(email_campaign_service.email_service, "send_campaign_email"), \
            patch.object(email_campaign_service, "_notify_email_campaigns_changed"):
            result = email_campaign_service.process_pending_campaign_emails(limit=1, throttle_seconds=0)

        self.assertTrue(result["finalBouncePollForced"])
        self.assertEqual(result["bouncesProcessed"], 1)
        self.assertEqual(result["sent"], 0)
        update_by_email.assert_not_called()

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

    def test_process_bounce_notification_marks_recipient_failed(self) -> None:
        bounce = """
Reporting-MTA: dns; googlemail.com
Final-Recipient: rfc822; bad@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.
X-Trufusion-Campaign-Id: emc_test123
X-Original-Message-ID: <message@example.com>
"""
        campaign = {
            "id": "emc_test123",
            "status": "sent",
            "recipient_count": 1,
        }
        recipient = {
            "id": "emr_1",
            "campaign_id": "emc_test123",
            "recipient_email": "bad@example.com",
            "status": "sent",
        }

        with patch.object(
            email_campaign_service.email_campaign_repository,
            "get_campaign",
            return_value=campaign,
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "get_recipient_by_campaign_and_email",
            return_value=recipient,
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "update_recipient_status_by_campaign_and_email",
            return_value=True,
        ) as update_recipient, patch.object(
            email_campaign_service.email_campaign_repository,
            "log_event",
        ) as log_event, patch.object(
            email_campaign_service.email_campaign_repository,
            "count_recipients_by_status",
            return_value={"failed": 1},
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "update_campaign_status",
        ) as update_campaign, patch.object(
            email_campaign_service,
            "_notify_email_campaigns_changed",
        ) as notify_changed:
            response = email_campaign_service.process_bounce_notification(
                {"rawEmail": bounce},
                admin={"id": "admin_1"},
            )

        self.assertTrue(response["ok"])
        self.assertEqual(response["campaignId"], "emc_test123")
        self.assertEqual(response["recipientEmail"], "bad@example.com")
        update_recipient.assert_called_once()
        self.assertEqual(update_recipient.call_args.args[:3], ("emc_test123", "bad@example.com", "failed"))
        self.assertIn("does not exist", update_recipient.call_args.kwargs["error_message"])
        log_event.assert_called_once()
        self.assertEqual(log_event.call_args.kwargs["event_type"], "bounced")
        update_campaign.assert_called_once()
        self.assertEqual(update_campaign.call_args.args[:2], ("emc_test123", "failed"))
        notify_changed.assert_called_once()

    def test_process_bounce_notification_extracts_campaign_id_fallback(self) -> None:
        bounce = """
From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
Subject: Delivery Status Notification (Failure)

Reporting-MTA: dns; googlemail.com
Final-Recipient: rfc822; bad@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 No such user

Delivery failed for campaign emc_test123.
"""

        with patch.object(
            email_campaign_service.email_campaign_repository,
            "get_campaign",
            return_value={"id": "emc_test123", "status": "sent", "recipient_count": 1},
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "get_recipient_by_campaign_and_email",
            return_value={"recipient_email": "bad@example.com", "status": "sent"},
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "update_recipient_status_by_campaign_and_email",
            return_value=True,
        ) as update_recipient, patch.object(
            email_campaign_service.email_campaign_repository,
            "log_event",
        ) as log_event, patch.object(
            email_campaign_service.email_campaign_repository,
            "count_recipients_by_status",
            return_value={"failed": 1},
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "update_campaign_status",
        ), patch.object(
            email_campaign_service,
            "_notify_email_campaigns_changed",
        ):
            response = email_campaign_service.process_bounce_notification({"rawEmail": bounce})

        self.assertTrue(response["ok"])
        self.assertEqual(response["campaignId"], "emc_test123")
        self.assertEqual(response["recipientEmail"], "bad@example.com")
        update_recipient.assert_called_once()
        self.assertEqual(update_recipient.call_args.args[:3], ("emc_test123", "bad@example.com", "failed"))
        log_event.assert_called_once()

    def test_process_bounce_notification_is_idempotent_for_failed_recipient(self) -> None:
        with patch.object(
            email_campaign_service.email_campaign_repository,
            "get_campaign",
            return_value={"id": "emc_1", "status": "failed", "recipient_count": 1},
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "get_recipient_by_campaign_and_email",
            return_value={"recipient_email": "linden@peppro.net", "status": "failed"},
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "count_recipients_by_status",
            return_value={"failed": 1},
        ), patch.object(
            email_campaign_service.email_campaign_repository,
            "update_recipient_status_by_campaign_and_email",
        ) as update_recipient, patch.object(
            email_campaign_service.email_campaign_repository,
            "log_event",
        ) as log_event:
            response = email_campaign_service.process_bounce_notification(
                {
                    "campaignId": "emc_1",
                    "recipientEmail": "linden@peppro.net",
                    "status": "5.1.1",
                    "diagnostic": "No such user",
                }
            )

        self.assertTrue(response["ok"])
        self.assertTrue(response["duplicate"])
        update_recipient.assert_not_called()
        log_event.assert_not_called()

    def test_poll_bounce_mailbox_processes_campaign_dsn(self) -> None:
        raw_message = b"""
From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
Subject: Address not found

Reporting-MTA: dns; googlemail.com
Final-Recipient: rfc822; linden@peppro.net
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.
X-Trufusion-Campaign-Id: emc_50551b84e9c97f157de1a3cc
"""

        class FakeImap:
            def __init__(self, *_args, **_kwargs):
                pass

            def login(self, _user, _password):
                return "OK", [b""]

            def select(self, _mailbox, readonly=True):
                return "OK", [b"1"]

            def search(self, *_args):
                return "OK", [b"1"]

            def fetch(self, _message_id, _query):
                return "OK", [(b"1 (RFC822 {100}", raw_message)]

            def logout(self):
                return "OK", [b""]

        with patch.dict(
            os.environ,
            {
                "EMAIL_BOUNCE_POLL_ENABLED": "true",
                "EMAIL_BOUNCE_IMAP_HOST": "imap.gmail.com",
                "EMAIL_BOUNCE_IMAP_USER": "support@trufusionlabs.com",
                "EMAIL_BOUNCE_IMAP_PASS": "secret",
            },
            clear=False,
        ), patch.object(
            email_campaign_service.imaplib,
            "IMAP4_SSL",
            FakeImap,
        ), patch.object(
            email_campaign_service,
            "process_bounce_notification",
            return_value={"ok": True, "campaignId": "emc_50551b84e9c97f157de1a3cc"},
        ) as process_bounce, patch.object(
            email_campaign_service,
            "_notify_email_campaigns_changed",
        ) as notify_changed:
            response = email_campaign_service.poll_bounce_mailbox(force=True)

        self.assertTrue(response["ok"])
        self.assertEqual(response["scanned"], 1)
        self.assertEqual(response["matched"], 1)
        self.assertEqual(response["processed"], 1)
        process_bounce.assert_called_once()
        self.assertIn("emc_50551b84e9c97f157de1a3cc", process_bounce.call_args.args[0]["rawEmail"])
        notify_changed.assert_called_once()

    def test_poll_bounce_mailbox_reports_disabled_when_imap_env_missing(self) -> None:
        with patch.dict(os.environ, {}, clear=True), patch.object(
            email_campaign_service.imaplib,
            "IMAP4_SSL",
        ) as imap_ssl:
            response = email_campaign_service.poll_bounce_mailbox(force=True)

        self.assertTrue(response["ok"])
        self.assertFalse(response["enabled"])
        self.assertFalse(response["configured"])
        self.assertEqual(response["scanned"], 0)
        self.assertEqual(response["matched"], 0)
        self.assertEqual(response["processed"], 0)
        self.assertEqual(response["duplicates"], 0)
        self.assertEqual(response["skipped"], 0)
        self.assertEqual(response["failed"], 0)
        imap_ssl.assert_not_called()

    def test_poll_bounce_mailbox_counts_duplicate_bounces(self) -> None:
        raw_message = b"""
From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
Subject: Address not found

Reporting-MTA: dns; googlemail.com
Final-Recipient: rfc822; bad@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 No such user
X-Trufusion-Campaign-Id: emc_test123
"""

        class FakeImap:
            def __init__(self, *_args, **_kwargs):
                pass

            def login(self, _user, _password):
                return "OK", [b""]

            def select(self, _mailbox, readonly=True):
                return "OK", [b"1"]

            def search(self, *_args):
                return "OK", [b"1"]

            def fetch(self, _message_id, _query):
                return "OK", [(b"1 (RFC822 {100}", raw_message)]

            def logout(self):
                return "OK", [b""]

        with patch.dict(
            os.environ,
            {
                "EMAIL_BOUNCE_POLL_ENABLED": "true",
                "EMAIL_BOUNCE_IMAP_HOST": "imap.gmail.com",
                "EMAIL_BOUNCE_IMAP_USER": "support@trufusionlabs.com",
                "EMAIL_BOUNCE_IMAP_PASS": "secret",
            },
            clear=False,
        ), patch.object(
            email_campaign_service.imaplib,
            "IMAP4_SSL",
            FakeImap,
        ), patch.object(
            email_campaign_service,
            "process_bounce_notification",
            return_value={"ok": True, "duplicate": True, "campaignId": "emc_test123"},
        ), patch.object(
            email_campaign_service,
            "_notify_email_campaigns_changed",
        ) as notify_changed:
            response = email_campaign_service.poll_bounce_mailbox(force=True)

        self.assertTrue(response["ok"])
        self.assertEqual(response["scanned"], 1)
        self.assertEqual(response["matched"], 1)
        self.assertEqual(response["processed"], 0)
        self.assertEqual(response["duplicates"], 1)
        notify_changed.assert_not_called()


if __name__ == "__main__":
    unittest.main()
