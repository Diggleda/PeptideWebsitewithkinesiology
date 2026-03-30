from __future__ import annotations

import unittest
from unittest.mock import patch

try:
    from flask import Flask, g
except (ModuleNotFoundError, ImportError) as exc:  # pragma: no cover
    Flask = None
    g = None
    _IMPORT_ERROR = exc
else:
    _IMPORT_ERROR = None
    from python_backend.routes import referrals


class ReferralQuoteRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        if Flask is None:
            raise unittest.SkipTest(f"python deps not installed: {_IMPORT_ERROR}")
        self.app = Flask(__name__)

    def _make_response(self, result):
        return self.app.make_response(result)

    def test_export_quote_route_returns_pdf_headers_and_filename(self) -> None:
        with patch.object(referrals, "_ensure_user", return_value={"id": "rep-1", "role": "sales_rep"}), patch.object(
            referrals, "_require_sales_rep"
        ), patch.object(
            referrals.sales_prospect_quote_service,
            "export_prospect_quote",
            return_value={
                "quote": {"id": "quote-1"},
                "pdf": b"%PDF-1.4 mock",
                "filename": "PepPro_Quote_Example_1.pdf",
            },
        ):
            with self.app.test_request_context(
                "/api/referrals/sales-prospects/doctor-1/quotes/quote-1/export",
                method="GET",
            ):
                g.current_user = {"id": "rep-1", "role": "sales_rep"}
                response = self._make_response(referrals.admin_export_prospect_quote.__wrapped__("doctor-1", "quote-1"))

        self.assertEqual(response.status_code, 200)
        self.assertIn("application/pdf", response.headers.get("Content-Type", ""))
        self.assertIn("PepPro_Quote_Example_1.pdf", response.headers.get("Content-Disposition", ""))
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(response.headers.get("X-PepPro-Quote-Id"), "quote-1")
        self.assertEqual(response.get_data(), b"%PDF-1.4 mock")


if __name__ == "__main__":
    unittest.main()
