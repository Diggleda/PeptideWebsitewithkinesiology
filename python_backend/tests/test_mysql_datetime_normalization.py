from __future__ import annotations

import unittest

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
            }
        )

        self.assertEqual(params["created_at"], "2025-11-06 02:14:26")
        self.assertEqual(params["updated_at"], "2025-11-06 02:14:26")

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
