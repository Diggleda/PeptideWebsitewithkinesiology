from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch


class PhysicianProductRecommendationRepositoryTests(unittest.TestCase):
    def test_save_snapshot_writes_ordered_recommendations_json(self) -> None:
        from python_backend.repositories import physician_product_recommendation_repository as repo

        recommendations = [
            {
                "productId": "woo-101",
                "wooProductId": 101,
                "score": 92.5,
                "reasons": ["repeat_purchase"],
            },
            {
                "productId": "woo-202",
                "wooProductId": 202,
                "score": 81.0,
                "reasons": ["cart_intent"],
            },
        ]

        cursor = MagicMock()
        cursor_manager = MagicMock()
        cursor_manager.__enter__.return_value = cursor

        with patch.object(
            repo,
            "get_config",
            return_value=SimpleNamespace(mysql={"enabled": True}),
        ), patch.object(repo.mysql_client, "cursor", return_value=cursor_manager):
            saved = repo.save_snapshot(
                user_id="doctor-1",
                recommendations=recommendations,
                model_version="heuristic-v1",
                fallback=False,
                generated_at=datetime(2026, 5, 3, 12, 0, tzinfo=timezone.utc),
            )

        self.assertTrue(saved)
        self.assertEqual(cursor.execute.call_count, 2)
        query, params = cursor.execute.call_args_list[1].args
        self.assertIn("recommendations_json", query)
        self.assertEqual(params["user_id"], "doctor-1")
        self.assertEqual(params["model_version"], "heuristic-v1")
        self.assertEqual(json.loads(params["recommendations_json"]), recommendations)

    def test_find_latest_for_user_parses_recommendations_json(self) -> None:
        from python_backend.repositories import physician_product_recommendation_repository as repo

        row = {
            "user_id": "doctor-1",
            "model_version": "heuristic-v1",
            "recommendations_json": '[{"productId":"woo-101","wooProductId":101}]',
            "fallback": 0,
            "fallback_reason": None,
            "generated_at": datetime(2026, 5, 3, 12, 0),
            "expires_at": None,
            "created_at": datetime(2026, 5, 3, 12, 0),
            "updated_at": datetime(2026, 5, 3, 12, 1),
        }

        with patch.object(
            repo,
            "get_config",
            return_value=SimpleNamespace(mysql={"enabled": True}),
        ), patch.object(repo.mysql_client, "fetch_one", return_value=row):
            snapshot = repo.find_latest_for_user("doctor-1", model_version="heuristic-v1")

        self.assertIsNotNone(snapshot)
        assert snapshot is not None
        self.assertEqual(snapshot["userId"], "doctor-1")
        self.assertEqual(snapshot["recommendations"][0]["wooProductId"], 101)
        self.assertFalse(snapshot["fallback"])


if __name__ == "__main__":
    unittest.main()
