from __future__ import annotations

import unittest
from unittest.mock import patch

service = None


class _FakeStore:
    def __init__(self, records):
        self.records = list(records)

    def read(self):
        return list(self.records)

    def write(self, records):
        self.records = list(records)


class DeleteSalesProspectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        global service
        if service is not None:
            return
        try:
            from python_backend.services import referral_service as imported_service
        except ModuleNotFoundError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc
        service = imported_service

    def test_delete_referral_prospect_removes_referral_and_prospect_rows(self) -> None:
        prospect = {
            "id": "ref-1",
            "salesRepId": "rep-1",
            "referralId": "ref-1",
            "status": "pending",
        }

        with patch.object(service, "get_sales_prospect_for_sales_rep", return_value=prospect), \
            patch.object(service.referral_repository, "find_by_id", return_value={"id": "ref-1", "salesRepId": "rep-1"}), \
            patch.object(service.referral_repository, "delete", return_value=True) as mock_delete_referral, \
            patch.object(service.sales_prospect_repository, "delete_by_referral_id", return_value=True) as mock_delete_by_referral, \
            patch.object(service.sales_prospect_repository, "delete", return_value=False) as mock_delete_prospect:
            result = service.delete_sales_prospect_for_sales_rep(
                "rep-1",
                "ref-1",
                referral_id="ref-1",
            )

        self.assertEqual(result["status"], "deleted")
        mock_delete_referral.assert_called_once_with("ref-1")
        mock_delete_by_referral.assert_called_once_with("ref-1")
        mock_delete_prospect.assert_called_once_with("ref-1")

    def test_delete_contact_form_prospect_removes_contact_form_and_status_rows(self) -> None:
        fake_store = _FakeStore(
            [
                {"id": "41", "email": "keep@example.com"},
                {"id": "42", "email": "delete@example.com"},
            ]
        )
        prospect = {
            "id": "contact_form:42",
            "salesRepId": "rep-1",
            "contactFormId": "42",
            "status": "contact_form",
        }

        with patch.object(service, "get_sales_prospect_for_sales_rep", return_value=prospect), \
            patch.object(service.mysql_client, "is_enabled", return_value=False), \
            patch.object(service.storage, "contact_form_store", fake_store), \
            patch.object(service.contact_form_status_repository, "delete", return_value=True) as mock_delete_status, \
            patch.object(service.sales_prospect_repository, "delete_by_contact_form_id", return_value=True) as mock_delete_by_contact, \
            patch.object(service.sales_prospect_repository, "delete", return_value=False) as mock_delete_prospect:
            result = service.delete_sales_prospect_for_sales_rep(
                "rep-1",
                "contact_form:42",
            )

        self.assertEqual(result["status"], "deleted")
        self.assertEqual(fake_store.records, [{"id": "41", "email": "keep@example.com"}])
        mock_delete_status.assert_called_once_with("42")
        mock_delete_by_contact.assert_called_once_with("42")
        mock_delete_prospect.assert_called_once_with("contact_form:42")

    def test_delete_account_prospect_hides_synthetic_doctor_lead(self) -> None:
        with patch.object(service, "get_sales_prospect_for_sales_rep", return_value=None), \
            patch.object(service.user_repository, "find_by_id", return_value={"id": "doctor-1", "role": "doctor"}), \
            patch.object(service, "upsert_sales_prospect_for_sales_rep", return_value={"id": "doctor:doctor-1", "status": "nuture"}) as mock_upsert:
            result = service.delete_sales_prospect_for_sales_rep(
                "rep-1",
                "doctor-1",
                doctor_id="doctor-1",
            )

        self.assertEqual(result["status"], "deleted")
        mock_upsert.assert_called_once_with("rep-1", "doctor-1", status="nuture")


if __name__ == "__main__":
    unittest.main()
