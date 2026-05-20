import unittest
from unittest.mock import patch

from flask import Flask

from python_backend.routes import delegation, orders


class DelegateUsageTrackingRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = Flask(__name__)

    def test_resolve_tracks_delegate_open_when_page_load_is_counted(self):
        with self.app.test_request_context("/api/delegation/resolve?token=tok-1"):
            with patch.object(
                delegation.delegation_service,
                "resolve_delegate_token",
                return_value={
                    "token": "tok-1",
                    "doctorId": "doc-1",
                    "productScope": "all_physician_approved",
                    "delegatePermission": "submit_for_physician_review",
                    "status": "active",
                    "usageCount": 0,
                    "openCount": 3,
                },
            ) as resolve_delegate_token, patch.object(
                delegation.usage_tracking_service,
                "track_event",
                return_value=True,
            ) as track_event:
                delegation.resolve_token()

        resolve_delegate_token.assert_called_once_with("tok-1", count_page_load=True)
        track_event.assert_called_once()
        event_name = track_event.call_args.args[0]
        kwargs = track_event.call_args.kwargs
        self.assertEqual(event_name, "delegate_link_opened")
        self.assertEqual(kwargs["actor"], {"id": "doc-1", "role": "doctor"})
        self.assertEqual(kwargs["metadata"]["linkType"], "delegate")
        self.assertEqual(kwargs["metadata"]["openCount"], 3)

    def test_resolve_does_not_track_delegate_open_for_readonly_resolve(self):
        with self.app.test_request_context("/api/delegation/resolve?token=tok-1&countPageLoad=0"):
            with patch.object(
                delegation.delegation_service,
                "resolve_delegate_token",
                return_value={"token": "tok-1", "doctorId": "doc-1"},
            ) as resolve_delegate_token, patch.object(
                delegation.usage_tracking_service,
                "track_event",
                return_value=True,
            ) as track_event:
                delegation.resolve_token()

        resolve_delegate_token.assert_called_once_with("tok-1", count_page_load=False)
        track_event.assert_not_called()

    def test_delegate_estimate_tracks_successful_estimate(self):
        payload = {
            "delegateToken": "tok-1",
            "items": [{"sku": "BPC-157-5MG", "quantity": 1}],
            "shippingAddress": {"country": "US"},
            "shippingEstimate": {},
            "shippingTotal": 0,
            "paymentMethod": "zelle",
        }
        with self.app.test_request_context("/api/orders/delegate/estimate", method="POST", json=payload):
            with patch.object(
                orders.delegation_service,
                "resolve_delegate_token",
                return_value={
                    "token": "tok-1",
                    "doctorId": "doc-1",
                    "productScope": "all_physician_approved",
                    "delegatePermission": "submit_for_physician_review",
                },
            ), patch.object(
                orders.delegation_service,
                "validate_delegate_items",
                return_value={"validatedItems": payload["items"]},
            ), patch.object(
                orders.order_service,
                "estimate_order_totals",
                return_value={"totals": {"grandTotal": 123.45}},
            ), patch.object(
                orders.usage_tracking_service,
                "track_event",
                return_value=True,
            ) as track_event:
                orders.delegate_estimate_order_totals()

        track_event.assert_called_once()
        event_name = track_event.call_args.args[0]
        kwargs = track_event.call_args.kwargs
        self.assertEqual(event_name, "delegate_order_estimated")
        self.assertEqual(kwargs["actor"], {"id": "doc-1", "role": "doctor"})
        self.assertEqual(kwargs["metadata"]["linkType"], "delegate")
        self.assertEqual(kwargs["metadata"]["grandTotal"], 123.45)


if __name__ == "__main__":
    unittest.main()
