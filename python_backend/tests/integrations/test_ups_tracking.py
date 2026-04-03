import sys
import types
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

if "requests" not in sys.modules:
    requests = types.ModuleType("requests")
    requests_auth = types.ModuleType("requests.auth")

    class HTTPBasicAuth:
        def __init__(self, *_args, **_kwargs):
            pass

    requests.RequestException = Exception
    requests.HTTPError = Exception
    requests.auth = requests_auth
    requests_auth.HTTPBasicAuth = HTTPBasicAuth
    sys.modules["requests"] = requests
    sys.modules["requests.auth"] = requests_auth

from python_backend.integrations import ups_tracking


class TestUpsTracking(unittest.TestCase):
    def setUp(self):
        ups_tracking._tracking_cache.clear()
        ups_tracking._token_cache["accessToken"] = None
        ups_tracking._token_cache["expiresAt"] = 0.0

    @patch("python_backend.integrations.ups_tracking.get_config")
    @patch("python_backend.integrations.ups_tracking.http_client.post")
    def test_get_access_token_uses_cached_token_until_expiry(self, mock_post, mock_get_config):
        mock_get_config.return_value = SimpleNamespace(
            ups={"client_id": "client-id", "client_secret": "client-secret", "merchant_id": "", "use_cie": False}
        )
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {"access_token": "token-1", "expires_in": "3600"}
        mock_post.return_value = response

        first = ups_tracking._get_access_token()
        second = ups_tracking._get_access_token()

        self.assertEqual(first, "token-1")
        self.assertEqual(second, "token-1")
        self.assertEqual(mock_post.call_count, 1)

    @patch("python_backend.integrations.ups_tracking.get_config")
    @patch("python_backend.integrations.ups_tracking._get_access_token", return_value="token-1")
    @patch("python_backend.integrations.ups_tracking.http_client.get")
    def test_fetch_tracking_status_parses_current_status_and_delivery_fields(
        self, mock_get, _mock_token, mock_get_config
    ):
        mock_get_config.return_value = SimpleNamespace(
            ups={"client_id": "client-id", "client_secret": "client-secret", "merchant_id": "", "use_cie": False}
        )
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "trackResponse": {
                "shipment": [
                    {
                        "inquiryNumber": "1ZTEST123",
                        "package": [
                            {
                                "currentStatus": {
                                    "simplifiedTextDescription": "Delivered",
                                    "description": "Delivered",
                                    "statusCode": "011",
                                },
                                "deliveryDate": [{"type": "DEL", "date": "20260402"}],
                                "deliveryTime": {"type": "DEL", "endTime": "101500"},
                            }
                        ],
                    }
                ]
            }
        }
        mock_get.return_value = response

        result = ups_tracking.fetch_tracking_status("1ZTEST123")

        self.assertEqual(result["trackingStatus"], "delivered")
        self.assertEqual(result["trackingStatusRaw"], "Delivered")
        self.assertEqual(result["deliveredAt"], "2026-04-02T10:15:00")

    @patch("python_backend.integrations.ups_tracking.get_config")
    @patch("python_backend.integrations.ups_tracking._get_access_token", return_value="token-1")
    @patch("python_backend.integrations.ups_tracking.http_client.get")
    def test_fetch_tracking_status_falls_back_to_latest_activity_status(
        self, mock_get, _mock_token, mock_get_config
    ):
        mock_get_config.return_value = SimpleNamespace(
            ups={"client_id": "client-id", "client_secret": "client-secret", "merchant_id": "", "use_cie": False}
        )
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "trackResponse": {
                "shipment": [
                    {
                        "inquiryNumber": "1ZTEST456",
                        "package": [
                            {
                                "activity": [
                                    {
                                        "status": {"description": "Out for Delivery"},
                                        "date": "20260402",
                                        "time": "071500",
                                    }
                                ]
                            }
                        ],
                    }
                ]
            }
        }
        mock_get.return_value = response

        result = ups_tracking.fetch_tracking_status("1ZTEST456")

        self.assertEqual(result["trackingStatus"], "out_for_delivery")
        self.assertEqual(result["trackingStatusRaw"], "Out for Delivery")

    @patch("python_backend.integrations.ups_tracking.get_config")
    @patch("python_backend.integrations.ups_tracking._get_access_token", return_value="token-1")
    @patch("python_backend.integrations.ups_tracking.http_client.get")
    def test_fetch_tracking_status_extracts_estimated_delivery_window(
        self, mock_get, _mock_token, mock_get_config
    ):
        mock_get_config.return_value = SimpleNamespace(
            ups={"client_id": "client-id", "client_secret": "client-secret", "merchant_id": "", "use_cie": False}
        )
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "trackResponse": {
                "shipment": [
                    {
                        "inquiryNumber": "1ZESTIMATE1",
                        "package": [
                            {
                                "currentStatus": {
                                    "simplifiedTextDescription": "On the Way",
                                    "description": "In Transit",
                                    "statusCode": "012",
                                },
                                "deliveryDate": [{"type": "SDD", "date": "20260407"}],
                                "deliveryTime": {
                                    "type": "EDW",
                                    "startTime": "140000",
                                    "endTime": "180000",
                                },
                            }
                        ],
                    }
                ]
            }
        }
        mock_get.return_value = response

        result = ups_tracking.fetch_tracking_status("1ZESTIMATE1")

        self.assertEqual(result["trackingStatus"], "in_transit")
        self.assertEqual(result["estimatedArrivalDate"], "2026-04-07T18:00:00")
        self.assertEqual(result["deliveryDateGuaranteed"], "2026-04-07T00:00:00")
        self.assertEqual(
            result["expectedShipmentWindow"],
            "Tuesday, April 7, 2026, between 2:00 PM - 6:00 PM",
        )

    @patch("python_backend.integrations.ups_tracking.get_config")
    @patch("python_backend.integrations.ups_tracking._get_access_token", return_value="token-1")
    @patch("python_backend.integrations.ups_tracking.http_client.get")
    def test_fetch_tracking_status_maps_shipper_created_label_phrase(
        self, mock_get, _mock_token, mock_get_config
    ):
        mock_get_config.return_value = SimpleNamespace(
            ups={"client_id": "client-id", "client_secret": "client-secret", "merchant_id": "", "use_cie": False}
        )
        response = MagicMock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "trackResponse": {
                "shipment": [
                    {
                        "inquiryNumber": "1ZTEST789",
                        "package": [
                            {
                                "currentStatus": {
                                    "description": "Package progress",
                                    "statusCode": "M",
                                },
                                "activity": [
                                    {
                                        "status": {
                                            "description": "Shipper created a label, UPS has not received the package yet.",
                                        },
                                        "date": "20260402",
                                        "time": "071500",
                                    }
                                ],
                            }
                        ],
                    }
                ]
            }
        }
        mock_get.return_value = response

        result = ups_tracking.fetch_tracking_status("1ZTEST789")

        self.assertEqual(result["trackingStatus"], "label_created")
        self.assertEqual(
            result["trackingStatusRaw"],
            "Shipper created a label, UPS has not received the package yet.",
        )


if __name__ == "__main__":
    unittest.main()
