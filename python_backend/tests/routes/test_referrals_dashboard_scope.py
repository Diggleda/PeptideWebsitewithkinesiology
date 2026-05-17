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

    def test_modal_dashboard_surfaces_active_prospect_load_failure(self) -> None:
        app = Flask(__name__)
        with app.test_request_context("/api/referrals/dashboard?context=modal&include=referrals&salesRepId=rep-1"):
            g.current_user = {"id": "admin-1", "role": "admin"}
            with patch.object(referrals, "_ensure_user", return_value={"id": "admin-1", "role": "admin"}), \
                patch.object(referrals, "_require_sales_rep", return_value=None), \
                patch.object(referrals.auth_service, "_resolve_sales_rep_record_for_user", return_value=None), \
                patch.object(referrals.referral_service, "list_referrals_for_sales_rep", side_effect=RuntimeError("database unavailable")):
                result = referrals.admin_dashboard.__wrapped__()

        body, status = result
        payload = body.get_json()
        self.assertEqual(status, 503)
        self.assertEqual(payload["error"], "Unable to load active prospects")


if __name__ == "__main__":
    unittest.main()
