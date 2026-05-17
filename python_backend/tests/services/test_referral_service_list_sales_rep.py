from __future__ import annotations

import types
import unittest
from unittest.mock import patch

service = None


class ListReferralsForSalesRepOwnershipTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        global service
        if service is not None:
            return
        try:
            from python_backend.tests.test_contact_form_encrypted_reads import _install_test_stubs
        except ModuleNotFoundError:
            _install_test_stubs = None
        if _install_test_stubs is not None:
            _install_test_stubs()
        try:
            from python_backend.services import referral_service as imported_service
        except ModuleNotFoundError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc
        service = imported_service

    def _run_list_referrals(self, *, scope_all: bool) -> list[dict]:
        admin_user = {
            "id": "admin-1",
            "role": "admin",
            "email": "admin@example.com",
            "salesRepId": None,
        }
        doctor_user = {
            "id": "doctor-1",
            "role": "doctor",
            "email": "doctor@example.com",
            "salesRepId": "rep-kristen",
            "createdAt": "2026-04-10T00:00:00Z",
        }
        prospect = {
            "id": "prospect-1",
            "salesRepId": "admin-1",
            "contactName": "Doctor Example",
            "contactEmail": "doctor@example.com",
            "status": "pending",
            "createdAt": "2026-04-10T00:00:00Z",
            "updatedAt": "2026-04-10T00:00:00Z",
        }

        def find_by_id(identifier: str):
            mapping = {
                "admin-1": admin_user,
                "doctor-1": doctor_user,
            }
            return mapping.get(str(identifier))

        def find_by_email(email: str):
            normalized = str(email or "").strip().lower()
            if normalized == "doctor@example.com":
                return doctor_user
            if normalized == "admin@example.com":
                return admin_user
            return None

        def find_by_sales_rep(identifier: str):
            return [prospect] if str(identifier) == "admin-1" else []

        def resolve_aliases(identifiers):
            return {str(value).strip() for value in identifiers if str(value).strip()}

        with patch.object(service, "_resolve_sales_rep_id", return_value=None), \
            patch.object(service, "_resolve_sales_rep_aliases", side_effect=resolve_aliases), \
            patch.object(service, "_load_contact_form_referrals", return_value=[]), \
            patch.object(service, "count_orders_for_doctor", return_value=0), \
            patch.object(service.user_repository, "find_by_id", side_effect=find_by_id), \
            patch.object(service.user_repository, "find_by_email", side_effect=find_by_email), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep", side_effect=find_by_sales_rep), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[prospect]):
            return service.list_referrals_for_sales_rep(
                "admin-1",
                scope_all=scope_all,
                token_role="admin",
            )

    def test_hides_lead_when_linked_account_belongs_to_other_rep(self) -> None:
        result = self._run_list_referrals(scope_all=False)

        self.assertEqual(result, [])

    def test_scope_all_keeps_lead_visible_for_admin_overview(self) -> None:
        result = self._run_list_referrals(scope_all=True)

        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["id"], "prospect-1")
        self.assertEqual(result[0]["referredContactAccountId"], "doctor-1")

    def test_admin_mine_scope_includes_house_contact_forms(self) -> None:
        admin_user = {
            "id": "admin-1",
            "role": "admin",
            "email": "admin@example.com",
            "salesRepId": None,
        }
        own_prospect = {
            "id": "prospect-own",
            "salesRepId": "admin-1",
            "contactName": "Own Lead",
            "contactEmail": "own-lead@example.com",
            "status": "pending",
            "createdAt": "2026-04-10T00:00:00Z",
            "updatedAt": "2026-04-10T00:00:00Z",
        }
        house_prospect = {
            "id": "contact_form:42",
            "salesRepId": None,
            "referredContactName": "House Lead",
            "referredContactEmail": "house-lead@example.com",
            "status": "contact_form",
            "createdAt": "2026-04-11T00:00:00Z",
            "updatedAt": "2026-04-11T00:00:00Z",
        }
        other_prospect = {
            "id": "prospect-other",
            "salesRepId": "rep-other",
            "contactName": "Other Lead",
            "contactEmail": "other-lead@example.com",
            "status": "pending",
            "createdAt": "2026-04-12T00:00:00Z",
            "updatedAt": "2026-04-12T00:00:00Z",
        }

        def find_by_sales_rep(identifier: str):
            mapping = {
                "admin-1": [own_prospect],
                "house": [house_prospect],
                "rep-other": [other_prospect],
            }
            return mapping.get(str(identifier), [])

        with patch.object(service, "_resolve_sales_rep_id", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value=None), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", return_value={"admin-1"}), \
            patch.object(service, "_resolve_sales_rep_aliases", return_value={"admin-1"}), \
            patch.object(service, "count_orders_for_doctor", return_value=0), \
            patch.object(service.user_repository, "find_by_id", side_effect=lambda identifier: admin_user if str(identifier) == "admin-1" else None), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep", side_effect=find_by_sales_rep), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[own_prospect, house_prospect, other_prospect]), \
            patch.object(service, "_load_contact_form_referrals", return_value=[house_prospect]) as load_contact_forms:
            result = service.list_referrals_for_sales_rep(
                "admin-1",
                scope_all=False,
                token_role="admin",
            )

        self.assertEqual([row["id"] for row in result], ["contact_form:42", "prospect-own"])
        self.assertEqual(
            [call.kwargs for call in load_contact_forms.call_args_list],
            [{"sales_rep_id": "admin-1"}, {"sales_rep_id": None}],
        )

    def test_scope_all_keeps_all_leads_visible_for_sales_lead_overview(self) -> None:
        sales_lead_user = {
            "id": "sales-lead-1",
            "role": "sales_lead",
            "email": "lead@example.com",
            "salesRepId": None,
        }
        own_prospect = {
            "id": "prospect-own",
            "salesRepId": "sales-lead-1",
            "contactName": "Own Doctor",
            "contactEmail": "own-doctor@example.com",
            "status": "pending",
            "createdAt": "2026-04-10T00:00:00Z",
            "updatedAt": "2026-04-10T00:00:00Z",
        }
        other_prospect = {
            "id": "prospect-other",
            "salesRepId": "rep-other",
            "contactName": "Other Doctor",
            "contactEmail": "other-doctor@example.com",
            "status": "pending",
            "createdAt": "2026-04-11T00:00:00Z",
            "updatedAt": "2026-04-11T00:00:00Z",
        }
        house_contact_form_lead = {
            "id": "contact_form:1",
            "salesRepId": None,
            "referredContactName": "House Lead",
            "referredContactEmail": "house-lead@example.com",
            "status": "contact_form",
            "createdAt": "2026-04-12T00:00:00Z",
        }

        def find_by_id(identifier: str):
            return sales_lead_user if str(identifier) == "sales-lead-1" else None

        def find_by_sales_rep(identifier: str):
            return [own_prospect] if str(identifier) == "sales-lead-1" else []

        with patch.object(service, "_resolve_sales_rep_id", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value=None), \
            patch.object(service, "_load_contact_form_referrals", return_value=[house_contact_form_lead]), \
            patch.object(service, "count_orders_for_doctor", return_value=0), \
            patch.object(service.user_repository, "find_by_id", side_effect=find_by_id), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep", side_effect=find_by_sales_rep), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[own_prospect, other_prospect]):
            result = service.list_referrals_for_sales_rep(
                "sales-lead-1",
                scope_all=True,
                token_role="sales_lead",
            )

        self.assertEqual(
            {row["id"] for row in result},
            {"prospect-own", "prospect-other", "contact_form:1"},
        )

    def test_scoped_contact_form_lead_hydrates_type_from_contact_form_row(self) -> None:
        rep_user = {
            "id": "rep-1",
            "role": "sales_rep",
            "email": "rep@example.com",
            "salesRepId": "rep-1",
        }
        prospect = {
            "id": "contact_form:42",
            "salesRepId": "rep-1",
            "contactFormId": "42",
            "status": "contact_form",
            "createdAt": "2026-04-09T00:00:00Z",
            "updatedAt": "2026-04-09T00:00:00Z",
        }

        def fetch_one(query: str, _params=None):
            if "FROM contact_forms" not in query:
                return None
            return {
                "id": 42,
                "name": "Join Lead",
                "email": "join@example.com",
                "phone": "555-0100",
                "message": "LinkedIn",
                "message_field_key": "heard_about_us",
                "message_label": "How did you hear about us?",
                "source": "join_network",
                "created_at": "2026-04-08T00:00:00Z",
            }

        with patch.object(service, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": True})), \
            patch.object(service.mysql_client, "fetch_one", side_effect=fetch_one), \
            patch.object(service, "decrypt_text", return_value=None), \
            patch.object(service, "_resolve_sales_rep_id", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value=None), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", return_value={"rep-1"}), \
            patch.object(service, "_resolve_sales_rep_aliases", return_value={"rep-1"}), \
            patch.object(service.user_repository, "find_by_id", side_effect=lambda identifier: rep_user if str(identifier) == "rep-1" else None), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep", return_value=[prospect]):
            result = service.list_referrals_for_sales_rep("rep-1", scope_all=False, token_role="sales_rep")

        self.assertEqual(len(result), 1)
        lead = result[0]
        self.assertEqual(lead["id"], "contact_form:42")
        self.assertEqual(lead["contactFormId"], "42")
        self.assertEqual(lead["contactFormSource"], "join_network")
        self.assertEqual(lead["contactFormMessage"], "LinkedIn")
        self.assertEqual(lead["contactFormMessageFieldKey"], "heard_about_us")
        self.assertEqual(lead["contactFormMessageLabel"], "How did you hear about us?")
        self.assertEqual(lead["referredContactName"], "Join Lead")
        self.assertEqual(lead["referredContactEmail"], "join@example.com")
        self.assertEqual(lead["referredContactPhone"], "555-0100")

    def test_scoped_contact_form_lead_uses_payload_type_when_row_unavailable(self) -> None:
        rep_user = {
            "id": "rep-1",
            "role": "sales_rep",
            "email": "rep@example.com",
            "salesRepId": "rep-1",
        }
        prospect = {
            "id": "contact_form:77",
            "salesRepId": "rep-1",
            "contactFormId": "77",
            "status": "contact_form",
            "sourcePayloadJson": {
                "source": "partner_application",
                "contactName": "Partner Lead",
                "contactEmail": "partner@example.com",
                "message": "We can co-market.",
                "messageFieldKey": "partnership_fit",
                "messageLabel": "How can we help each other?",
            },
            "createdAt": "2026-04-09T00:00:00Z",
            "updatedAt": "2026-04-09T00:00:00Z",
        }

        with patch.object(service, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": False})), \
            patch.object(service, "_resolve_sales_rep_id", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value=None), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", return_value={"rep-1"}), \
            patch.object(service, "_resolve_sales_rep_aliases", return_value={"rep-1"}), \
            patch.object(service.user_repository, "find_by_id", side_effect=lambda identifier: rep_user if str(identifier) == "rep-1" else None), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep", return_value=[prospect]):
            result = service.list_referrals_for_sales_rep("rep-1", scope_all=False, token_role="sales_rep")

        self.assertEqual(len(result), 1)
        lead = result[0]
        self.assertEqual(lead["contactFormSource"], "partner_application")
        self.assertEqual(lead["contactFormMessage"], "We can co-market.")
        self.assertEqual(lead["contactFormMessageFieldKey"], "partnership_fit")
        self.assertEqual(lead["contactFormMessageLabel"], "How can we help each other?")
        self.assertEqual(lead["referredContactName"], "Partner Lead")
        self.assertEqual(lead["referredContactEmail"], "partner@example.com")

    def test_strict_load_raises_when_scoped_contact_forms_fail(self) -> None:
        rep_user = {
            "id": "rep-1",
            "role": "sales_rep",
            "email": "rep@example.com",
            "salesRepId": "rep-1",
        }

        with patch.object(service, "_resolve_sales_rep_id", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value=None), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", return_value={"rep-1"}), \
            patch.object(service.user_repository, "find_by_id", side_effect=lambda identifier: rep_user if str(identifier) == "rep-1" else None), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep", return_value=[]), \
            patch.object(service, "_load_contact_form_referrals", side_effect=RuntimeError("database unavailable")):
            with self.assertRaises(Exception) as context:
                service.list_referrals_for_sales_rep(
                    "rep-1",
                    scope_all=False,
                    token_role="sales_rep",
                    strict_load=True,
                )

        self.assertEqual(getattr(context.exception, "status", None), 503)
        self.assertEqual(str(context.exception), "Unable to load active prospects")

    def test_contact_form_status_update_reuses_existing_lead_by_email(self) -> None:
        existing_lead = {
            "id": "ref-1",
            "salesRepId": "rep-1",
            "referralId": "ref-1",
            "contactName": "Existing Doctor",
            "contactEmail": "doctor@example.com",
            "contactEmails": ["doctor@example.com"],
            "status": "pending",
            "createdAt": "2026-04-01T00:00:00Z",
            "updatedAt": "2026-04-01T00:00:00Z",
        }
        contact_form_prospect = {
            "id": "contact_form:42",
            "salesRepId": "rep-1",
            "contactFormId": "42",
            "contactName": "Existing Doctor",
            "contactEmail": "doctor@example.com",
            "contactEmails": ["doctor@example.com"],
            "status": "contact_form",
        }
        contact_form_row = {
            "id": 42,
            "name": "Existing Doctor",
            "email": "doctor@example.com",
            "phone": "555-0100",
            "message": "Please call me.",
            "message_field_key": "question",
            "message_label": "Type your question here:",
            "source": "question",
            "created_at": "2026-04-02T00:00:00Z",
        }

        def fake_upsert(payload, **_kwargs):
            return {**existing_lead, **payload, "updatedAt": "2026-04-02T00:00:00Z"}

        with patch.object(service.mysql_client, "fetch_one", return_value=contact_form_row), \
            patch.object(service, "decrypt_text", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value="rep-1"), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", return_value={"rep-1"}), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep_and_contact_email", return_value=existing_lead), \
            patch.object(service.sales_prospect_repository, "find_by_contact_email", return_value=contact_form_prospect), \
            patch.object(service.sales_prospect_repository, "find_by_contact_phone", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_doctor_id", return_value=None), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[contact_form_prospect, existing_lead]), \
            patch.object(service.sales_prospect_repository, "upsert", side_effect=fake_upsert) as upsert, \
            patch.object(service.sales_prospect_repository, "delete_by_contact_form_id", return_value=True) as delete_by_contact, \
            patch.object(service, "_apply_referred_contact_account_fields", side_effect=lambda record: record):
            result = service.update_referral_for_sales_rep(
                "contact_form:42",
                "rep-1",
                {"status": "contacted"},
            )

        self.assertEqual(result["id"], "ref-1")
        self.assertEqual(result["status"], "contacted")
        self.assertEqual(result["referredContactEmail"], "doctor@example.com")
        upsert.assert_called_once()
        payload = upsert.call_args.args[0]
        self.assertEqual(payload["id"], "ref-1")
        self.assertEqual(payload["salesRepId"], "rep-1")
        self.assertEqual(payload["status"], "contacted")
        self.assertNotIn("contactFormId", payload)
        self.assertEqual(upsert.call_args.kwargs, {"match_by_contact": False})
        delete_by_contact.assert_called_once_with("42")

    def test_contact_form_status_update_adds_contact_form_when_lead_missing(self) -> None:
        contact_form_row = {
            "id": 43,
            "name": "New Doctor",
            "email": "new@example.com",
            "phone": "555-0101",
            "message": "Interested.",
            "message_field_key": "question",
            "message_label": "Type your question here:",
            "source": "question",
            "created_at": "2026-04-03T00:00:00Z",
        }

        def fake_upsert(payload, **_kwargs):
            return {**payload, "updatedAt": "2026-04-03T00:00:00Z"}

        with patch.object(service.mysql_client, "fetch_one", return_value=contact_form_row), \
            patch.object(service, "decrypt_text", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value="rep-1"), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", return_value={"rep-1"}), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep_and_contact_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_contact_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_contact_phone", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_doctor_id", return_value=None), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[]), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep_and_contact_form", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_contact_form_id", return_value=None), \
            patch.object(service.sales_prospect_repository, "upsert", side_effect=fake_upsert) as upsert, \
            patch.object(service.sales_prospect_repository, "delete_by_contact_form_id", return_value=True) as delete_by_contact:
            result = service.update_referral_for_sales_rep(
                "contact_form:43",
                "rep-1",
                {"status": "contacted"},
            )

        self.assertEqual(result["id"], "contact_form:43")
        self.assertEqual(result["status"], "contacted")
        self.assertEqual(result["referredContactEmail"], "new@example.com")
        upsert.assert_called_once()
        payload = upsert.call_args.args[0]
        self.assertEqual(payload["id"], "contact_form:43")
        self.assertEqual(payload["contactFormId"], "43")
        self.assertEqual(upsert.call_args.kwargs, {"match_by_contact": False})
        delete_by_contact.assert_not_called()

    def test_handled_contact_form_submission_is_not_backfilled_as_second_lead(self) -> None:
        existing_lead = {
            "id": "ref-1",
            "salesRepId": "rep-1",
            "referralId": "ref-1",
            "contactName": "Existing Doctor",
            "contactEmail": "doctor@example.com",
            "contactEmails": ["doctor@example.com"],
            "status": "contacted",
            "createdAt": "2026-04-01T00:00:00Z",
            "updatedAt": "2026-04-02T00:00:00Z",
        }

        def fake_fetch_all(query: str, _params=None):
            if "SHOW COLUMNS" in query:
                return []
            if "FROM contact_forms" in query:
                return [
                    {
                        "id": 42,
                        "name": "Existing Doctor",
                        "email": "doctor@example.com",
                        "phone": "555-0100",
                        "message": "Please call me.",
                        "message_field_key": "question",
                        "message_label": "Type your question here:",
                        "source": "question",
                        "created_at": "2026-04-02T00:00:00Z",
                        "prospect_sales_rep_id": None,
                        "prospect_doctor_id": None,
                        "prospect_status": None,
                        "prospect_notes": None,
                        "prospect_updated_at": None,
                        "reseller_permit_exempt": 0,
                        "reseller_permit_file_path": None,
                        "reseller_permit_file_name": None,
                        "reseller_permit_uploaded_at": None,
                    }
                ]
            return []

        with patch.object(service, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": True})), \
            patch.object(service.mysql_client, "fetch_all", side_effect=fake_fetch_all), \
            patch.object(service, "decrypt_text", return_value=None), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[existing_lead]), \
            patch.object(service.sales_prospect_repository, "upsert") as upsert:
            records = service._load_contact_form_referrals()

        self.assertEqual(records, [])
        upsert.assert_not_called()

    def test_admin_house_contact_forms_hide_submissions_matching_other_rep_leads(self) -> None:
        other_rep_lead = {
            "id": "ref-other",
            "salesRepId": "rep-2",
            "referralId": "ref-other",
            "contactName": "Other Rep Doctor",
            "contactEmail": "other@example.com",
            "contactEmails": ["other@example.com"],
            "status": "pending",
            "createdAt": "2026-04-01T00:00:00Z",
            "updatedAt": "2026-04-01T00:00:00Z",
        }

        def fake_fetch_all(query: str, _params=None):
            if "SHOW COLUMNS" in query:
                return []
            if "FROM contact_forms" in query:
                return [
                    {
                        "id": 52,
                        "name": "Other Rep Doctor",
                        "email": "other@example.com",
                        "phone": "555-0200",
                        "message": "Follow up.",
                        "message_field_key": "question",
                        "message_label": "Type your question here:",
                        "source": "question",
                        "created_at": "2026-04-05T00:00:00Z",
                        "prospect_sales_rep_id": None,
                        "prospect_doctor_id": None,
                        "prospect_status": None,
                        "prospect_notes": None,
                        "prospect_updated_at": None,
                        "reseller_permit_exempt": 0,
                        "reseller_permit_file_path": None,
                        "reseller_permit_file_name": None,
                        "reseller_permit_uploaded_at": None,
                    }
                ]
            return []

        with patch.object(service, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": True})), \
            patch.object(service.mysql_client, "fetch_all", side_effect=fake_fetch_all), \
            patch.object(service, "decrypt_text", return_value=None), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[other_rep_lead]), \
            patch.object(service.sales_prospect_repository, "upsert") as upsert:
            records = service._load_contact_form_referrals()

        self.assertEqual(records, [])
        upsert.assert_not_called()

    def test_rep_scoped_contact_forms_include_house_submission_matching_their_lead(self) -> None:
        existing_lead = {
            "id": "ref-1",
            "salesRepId": "rep-1",
            "referralId": "ref-1",
            "contactName": "Rep Doctor",
            "contactEmail": "repdoctor@example.com",
            "contactEmails": ["repdoctor@example.com"],
            "status": "pending",
            "createdAt": "2026-04-01T00:00:00Z",
            "updatedAt": "2026-04-01T00:00:00Z",
        }

        def fake_fetch_all(query: str, _params=None):
            if "SHOW COLUMNS" in query:
                return []
            if "FROM contact_forms" in query:
                return [
                    {
                        "id": 53,
                        "name": "Rep Doctor",
                        "email": "repdoctor@example.com",
                        "phone": "555-0201",
                        "message": "Please contact me.",
                        "message_field_key": "question",
                        "message_label": "Type your question here:",
                        "source": "question",
                        "created_at": "2026-04-06T00:00:00Z",
                        "prospect_sales_rep_id": None,
                        "prospect_doctor_id": None,
                        "prospect_status": None,
                        "prospect_notes": None,
                        "prospect_updated_at": None,
                        "reseller_permit_exempt": 0,
                        "reseller_permit_file_path": None,
                        "reseller_permit_file_name": None,
                        "reseller_permit_uploaded_at": None,
                    }
                ]
            return []

        with patch.object(service, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": True})), \
            patch.object(service.mysql_client, "fetch_all", side_effect=fake_fetch_all), \
            patch.object(service, "decrypt_text", return_value=None), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", return_value={"rep-1"}), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[existing_lead]), \
            patch.object(service.sales_prospect_repository, "upsert") as upsert:
            records = service._load_contact_form_referrals(sales_rep_id="rep-1")

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["id"], "contact_form:53")
        self.assertEqual(records[0]["salesRepId"], "rep-1")
        self.assertEqual(records[0]["status"], "contact_form")
        self.assertEqual(records[0]["referredContactEmail"], "repdoctor@example.com")
        upsert.assert_not_called()

    def test_admin_cannot_mark_contact_form_for_other_rep_existing_lead(self) -> None:
        other_rep_lead = {
            "id": "ref-other",
            "salesRepId": "rep-2",
            "referralId": "ref-other",
            "contactName": "Other Rep Doctor",
            "contactEmail": "other@example.com",
            "contactEmails": ["other@example.com"],
            "status": "pending",
        }
        contact_form_row = {
            "id": 54,
            "name": "Other Rep Doctor",
            "email": "other@example.com",
            "phone": "555-0202",
            "message": "Follow up.",
            "message_field_key": "question",
            "message_label": "Type your question here:",
            "source": "question",
            "created_at": "2026-04-07T00:00:00Z",
        }

        with patch.object(service.mysql_client, "fetch_one", return_value=contact_form_row), \
            patch.object(service, "decrypt_text", return_value=None), \
            patch.object(service, "_resolve_user_id", return_value="admin-1"), \
            patch.object(service, "_resolve_sales_rep_owner_aliases", side_effect=lambda value: {str(value)}), \
            patch.object(service.user_repository, "find_by_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_sales_rep_and_contact_email", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_contact_email", return_value=other_rep_lead), \
            patch.object(service.sales_prospect_repository, "find_by_contact_phone", return_value=None), \
            patch.object(service.sales_prospect_repository, "find_by_doctor_id", return_value=None), \
            patch.object(service.sales_prospect_repository, "get_all", return_value=[other_rep_lead]), \
            patch.object(service.sales_prospect_repository, "upsert") as upsert, \
            patch.object(service.sales_prospect_repository, "delete_by_contact_form_id") as delete_by_contact:
            with self.assertRaises(Exception) as context:
                service.update_referral_for_sales_rep(
                    "contact_form:54",
                    "admin-1",
                    {"status": "contacted"},
                )

        self.assertEqual(getattr(context.exception, "status", None), 404)
        upsert.assert_not_called()
        delete_by_contact.assert_not_called()

    def test_accounts_resolve_sales_rep_aliases(self) -> None:
        users = [
            {
                "id": "doctor-1",
                "role": "doctor",
                "email": "doctor@example.com",
                "salesRepId": "rep-canonical",
            },
            {
                "id": "test-doctor-1",
                "role": "test_doctor",
                "email": "test-doctor@example.com",
                "salesRepId": "rep-canonical",
            },
            {
                "id": "other-doctor",
                "role": "doctor",
                "email": "other@example.com",
                "salesRepId": "rep-other",
            },
        ]

        with patch.object(service.user_repository, "list_referral_dashboard_users", return_value=users), \
            patch.object(service, "_resolve_sales_rep_id", return_value="rep-canonical"), \
            patch.object(service, "_resolve_user_id", return_value="rep-canonical"), \
            patch.object(service, "_resolve_sales_rep_aliases", return_value={"sales-user-1", "rep-canonical"}), \
            patch.object(service, "backfill_lead_types_for_doctors", side_effect=lambda doctors: doctors), \
            patch.object(service.order_repository, "count_by_user_ids", return_value={"doctor-1": 2}):
            result = service.list_accounts_for_sales_rep("sales-user-1")

        self.assertEqual({row["id"] for row in result}, {"doctor-1", "test-doctor-1"})
        self.assertEqual(next(row for row in result if row["id"] == "doctor-1")["totalOrders"], 2)

    def test_active_physicians_csv_data_counts_physicians_and_leads_with_emails(self) -> None:
        users = [
            {"id": "doctor-1", "role": "doctor", "email": "doctor@example.com", "name": "Doctor One"},
            {"id": "doctor-2", "role": "test_doctor", "email": "test@doctor.com", "name": "Hidden Test"},
            {"id": "doctor-3", "role": "test_doctor", "email": "test-physician@example.com", "name": "Hidden Test Physician"},
            {"id": "rep-1", "role": "sales_rep", "email": "rep@example.com", "name": "Rep One"},
        ]
        leads = [
            {"id": "lead-1", "referredContactName": "Lead One", "referredContactEmail": "lead@example.com"},
            {"id": "lead-2", "referredContactName": "No Email", "referredContactEmail": None},
        ]

        with patch.object(service.user_repository, "list_referral_dashboard_users", return_value=users), \
            patch.object(service, "list_referrals_for_sales_rep", return_value=leads):
            result = service.get_active_physicians_csv_data()

        self.assertEqual(result["counts"], {"networkUsers": 1, "leads": 1})
        self.assertEqual(result["networkUsers"], [{"name": "Doctor One", "email": "doctor@example.com"}])
        self.assertEqual(result["leads"], [{"name": "Lead One", "email": "lead@example.com"}])

    def test_scope_diagnostics_report_aliases(self) -> None:
        with patch.object(service, "_resolve_sales_rep_id", return_value="rep-canonical"), \
            patch.object(service, "_resolve_user_id", return_value="sales-user-1"), \
            patch.object(service, "_resolve_sales_rep_aliases", return_value={"sales-user-1", "rep-canonical"}):
            result = service.get_sales_rep_scope_diagnostics("sales-user-1")

        self.assertEqual(result["input"], "sales-user-1")
        self.assertEqual(result["resolvedSalesRepId"], "rep-canonical")
        self.assertEqual(result["resolvedUserId"], "sales-user-1")
        self.assertEqual(result["ownerAliases"], ["canonical", "sales-user-1"])


if __name__ == "__main__":
    unittest.main()
