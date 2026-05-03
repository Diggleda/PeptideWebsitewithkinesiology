from __future__ import annotations

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
