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
                "diagnostics": {
                    "totalMs": 321.4,
                    "pdfMs": 287.9,
                    "pdf": {
                        "renderer": "node_worker",
                        "cacheLayer": "miss",
                        "renderMs": 280.1,
                        "worker": {
                            "renderQuoteHtmlMs": 110.0,
                            "setContentMs": 22.0,
                            "waitForImagesMs": 15.0,
                            "pdfMs": 98.0,
                            "html": {
                                "imageResolveMs": 84.5,
                            },
                        },
                    },
                },
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
        self.assertEqual(response.headers.get("X-PepPro-Quote-Renderer"), "node_worker")
        self.assertEqual(response.headers.get("X-PepPro-Quote-Cache"), "miss")
        self.assertEqual(response.headers.get("X-PepPro-Quote-Export-Ms"), "321.4")
        self.assertEqual(response.headers.get("X-PepPro-Quote-Pdf-Ms"), "287.9")
        self.assertEqual(response.headers.get("X-PepPro-Quote-Render-Ms"), "280.1")
        self.assertEqual(response.headers.get("X-PepPro-Quote-Image-Ms"), "84.5")
        self.assertEqual(response.headers.get("X-PepPro-Quote-Pdf-Bytes"), str(len(b"%PDF-1.4 mock")))
        self.assertIn("quote_total;dur=321.4", response.headers.get("Server-Timing", ""))
        self.assertIn("pdf_images;dur=84.5", response.headers.get("Server-Timing", ""))
        self.assertEqual(response.get_data(), b"%PDF-1.4 mock")

    def test_delete_quote_route_returns_delete_payload(self) -> None:
        with patch.object(referrals, "_ensure_user", return_value={"id": "rep-1", "role": "sales_rep"}), patch.object(
            referrals, "_require_sales_rep"
        ), patch.object(
            referrals.sales_prospect_quote_service,
            "delete_prospect_quote",
            return_value={"deleted": True, "quoteId": "quote-1"},
        ):
            with self.app.test_request_context(
                "/api/referrals/sales-prospects/doctor-1/quotes/quote-1",
                method="DELETE",
            ):
                g.current_user = {"id": "rep-1", "role": "sales_rep"}
                response = referrals.admin_delete_prospect_quote.__wrapped__("doctor-1", "quote-1")

        self.assertEqual(response, {"deleted": True, "quoteId": "quote-1"})


if __name__ == "__main__":
    unittest.main()
