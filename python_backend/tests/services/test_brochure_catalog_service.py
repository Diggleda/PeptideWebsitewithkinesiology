from __future__ import annotations

import sys
import types
import unittest
from unittest.mock import patch


def _install_test_stubs() -> None:
    if "pymysql" not in sys.modules:
        pymysql = types.ModuleType("pymysql")
        pymysql_cursors = types.ModuleType("pymysql.cursors")

        class DictCursor:
            pass

        pymysql_cursors.DictCursor = DictCursor

        class _Connections(types.SimpleNamespace):
            class Connection:
                pass

        pymysql.connections = _Connections()
        pymysql.connect = lambda *_args, **_kwargs: None
        sys.modules["pymysql"] = pymysql
        sys.modules["pymysql.cursors"] = pymysql_cursors

    if "requests" not in sys.modules:
        requests = types.ModuleType("requests")
        requests_auth = types.ModuleType("requests.auth")
        requests.get = lambda *_args, **_kwargs: None
        requests_auth.HTTPBasicAuth = lambda *_args, **_kwargs: None
        sys.modules["requests"] = requests
        sys.modules["requests.auth"] = requests_auth


class BrochureCatalogServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import brochure_catalog_service

        cls.brochure_catalog_service = brochure_catalog_service

    def test_get_brochure_products_uses_allowlisted_payload_and_excludes_unmatched(self):
        service = self.brochure_catalog_service
        fake_config = types.SimpleNamespace(mysql={"enabled": True})
        link = {
            "linkType": "brochure",
            "capabilities": {
                "canViewProducts": True,
                "canViewPricing": False,
                "canAddToCart": False,
                "canCheckout": False,
                "canSubmitProposal": False,
                "canViewCOA": True,
                "canViewInventory": False,
            },
            "productScope": "all_physician_approved",
            "productScopeItems": [],
        }
        products = [
            {
                "id": 101,
                "name": "BPC-157",
                "sku": "BPC-157-5MG",
                "categories": [{"id": 7, "name": "Peptides", "slug": "peptides"}],
                "images": [{"src": "https://example.test/bpc.png"}],
                "price": "99.00",
                "regular_price": "129.00",
                "sale_price": "99.00",
                "stock_quantity": 12,
                "inventory_status": "instock",
                "cost": "20.00",
                "markup": "30.00",
                "cart_url": "https://example.test/cart",
                "checkout_url": "https://example.test/checkout",
                "payment_settings": {"method": "card"},
                "supplier_notes": "private",
            },
            {
                "id": 202,
                "name": "TB-500",
                "sku": "TB-500-10MG",
                "categories": [{"id": 7, "name": "Peptides", "slug": "peptides"}],
            },
        ]
        brochure_rows = [
            {
                "product_sku": "BPC-157-5MG",
                "product_name": "BPC-157",
                "product_description": "Brochure description",
                "product_information": "Brochure information",
            }
        ]

        with patch.object(service, "get_config", return_value=fake_config), \
            patch.object(service, "resolve_brochure_link", return_value=link), \
            patch.object(service, "_load_brochure_rows", return_value=brochure_rows), \
            patch.object(service, "_load_snapshot_products", return_value=products), \
            patch.object(service, "_coa_available_by_product_id", return_value={101: True, 202: True}), \
            self.assertLogs(service.logger.name, level="INFO") as logs:
            result = service.get_brochure_products("tok-brochure")

        self.assertEqual(result.get("linkType"), "brochure")
        self.assertEqual(result.get("capabilities"), link["capabilities"])
        self.assertEqual(len(result.get("products") or []), 1)
        product = result["products"][0]
        self.assertEqual(product.get("sku"), "BPC-157-5MG")
        self.assertEqual(product.get("productDescription"), "Brochure description")
        self.assertEqual(product.get("productInformation"), "Brochure information")
        self.assertTrue(product.get("coaAvailable"))
        self.assertEqual(product.get("documentation"), {"coaAvailable": True})
        self.assertTrue(any("products missing brochure copy" in entry for entry in logs.output))

        forbidden_keys = {
            "price",
            "regular_price",
            "sale_price",
            "cost",
            "markup",
            "stock_quantity",
            "inventory_status",
            "cart_url",
            "checkout_url",
            "payment_settings",
            "supplier_notes",
            "paymentSettings",
            "proposalActions",
            "physicianMargin",
            "recipientName",
            "recipientContact",
        }
        self.assertFalse(forbidden_keys & set(result.keys()))
        self.assertFalse(forbidden_keys & set(product.keys()))

    def test_brochure_product_scope_matches_selected_skus_and_categories(self):
        service = self.brochure_catalog_service
        product = {
            "id": 101,
            "name": "BPC-157",
            "sku": "BPC-157-5MG",
            "categories": [{"name": "Peptides", "slug": "peptides"}],
        }

        self.assertTrue(
            service._product_scope_matches(
                product,
                {"productScope": "specific_products", "productScopeItems": ["BPC-157-5MG"]},
            )
        )
        self.assertTrue(
            service._product_scope_matches(
                product,
                {"productScope": "all_physician_approved", "productScopeItems": ["TB-500-10MG"]},
            )
        )
        self.assertTrue(
            service._product_scope_matches(
                product,
                {"productScope": "specific_products", "productScopeItems": ["peptides"]},
            )
        )
        self.assertFalse(
            service._product_scope_matches(
                product,
                {"productScope": "specific_products", "productScopeItems": ["TB-500-10MG"]},
            )
        )
        self.assertFalse(
            service._product_scope_matches(
                product,
                {"productScope": "specific_products", "productScopeItems": []},
            )
        )

    def test_brochure_matching_prefers_ids_then_sku_fallbacks(self):
        service = self.brochure_catalog_service
        matcher = service._build_brochure_matcher(
            [
                {
                    "product_id": 101,
                    "product_sku": "UNUSED-SKU",
                    "product_description": "Product ID match",
                    "product_information": "",
                },
                {
                    "variation_id": 301,
                    "product_sku": "VAR-301",
                    "product_description": "Variation ID match",
                    "product_information": "",
                },
                {
                    "product_sku": "TB 500 10MG",
                    "product_description": "Normalized SKU match",
                    "product_information": "",
                },
            ]
        )

        self.assertEqual(
            service._match_brochure_row({"id": 101, "sku": "OTHER-SKU"}, matcher).get("product_description"),
            "Product ID match",
        )
        self.assertEqual(
            service._match_brochure_row(
                {"id": 202, "sku": "PARENT-SKU", "variations": [{"id": 301, "sku": "VAR-301"}]},
                matcher,
            ).get("product_description"),
            "Variation ID match",
        )
        self.assertEqual(
            service._match_brochure_row({"id": 303, "sku": "TB-500-10MG"}, matcher).get("product_description"),
            "Normalized SKU match",
        )


if __name__ == "__main__":
    unittest.main()
