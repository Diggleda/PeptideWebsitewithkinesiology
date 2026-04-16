from __future__ import annotations

import unittest
from unittest.mock import patch

from python_backend.repositories import (
    credit_ledger_repository,
    referral_code_repository,
    referral_repository,
    sales_prospect_repository,
    sales_rep_repository,
    user_repository,
)
from python_backend.repositories._mysql_datetime import to_mysql_datetime


class MysqlDatetimeNormalizationTests(unittest.TestCase):
    def test_helper_normalizes_utc_offset_timestamp(self) -> None:
        self.assertEqual(
            to_mysql_datetime("2025-11-06T02:14:26+00:00"),
            "2025-11-06 02:14:26",
        )

    def test_user_repository_strips_timezone_offset(self) -> None:
        params = user_repository._to_db_params(
            {
                "id": "u1",
                "name": "Test",
                "email": "test@example.com",
                "password": "pw",
                "role": "doctor",
                "status": "active",
                "createdAt": "2025-11-06T02:14:26+00:00",
                "lastLoginAt": "2025-11-06T02:14:26Z",
            }
        )

        self.assertEqual(params["created_at"], "2025-11-06 02:14:26")
        self.assertEqual(params["last_login_at"], "2025-11-06 02:14:26")

    def test_user_repository_maps_legacy_network_presence_agreement_to_sql_param(self) -> None:
        params = user_repository._to_db_params(
            {
                "id": "u1",
                "name": "Test",
                "email": "test@example.com",
                "password": "pw",
                "role": "doctor",
                "status": "active",
                "network_presence_agreement": 1,
            }
        )

        self.assertEqual(params["network_presence_agreement"], 1)

    def test_user_repository_find_by_email_prefers_exact_mysql_lookup(self) -> None:
        row = {
            "id": "u1",
            "email": "test@example.com",
            "password": "pw",
            "role": "doctor",
        }
        calls = []

        def fake_fetch_one(query, params):
            calls.append((query, params))
            return row

        with patch("python_backend.repositories.user_repository._using_mysql", return_value=True), \
            patch("python_backend.repositories.user_repository.mysql_client.fetch_one", side_effect=fake_fetch_one):
            found = user_repository.find_by_email(" Test@example.com ")

        self.assertEqual(found["id"], "u1")
        self.assertEqual(len(calls), 1)
        self.assertIn("WHERE email = %(email)s", calls[0][0])
        self.assertEqual(calls[0][1]["email"], "test@example.com")

    def test_user_repository_find_by_email_falls_back_for_legacy_mysql_rows(self) -> None:
        row = {
            "id": "u1",
            "email": " Test@Example.com ",
            "password": "pw",
            "role": "doctor",
        }
        calls = []

        def fake_fetch_one(query, params):
            calls.append((query, params))
            if len(calls) == 1:
                return None
            return row

        with patch("python_backend.repositories.user_repository._using_mysql", return_value=True), \
            patch("python_backend.repositories.user_repository.mysql_client.fetch_one", side_effect=fake_fetch_one):
            found = user_repository.find_by_email("mailto:Test@example.com")

        self.assertEqual(found["id"], "u1")
        self.assertEqual(len(calls), 2)
        self.assertIn("WHERE email = %(email)s", calls[0][0])
        self.assertIn("LOWER(TRIM(email))", calls[1][0])
        self.assertEqual(calls[1][1]["email"], "test@example.com")

    def test_user_repository_mysql_update_persists_network_presence_agreement(self) -> None:
        existing = {
            "id": "u1",
            "name": "Test",
            "email": "test@example.com",
            "password": "pw",
            "role": "doctor",
            "status": "active",
            "networkPresenceAgreement": False,
        }
        executed = []

        def fake_execute(query, params):
            executed.append((query, params))
            return 1

        with patch("python_backend.repositories.user_repository.find_by_id", side_effect=[existing, {**existing, "networkPresenceAgreement": True, "network_presence_agreement": 1}]), \
            patch("python_backend.repositories.user_repository.mysql_client.execute", side_effect=fake_execute):
            updated = user_repository._mysql_update(
                {
                    "id": "u1",
                    "networkPresenceAgreement": True,
                    "network_presence_agreement": 1,
                }
            )

        self.assertEqual(len(executed), 1)
        self.assertEqual(executed[0][1]["network_presence_agreement"], 1)
        self.assertTrue(updated["networkPresenceAgreement"])

    def test_user_repository_record_successful_login_uses_targeted_mysql_update(self) -> None:
        executed = []
        fetched = []

        def fake_execute(query, params):
            executed.append((query, params))
            return 1

        def fake_fetch_one(query, params):
            fetched.append((query, params))
            return {
                "id": "u1",
                "name": "Test",
                "email": "test@example.com",
                "role": "doctor",
                "visits": 5,
                "is_online": 1,
                "must_reset_password": 0,
            }

        with patch("python_backend.repositories.user_repository._using_mysql", return_value=True), \
            patch("python_backend.repositories.user_repository.mysql_client.execute", side_effect=fake_execute), \
            patch("python_backend.repositories.user_repository.mysql_client.fetch_one", side_effect=fake_fetch_one):
            updated = user_repository.record_successful_login(
                "u1",
                session_id="session-2",
                at="2025-11-06T02:14:26+00:00",
            )

        self.assertEqual(len(executed), 1)
        self.assertIn("visits = COALESCE(visits, 0) + 1", executed[0][0])
        self.assertEqual(executed[0][1]["session_id"], "session-2")
        self.assertEqual(executed[0][1]["at"], "2025-11-06 02:14:26")
        self.assertEqual(len(fetched), 1)
        self.assertNotIn("referral_code", fetched[0][0])
        self.assertNotIn("dev_commission", fetched[0][0])
        self.assertEqual(updated["sessionId"], "session-2")

    def test_sales_rep_repository_strips_timezone_offset(self) -> None:
        params = sales_rep_repository._to_db_params(
            {
                "id": "rep1",
                "name": "Rep",
                "role": "sales_rep",
                "status": "active",
                "createdAt": "2025-11-06T02:14:26+00:00",
                "updatedAt": "2025-11-06T02:14:26Z",
            }
        )

        self.assertEqual(params["created_at"], "2025-11-06 02:14:26")
        self.assertEqual(params["updated_at"], "2025-11-06 02:14:26")

    def test_sales_prospect_repository_strips_timezone_offset(self) -> None:
        params = sales_prospect_repository._to_db_params(
            {
                "id": "prospect1",
                "createdAt": "2025-11-06T02:14:26+00:00",
                "updatedAt": "2025-11-06T02:14:26Z",
                "contactEmails": ["lead@example.com", "alt@example.com"],
                "contactPhones": ["(555) 111-2222", "(555) 333-4444"],
            }
        )

        self.assertEqual(params["created_at"], "2025-11-06 02:14:26")
        self.assertEqual(params["updated_at"], "2025-11-06 02:14:26")
        self.assertEqual(
            params["contact_emails_json"],
            '["lead@example.com", "alt@example.com"]',
        )
        self.assertEqual(
            params["contact_phones_json"],
            '["(555) 111-2222", "(555) 333-4444"]',
        )

    def test_referral_repository_strips_timezone_offset(self) -> None:
        params = referral_repository._to_db_params(
            {
                "id": "ref1",
                "referredContactName": "Doc",
                "status": "pending",
                "createdAt": "2025-11-06T02:14:26+00:00",
                "updatedAt": "2025-11-06T02:14:26Z",
            }
        )

        self.assertEqual(params["created_at"], "2025-11-06 02:14:26")
        self.assertEqual(params["updated_at"], "2025-11-06 02:14:26")

    def test_credit_ledger_repository_strips_timezone_offset(self) -> None:
        params = credit_ledger_repository._to_db_params(
            {
                "id": "ledger1",
                "amount": 10,
                "currency": "USD",
                "direction": "credit",
                "reason": "test",
                "createdAt": "2025-11-06T02:14:26+00:00",
                "updatedAt": "2025-11-06T02:14:26Z",
            }
        )

        self.assertEqual(params["created_at"], "2025-11-06 02:14:26")
        self.assertEqual(params["updated_at"], "2025-11-06 02:14:26")

    def test_referral_code_repository_strips_timezone_offset(self) -> None:
        params = referral_code_repository._to_db_params(
            {
                "id": "code1",
                "code": "ABCD1234",
                "status": "available",
                "createdAt": "2025-11-06T02:14:26+00:00",
                "updatedAt": "2025-11-06T02:14:26Z",
            }
        )

        self.assertEqual(params["created_at"], "2025-11-06 02:14:26")
        self.assertEqual(params["updated_at"], "2025-11-06 02:14:26")


if __name__ == "__main__":
    unittest.main()
