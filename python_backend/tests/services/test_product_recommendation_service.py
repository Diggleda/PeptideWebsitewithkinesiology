import unittest
from datetime import datetime, timezone
from unittest.mock import patch


class ProductRecommendationServiceTests(unittest.TestCase):
    def _patch_catalog(self, svc, products):
        return patch.object(
            svc.catalog_snapshot_service,
            "get_catalog_products",
            side_effect=[products, []],
        )

    def test_repeat_purchase_and_cart_intent_rank_above_unrelated_products(self):
        from python_backend.services import product_recommendation_service as svc

        catalog = [
            {"id": 101, "name": "BPC", "status": "publish", "sku": "BPC", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 202, "name": "NAD", "status": "publish", "sku": "NAD", "categories": [{"name": "Wellness"}], "tags": []},
            {"id": 303, "name": "CJC", "status": "publish", "sku": "CJC", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 404, "name": "Unrelated", "status": "publish", "sku": "OTHER", "categories": [{"name": "Other"}], "tags": []},
            {"id": 505, "name": "Subscription Product", "status": "publish", "sku": "SUB", "categories": [{"name": "Subscriptions"}], "tags": []},
        ]
        user_order = {
            "userId": "doctor-1",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "items": [{"productId": 101, "quantity": 2, "sku": "BPC"}],
        }
        recent_orders = [
            user_order,
            {
                "userId": "doctor-2",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "items": [
                    {"productId": 101, "quantity": 1, "sku": "BPC"},
                    {"productId": 303, "quantity": 1, "sku": "CJC"},
                ],
            },
            {
                "userId": "doctor-3",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "items": [{"productId": 404, "quantity": 1, "sku": "OTHER"}],
            },
        ]

        with self._patch_catalog(svc, catalog), patch.object(
            svc.order_repository,
            "find_by_user_id",
            return_value=[user_order],
        ), patch.object(
            svc.order_repository,
            "list_for_commission",
            return_value=recent_orders,
        ), patch.object(
            svc.user_repository,
            "find_by_id",
            return_value={"id": "doctor-1", "role": "doctor", "cart": [{"productWooId": 202, "quantity": 1}]},
        ), patch.object(
            svc.user_repository,
            "get_all",
            return_value=[
                {"id": "doctor-1", "role": "doctor"},
                {"id": "doctor-2", "role": "doctor"},
                {"id": "doctor-3", "role": "doctor"},
            ],
        ), patch.object(
            svc.physician_product_event_repository,
            "find_recent_for_user",
            return_value=[],
        ), patch.object(
            svc.physician_product_recommendation_repository,
            "save_snapshot",
        ) as save_snapshot:
            result = svc.get_recommendations({"id": "doctor-1", "role": "doctor"}, limit=10)

        ids = [item["wooProductId"] for item in result["recommendations"]]
        self.assertIn(101, ids[:2])
        self.assertIn(202, ids[:2])
        self.assertIn(303, ids)
        self.assertNotIn(505, ids)
        self.assertFalse(result["fallback"])
        save_snapshot.assert_called_once()
        snapshot_kwargs = save_snapshot.call_args.kwargs
        self.assertEqual(snapshot_kwargs["user_id"], "doctor-1")
        self.assertEqual(snapshot_kwargs["recommendations"], result["recommendations"])
        self.assertEqual(snapshot_kwargs["model_version"], result["modelVersion"])
        self.assertFalse(snapshot_kwargs["fallback"])

    def test_cold_start_uses_global_physician_popularity(self):
        from python_backend.services import product_recommendation_service as svc

        catalog = [
            {"id": 101, "name": "A", "status": "publish", "sku": "A", "categories": [{"name": "Peptides"}], "tags": []},
            {"id": 202, "name": "B", "status": "publish", "sku": "B", "categories": [{"name": "Peptides"}], "tags": []},
        ]
        recent_orders = [
            {
                "userId": "doctor-2",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "items": [{"productId": 202, "quantity": 4, "sku": "B"}],
            },
            {
                "userId": "doctor-3",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "items": [{"productId": 101, "quantity": 1, "sku": "A"}],
            },
        ]

        with self._patch_catalog(svc, catalog), patch.object(
            svc.order_repository,
            "find_by_user_id",
            return_value=[],
        ), patch.object(
            svc.order_repository,
            "list_for_commission",
            return_value=recent_orders,
        ), patch.object(
            svc.user_repository,
            "find_by_id",
            return_value={"id": "doctor-1", "role": "doctor", "cart": []},
        ), patch.object(
            svc.user_repository,
            "get_all",
            return_value=[
                {"id": "doctor-2", "role": "doctor"},
                {"id": "doctor-3", "role": "doctor"},
            ],
        ), patch.object(
            svc.physician_product_event_repository,
            "find_recent_for_user",
            return_value=[],
        ):
            result = svc.get_recommendations({"id": "doctor-1", "role": "doctor"}, limit=10)

        self.assertTrue(result["fallback"])
        self.assertEqual(result["fallbackReason"], "cold_start_global_popularity")
        self.assertEqual(result["recommendations"][0]["wooProductId"], 202)

    def test_shadow_session_can_read_recommendations(self):
        from python_backend.services import product_recommendation_service as svc

        catalog = [
            {"id": 101, "name": "A", "status": "publish", "sku": "A", "categories": [{"name": "Peptides"}], "tags": []},
        ]
        user_order = {
            "userId": "doctor-1",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "items": [{"productId": 101, "quantity": 1, "sku": "A"}],
        }

        with self._patch_catalog(svc, catalog), patch.object(
            svc.order_repository,
            "find_by_user_id",
            return_value=[user_order],
        ), patch.object(
            svc.order_repository,
            "list_for_commission",
            return_value=[user_order],
        ), patch.object(
            svc.user_repository,
            "find_by_id",
            return_value={"id": "doctor-1", "role": "doctor", "cart": []},
        ), patch.object(
            svc.user_repository,
            "get_all",
            return_value=[{"id": "doctor-1", "role": "doctor"}],
        ), patch.object(
            svc.physician_product_event_repository,
            "find_recent_for_user",
            return_value=[],
        ):
            result = svc.get_recommendations(
                {"id": "doctor-1", "role": "doctor"},
                limit=10,
                shadow_active=True,
            )

        self.assertFalse(result["fallback"])
        self.assertEqual(result["recommendations"][0]["wooProductId"], 101)

    def test_non_physician_role_is_rejected(self):
        from python_backend.services import product_recommendation_service as svc

        with self.assertRaises(ValueError) as ctx:
            svc.get_recommendations({"id": "admin-1", "role": "admin"}, limit=10)

        self.assertEqual(getattr(ctx.exception, "status", None), 403)

    def test_track_event_requires_product_identifier_or_sku(self):
        from python_backend.services import product_recommendation_service as svc

        with self.assertRaises(ValueError) as ctx:
            svc.track_product_event(
                {"id": "doctor-1", "role": "doctor"},
                {"eventType": "product_view"},
            )

        self.assertEqual(getattr(ctx.exception, "status", None), 400)


if __name__ == "__main__":
    unittest.main()
