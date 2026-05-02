from __future__ import annotations

import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

service = None


class CreateManualProspectDuplicateEmailTests(unittest.TestCase):
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
        flask_stub = sys.modules.get("flask")
        if flask_stub is not None and not hasattr(flask_stub, "has_request_context"):
            flask_stub.has_request_context = lambda: False
        try:
            from python_backend.services import referral_service as imported_service
        except ModuleNotFoundError as exc:  # pragma: no cover
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc
        service = imported_service

    def _base_patches(self):
        return [
            patch.object(service, "_resolve_sales_rep_id", return_value="rep-1"),
            patch.object(service.user_repository, "find_by_email", return_value=None),
            patch.object(service.sales_rep_repository, "find_by_email", return_value=None),
            patch.object(service.referral_repository, "get_all", return_value=[]),
            patch.object(service.sales_prospect_repository, "get_all", return_value=[]),
            patch.object(service, "get_config", return_value=SimpleNamespace(mysql={"enabled": False})),
        ]

    def _assert_email_duplicate(self, error: Exception) -> None:
        self.assertEqual(str(error), "Email already exists.")
        self.assertEqual(getattr(error, "status", None), 400)
        self.assertEqual(getattr(error, "error_code", None), "EMAIL_ALREADY_EXISTS")

    def test_blocks_email_already_used_by_user_account(self) -> None:
        patches = self._base_patches()
        patches[1] = patch.object(
            service.user_repository,
            "find_by_email",
            return_value={"id": "doctor-1", "email": "doctor@example.com"},
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            with self.assertRaises(Exception) as context:
                service.create_manual_prospect(
                    {"salesRepId": "rep-1", "name": "Doctor One", "email": "doctor@example.com"}
                )

        self._assert_email_duplicate(context.exception)

    def test_blocks_email_already_used_by_another_rep_referral(self) -> None:
        patches = self._base_patches()
        patches[3] = patch.object(
            service.referral_repository,
            "get_all",
            return_value=[
                {
                    "id": "ref-1",
                    "salesRepId": "rep-2",
                    "referredContactEmail": "lead@example.com",
                }
            ],
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            with self.assertRaises(Exception) as context:
                service.create_manual_prospect(
                    {"salesRepId": "rep-1", "name": "Lead Example", "email": "lead@example.com"}
                )

        self._assert_email_duplicate(context.exception)

    def test_blocks_email_already_used_by_another_rep_sales_prospect(self) -> None:
        patches = self._base_patches()
        patches[4] = patch.object(
            service.sales_prospect_repository,
            "get_all",
            return_value=[
                {
                    "id": "manual:old",
                    "salesRepId": "rep-2",
                    "contactEmails": ["existing@example.com"],
                }
            ],
        )

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
            with self.assertRaises(Exception) as context:
                service.create_manual_prospect(
                    {"salesRepId": "rep-1", "name": "Existing Lead", "email": "existing@example.com"}
                )

        self._assert_email_duplicate(context.exception)

    def test_blocks_email_already_used_by_contact_form(self) -> None:
        patches = self._base_patches()
        patches[5] = patch.object(service, "get_config", return_value=SimpleNamespace(mysql={"enabled": True}))

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], \
            patch.object(service, "compute_blind_index", return_value="idx:form@example.com"), \
            patch.object(service.mysql_client, "fetch_one", return_value={"id": "42"}):
            with self.assertRaises(Exception) as context:
                service.create_manual_prospect(
                    {"salesRepId": "rep-1", "name": "Form Lead", "email": "form@example.com"}
                )

        self._assert_email_duplicate(context.exception)

    def test_creates_manual_prospect_when_email_is_unused(self) -> None:
        saved_record = {
            "id": "manual:123",
            "salesRepId": "rep-1",
            "contactName": "New Lead",
            "contactEmail": "new@example.com",
            "contactPhone": None,
            "contactEmails": ["new@example.com"],
            "contactPhones": [],
            "status": "pending",
            "notes": None,
            "createdAt": "2026-05-02T00:00:00+00:00",
            "updatedAt": "2026-05-02T00:00:00+00:00",
        }
        patches = self._base_patches()

        with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], \
            patch.object(service, "_generate_manual_id", return_value="manual:123"), \
            patch.object(service.sales_prospect_repository, "upsert", return_value=saved_record) as upsert:
            result = service.create_manual_prospect(
                {"salesRepId": "rep-1", "name": "New Lead", "email": "new@example.com"}
            )

        self.assertEqual(result["id"], "manual:123")
        self.assertEqual(result["referredContactEmail"], "new@example.com")
        upsert.assert_called_once()
        self.assertEqual(upsert.call_args.kwargs, {"match_by_contact": False})


if __name__ == "__main__":
    unittest.main()
