import unittest
from unittest.mock import patch


class TestDiscountCodeService(unittest.TestCase):
    def test_research_code_uses_sql_condition_without_pricing_override(self):
        try:
            from python_backend.services import discount_code_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(svc, "seed_defaults"), patch.object(
            svc.discount_code_repository,
            "find_by_code",
            return_value={
                "code": "RESEARCH",
                "discountValue": 50.0,
                "usedBy": {},
                "condition": {"min_cart_quantity": 4, "first_order_only": True},
            },
        ), patch.object(svc.order_repository, "find_by_user_id", return_value=[]):
            result = svc.preview_discount_for_user(
                user_id="user-1",
                user_role="doctor",
                code="RESEARCH",
                items_subtotal=400.0,
                cart_quantity=4,
            )

        self.assertTrue(result["valid"])
        self.assertEqual(result["discountAmount"], 50.0)
        self.assertNotIn("pricingOverride", result)

    def test_research_code_enforces_min_cart_quantity_from_sql(self):
        try:
            from python_backend.services import discount_code_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(svc, "seed_defaults"), patch.object(
            svc.discount_code_repository,
            "find_by_code",
            return_value={
                "code": "RESEARCH",
                "discountValue": 50.0,
                "usedBy": {},
                "condition": {"min_cart_quantity": 4, "first_order_only": True},
            },
        ), patch.object(svc.order_repository, "find_by_user_id", return_value=[]):
            result = svc.preview_discount_for_user(
                user_id="user-1",
                user_role="doctor",
                code="RESEARCH",
                items_subtotal=400.0,
                cart_quantity=3,
            )

        self.assertFalse(result["valid"])
        self.assertIn("at least 4 total items", result["message"])

    def test_research_code_rejects_non_first_order(self):
        try:
            from python_backend.services import discount_code_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(svc, "seed_defaults"), patch.object(
            svc.discount_code_repository,
            "find_by_code",
            return_value={
                "code": "RESEARCH",
                "discountValue": 50.0,
                "usedBy": {},
                "condition": {"min_cart_quantity": 4, "first_order_only": True},
            },
        ), patch.object(
            svc.order_repository,
            "find_by_user_id",
            return_value=[{"id": "o-1", "status": "processing"}],
        ):
            result = svc.preview_discount_for_user(
                user_id="user-1",
                user_role="doctor",
                code="RESEARCH",
                items_subtotal=400.0,
                cart_quantity=4,
            )

        self.assertFalse(result["valid"])
        self.assertIn("first order", result["message"].lower())

    def test_research_code_ignores_cancelled_orders_for_first_order_check(self):
        try:
            from python_backend.services import discount_code_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(svc, "seed_defaults"), patch.object(
            svc.discount_code_repository,
            "find_by_code",
            return_value={
                "code": "RESEARCH",
                "discountValue": 50.0,
                "usedBy": {},
                "condition": {"min_cart_quantity": 4, "first_order_only": True},
            },
        ), patch.object(
            svc.order_repository,
            "find_by_user_id",
            return_value=[{"id": "o-1", "status": "cancelled"}],
        ):
            result = svc.preview_discount_for_user(
                user_id="user-1",
                user_role="doctor",
                code="RESEARCH",
                items_subtotal=400.0,
                cart_quantity=4,
            )

        self.assertTrue(result["valid"])
        self.assertEqual(result["discountAmount"], 50.0)


if __name__ == "__main__":
    unittest.main()
