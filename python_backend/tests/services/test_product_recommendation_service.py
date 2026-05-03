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

    def test_cold_start_requires_personal_signal(self):
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
        self.assertEqual(result["fallbackReason"], "cold_start_no_personal_signals")
        self.assertEqual(result["recommendations"], [])

    def test_category_affinity_expands_to_related_products_but_stays_capped(self):
        from python_backend.services import product_recommendation_service as svc

        catalog = [
            {"id": 101, "name": "Purchased", "status": "publish", "sku": "A", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 102, "name": "Same Category 1", "status": "publish", "sku": "B", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 103, "name": "Same Category 2", "status": "publish", "sku": "C", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 104, "name": "Same Category 3", "status": "publish", "sku": "D", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 105, "name": "Same Category 4", "status": "publish", "sku": "E", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 106, "name": "Same Category 5", "status": "publish", "sku": "F", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 107, "name": "Same Category 6", "status": "publish", "sku": "G", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 108, "name": "Unrelated", "status": "publish", "sku": "H", "categories": [{"name": "Other"}], "tags": [{"slug": "other"}]},
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
            result = svc.get_recommendations({"id": "doctor-1", "role": "doctor"}, limit=100)

        ids = [item["wooProductId"] for item in result["recommendations"]]
        self.assertEqual(ids[0], 101)
        self.assertEqual(len(ids), 6)
        self.assertNotIn(108, ids)

    def test_recommendations_are_capped_even_when_limit_is_large(self):
        from python_backend.services import product_recommendation_service as svc

        catalog = [
            {"id": product_id, "name": f"Product {product_id}", "status": "publish", "sku": f"SKU-{product_id}", "categories": [{"name": "Peptides"}], "tags": []}
            for product_id in range(101, 111)
        ]
        user_order = {
            "userId": "doctor-1",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "items": [
                {"productId": product["id"], "quantity": 1, "sku": product["sku"]}
                for product in catalog
            ],
        }

        with patch.dict(svc.os.environ, {"RECOMMENDATIONS_MAX_RESULTS": "4"}), self._patch_catalog(svc, catalog), patch.object(
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
            result = svc.get_recommendations({"id": "doctor-1", "role": "doctor"}, limit=100)

        self.assertEqual(len(result["recommendations"]), 4)

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

    def test_admin_recommendations_use_personal_signals_without_peer_similarity(self):
        from python_backend.services import product_recommendation_service as svc

        catalog = [
            {"id": 101, "name": "Purchased", "status": "publish", "sku": "A", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 202, "name": "Same Domain", "status": "publish", "sku": "B", "categories": [{"name": "Peptides"}], "tags": [{"slug": "recovery"}]},
            {"id": 303, "name": "Peer Only", "status": "publish", "sku": "C", "categories": [{"name": "Other"}], "tags": [{"slug": "other"}]},
        ]
        admin_order = {
            "userId": "admin-1",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "items": [{"productId": 101, "quantity": 1, "sku": "A"}],
        }
        peer_order = {
            "userId": "doctor-2",
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "items": [
                {"productId": 101, "quantity": 1, "sku": "A"},
                {"productId": 303, "quantity": 1, "sku": "C"},
            ],
        }

        with self._patch_catalog(svc, catalog), patch.object(
            svc.order_repository,
            "find_by_user_id",
            return_value=[admin_order],
        ), patch.object(
            svc.order_repository,
            "list_for_commission",
            return_value=[admin_order, peer_order],
        ), patch.object(
            svc.user_repository,
            "find_by_id",
            return_value={"id": "admin-1", "role": "admin", "cart": []},
        ), patch.object(
            svc.user_repository,
            "get_all",
            return_value=[
                {"id": "admin-1", "role": "admin"},
                {"id": "doctor-2", "role": "doctor"},
            ],
        ), patch.object(
            svc.physician_product_event_repository,
            "find_recent_for_user",
            return_value=[],
        ):
            result = svc.get_recommendations({"id": "admin-1", "role": "admin"}, limit=10)

        ids = [item["wooProductId"] for item in result["recommendations"]]
        self.assertIn(101, ids)
        self.assertIn(202, ids)
        self.assertNotIn(303, ids)
        self.assertTrue(all("similar_physicians" not in item["reasons"] for item in result["recommendations"]))

    def test_ineligible_role_is_rejected(self):
        from python_backend.services import product_recommendation_service as svc

        with self.assertRaises(ValueError) as ctx:
            svc.get_recommendations({"id": "delegate-1", "role": "delegate"}, limit=10)

        self.assertEqual(getattr(ctx.exception, "status", None), 403)

    def test_sales_rep_event_tracking_is_allowed(self):
        from python_backend.services import product_recommendation_service as svc

        with patch.object(
            svc.physician_product_event_repository,
            "insert_event",
            return_value=True,
        ) as insert_event:
            result = svc.track_product_event(
                {"id": "rep-1", "role": "sales_rep"},
                {"eventType": "product_view", "wooProductId": 101},
            )

        self.assertTrue(result["tracked"])
        insert_event.assert_called_once()
        self.assertEqual(insert_event.call_args.kwargs["user_id"], "rep-1")

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
