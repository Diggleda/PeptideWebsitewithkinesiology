import unittest
from unittest.mock import patch

try:
    from flask import Flask, g
    from python_backend.routes import catalog
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover
    Flask = None
    g = None
    catalog = None
    _IMPORT_ERROR = exc


class CatalogRecommendationsRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        if Flask is None or catalog is None:
            self.skipTest(f"catalog route test requires Flask backend dependencies: {_IMPORT_ERROR}")
        self.app = Flask(__name__)

    def test_recommendations_route_passes_current_user_and_limit(self):
        payload = {"recommendations": [{"productId": "woo-101", "score": 10}], "modelVersion": "test"}

        with self.app.test_request_context("/api/catalog/recommendations?limit=7"), patch.object(
            catalog.product_recommendation_service,
            "get_recommendations",
            return_value=payload,
        ) as get_recommendations:
            g.current_user = {"id": "doctor-1", "role": "doctor"}
            g.shadow_context = None
            response = catalog.list_catalog_recommendations.__wrapped__()

        body, status = response
        self.assertEqual(status, 200)
        self.assertEqual(body.get_json(), payload)
        get_recommendations.assert_called_once_with(
            {"id": "doctor-1", "role": "doctor"},
            limit=7,
            shadow_active=False,
        )

    def test_product_event_route_records_event(self):
        payload = {"ok": True, "tracked": True, "eventType": "product_view"}

        with self.app.test_request_context(
            "/api/catalog/events",
            method="POST",
            json={"eventType": "product_view", "wooProductId": 101},
        ), patch.object(
            catalog.product_recommendation_service,
            "track_product_event",
            return_value=payload,
        ) as track_product_event:
            g.current_user = {"id": "doctor-1", "role": "doctor"}
            g.shadow_context = None
            response = catalog.track_catalog_product_event.__wrapped__()

        body, status = response
        self.assertEqual(status, 201)
        self.assertEqual(body.get_json(), payload)
        track_product_event.assert_called_once()
        args, kwargs = track_product_event.call_args
        self.assertEqual(args[0], {"id": "doctor-1", "role": "doctor"})
        self.assertEqual(args[1]["wooProductId"], 101)
        self.assertEqual(kwargs["shadow_active"], False)


if __name__ == "__main__":
    unittest.main()
