from __future__ import annotations

import unittest

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


if __name__ == "__main__":
    unittest.main()
