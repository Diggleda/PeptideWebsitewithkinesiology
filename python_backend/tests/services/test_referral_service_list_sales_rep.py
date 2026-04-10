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


if __name__ == "__main__":
    unittest.main()
