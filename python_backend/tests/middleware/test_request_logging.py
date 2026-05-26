from __future__ import annotations

import unittest

from flask import Flask, jsonify

from python_backend.middleware import request_logging


class RequestLoggingTests(unittest.TestCase):
    def tearDown(self) -> None:
        with request_logging._ACTIVE_LOCK:
            request_logging._ACTIVE_REQUESTS.clear()

    def test_events_endpoint_is_tracked_as_long_lived(self) -> None:
        app = Flask(__name__)
        request_logging.init_request_logging(app)

        @app.get("/api/events")
        def events_probe():
            snapshot = request_logging.get_request_runtime_snapshot()
            return jsonify(snapshot)

        with app.test_client() as client:
            response = client.get("/api/events")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["activeCount"], 1)
        self.assertEqual(payload["slowCount"], 0)
        self.assertEqual(payload["active"][0]["path"], "/api/events")
        self.assertIs(payload["active"][0]["longPoll"], True)

    def test_long_lived_classifier_does_not_match_catalog_events_posts(self) -> None:
        self.assertTrue(request_logging._is_long_lived_request("GET", "/api/events"))
        self.assertTrue(request_logging._is_long_lived_request("GET", "/api/events/"))
        self.assertFalse(request_logging._is_long_lived_request("POST", "/api/catalog/events"))
        self.assertTrue(request_logging._is_long_lived_request("GET", "/api/longpoll/status"))


if __name__ == "__main__":
    unittest.main()
