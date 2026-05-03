from __future__ import annotations

import unittest
from unittest.mock import patch

from flask import Flask, g

from python_backend.routes import referrals


class ReferralsDashboardScopeTests(unittest.TestCase):
    def test_scope_all_allows_sales_lead_from_linked_sales_rep_record(self) -> None:
        self.assertTrue(
            referrals._can_scope_all_dashboard("sales_rep", "sales_rep", "sales_lead")
        )

    def test_scope_all_denies_plain_sales_rep(self) -> None:
        self.assertFalse(
            referrals._can_scope_all_dashboard("sales_rep", "sales_rep", "sales_rep")
        )

    def test_active_physicians_endpoint_returns_rows_for_sales_lead(self) -> None:
        app = Flask(__name__)
        with app.test_request_context("/api/referrals/active-physicians?debug=active_physicians"):
            g.current_user = {"id": "lead-1", "role": "sales_lead"}
            with patch.object(referrals, "_ensure_user", return_value={"id": "lead-1", "role": "sales_lead"}), \
                patch.object(referrals.referral_service, "get_active_physicians_csv_data", return_value={
                    "networkUsers": [{"name": "Doctor One", "email": "doctor@example.com"}],
                    "leads": [{"name": "Lead One", "email": "lead@example.com"}],
                    "counts": {"networkUsers": 1, "leads": 1},
                }):
                result = referrals.active_physicians_csv_data.__wrapped__()

        body, status = result
        payload = body.get_json()
        self.assertEqual(status, 200)
        self.assertEqual(payload["counts"], {"networkUsers": 1, "leads": 1})
        self.assertEqual(payload["networkUsers"][0]["email"], "doctor@example.com")
        self.assertTrue(payload["_debug"]["activePhysicians"]["scopeAllApplied"])


if __name__ == "__main__":
    unittest.main()
