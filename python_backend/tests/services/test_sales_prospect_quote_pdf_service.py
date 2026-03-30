from __future__ import annotations

import unittest
from unittest.mock import patch

from python_backend.services import sales_prospect_quote_pdf_service as service


class SalesProspectQuotePdfServiceTests(unittest.TestCase):
    def test_render_quote_html_uses_logo_image_when_available(self) -> None:
        quote = {
            "revisionNumber": 1,
            "title": "Quote for Client Example",
            "quotePayloadJson": {
                "prospect": {"contactName": "Client Example"},
                "items": [],
            },
        }

        with patch.object(service, "_get_logo_data_url", return_value="data:image/png;base64,abc123"):
            html = service._render_quote_html(quote)

        self.assertIn('<img class="brand-logo" src="data:image/png;base64,abc123" alt="PepPro" />', html)
        self.assertNotIn('<div class="brand">PepPro</div>', html)

    def test_generate_prospect_quote_pdf_uses_system_browser_renderer_when_node_bridge_is_unavailable(self) -> None:
        with patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service,
            "_run_system_browser_renderer",
            return_value={"pdf": b"%PDF-1.4 styled", "filename": "PepPro_Quote_Client_Example_2.pdf"},
        ), patch.object(service, "_allow_text_fallback", return_value=False):
            rendered = service.generate_prospect_quote_pdf({"revisionNumber": 2, "quotePayloadJson": {}})

        self.assertEqual(rendered["pdf"], b"%PDF-1.4 styled")
        self.assertEqual(rendered["filename"], "PepPro_Quote_Client_Example_2.pdf")

    def test_generate_prospect_quote_pdf_falls_back_when_enabled(self) -> None:
        quote = {
            "prospectId": "prospect-1",
            "revisionNumber": 2,
            "title": "Quote for Client Example",
            "currency": "USD",
            "subtotal": 1131.87,
            "quotePayloadJson": {
                "notes": "Call before shipping",
                "prospect": {
                    "contactName": "Client Example",
                    "contactEmail": "client@example.com",
                },
                "salesRep": {
                    "name": "Peter J. Gibbons",
                    "email": "rep@example.com",
                },
                "items": [
                    {
                        "name": "Oxytocin N - 10mg",
                        "quantity": 1,
                        "unitPrice": 93.91,
                        "lineTotal": 93.91,
                        "sku": "OXYT-10",
                    }
                ],
            },
        }

        with patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service, "_run_system_browser_renderer", return_value=None
        ), patch.object(service, "_allow_text_fallback", return_value=True):
            rendered = service.generate_prospect_quote_pdf(quote)

        self.assertTrue(rendered["pdf"].startswith(b"%PDF-1.4"))
        self.assertEqual(rendered["filename"], "PepPro_Quote_Client_Example_2.pdf")

    def test_generate_prospect_quote_pdf_raises_when_renderer_unavailable_and_fallback_disabled(self) -> None:
        with patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service, "_run_system_browser_renderer", return_value=None
        ), patch.object(
            service, "_allow_text_fallback", return_value=False
        ):
            with self.assertRaises(ValueError) as context:
                service.generate_prospect_quote_pdf({"revisionNumber": 1, "quotePayloadJson": {}})

        self.assertEqual(str(context.exception), "QUOTE_PDF_RENDERER_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
