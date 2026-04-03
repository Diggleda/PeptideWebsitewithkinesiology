import unittest
from unittest.mock import patch

try:
    from flask import Flask
    from python_backend.routes import tracking
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - local test env may not include Flask stack
    Flask = None
    tracking = None
    _IMPORT_ERROR = exc


class TrackingRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        if Flask is None or tracking is None:
            self.skipTest(f"tracking route test requires Flask backend dependencies: {_IMPORT_ERROR}")
        self.app = Flask(__name__)

    def test_tracking_status_route_uses_official_ups_client_response_shape(self):
        with patch.object(
            tracking.ups_tracking,
            "fetch_tracking_status",
            return_value={
                "carrier": "ups",
                "trackingNumber": "1ZTEST123",
                "trackingStatus": "delivered",
                "trackingStatusRaw": "Delivered",
                "deliveredAt": "2026-04-02T10:15:00",
                "checkedAt": "2026-04-02T10:16:00Z",
            },
        ) as fetch_tracking_status:
            with self.app.test_request_context("/api/tracking/status/1ZTEST123?carrier=ups"):
                response = tracking.get_tracking_status.__wrapped__("1ZTEST123")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["trackingStatus"], "delivered")
        fetch_tracking_status.assert_called_once_with("1ZTEST123")


if __name__ == "__main__":
    unittest.main()
