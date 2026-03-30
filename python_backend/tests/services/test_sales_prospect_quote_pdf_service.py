from __future__ import annotations

import unittest
from unittest.mock import patch

from python_backend.services import sales_prospect_quote_pdf_service as service


class SalesProspectQuotePdfServiceTests(unittest.TestCase):
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
            service, "_allow_text_fallback", return_value=True
        ):
            rendered = service.generate_prospect_quote_pdf(quote)

        self.assertTrue(rendered["pdf"].startswith(b"%PDF-1.4"))
        self.assertEqual(rendered["filename"], "PepPro_Quote_Client_Example_2.pdf")

    def test_generate_prospect_quote_pdf_raises_when_renderer_unavailable_and_fallback_disabled(self) -> None:
        with patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service, "_allow_text_fallback", return_value=False
        ):
            with self.assertRaises(ValueError) as context:
                service.generate_prospect_quote_pdf({"revisionNumber": 1, "quotePayloadJson": {}})

        self.assertEqual(str(context.exception), "QUOTE_PDF_RENDERER_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
