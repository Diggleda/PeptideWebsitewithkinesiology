from __future__ import annotations

import time
import unittest
from unittest.mock import patch

from python_backend.services import sales_prospect_quote_pdf_service as service


class SalesProspectQuotePdfServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original_node_bridge_skip_until = service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC
        service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = 0.0
        service._QUOTE_PDF_RENDER_CACHE.clear()

    def tearDown(self) -> None:
        service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = self._original_node_bridge_skip_until
        service._QUOTE_PDF_RENDER_CACHE.clear()

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

    def test_render_quote_html_displays_subtotal_with_colon(self) -> None:
        quote = {
            "revisionNumber": 1,
            "currency": "USD",
            "subtotal": 93.91,
            "quotePayloadJson": {
                "prospect": {"contactName": "Client Example"},
                "items": [],
            },
        }

        html = service._render_quote_html(quote)

        self.assertIn('<div class="summary-row">', html)
        self.assertIn('<span>Subtotal:</span>', html)
        self.assertIn('<span>$93.91</span>', html)

    def test_resolve_quote_item_image_data_urls_preserves_item_order(self) -> None:
        items = [
            {"name": "First"},
            {"name": "Second"},
        ]

        def resolve(item):
            if item["name"] == "First":
                time.sleep(0.03)
                return "data:image/png;base64,first"
            return "data:image/png;base64,second"

        with patch.object(service, "_resolve_quote_item_image_data_url", side_effect=resolve):
            resolved = service._resolve_quote_item_image_data_urls(items)

        self.assertEqual(
            resolved,
            [
                "data:image/png;base64,first",
                "data:image/png;base64,second",
            ],
        )

    def test_generate_prospect_quote_pdf_uses_system_browser_renderer_when_node_bridge_is_unavailable(self) -> None:
        with patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service,
            "_run_system_browser_renderer",
            return_value={"pdf": b"%PDF-1.4 styled", "filename": "PepPro_Quote_Client_Example_2.pdf"},
        ), patch.object(service, "_allow_text_fallback", return_value=False):
            rendered = service.generate_prospect_quote_pdf({"revisionNumber": 2, "quotePayloadJson": {}})

        self.assertEqual(rendered["pdf"], b"%PDF-1.4 styled")
        self.assertEqual(rendered["filename"], "PepPro_Quote_Client_Example_2.pdf")

    def test_generate_prospect_quote_pdf_caches_successful_result_for_same_quote(self) -> None:
        quote = {"id": "quote-1", "revisionNumber": 2, "quotePayloadJson": {"prospect": {"contactName": "Client Example"}}}

        with patch.object(
            service,
            "_run_node_bridge",
            return_value={"pdf": b"%PDF-1.4 styled", "filename": "PepPro_Quote_Client_Example_2.pdf"},
        ) as run_node_bridge, patch.object(service, "_run_system_browser_renderer") as run_system_browser_renderer:
            first = service.generate_prospect_quote_pdf(quote)
            second = service.generate_prospect_quote_pdf(quote)

        self.assertEqual(run_node_bridge.call_count, 1)
        run_system_browser_renderer.assert_not_called()
        self.assertEqual(first["pdf"], second["pdf"])
        self.assertEqual(first["filename"], second["filename"])

    def test_run_node_bridge_skips_lookup_during_retry_cooldown(self) -> None:
        service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + 30

        with patch.object(service, "_find_node_binary", side_effect=AssertionError("bridge lookup should be skipped")):
            rendered = service._run_node_bridge({"revisionNumber": 1, "quotePayloadJson": {}})

        self.assertIsNone(rendered)

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
