import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import requests

from python_backend.integrations import ship_station


class TestShipStation(unittest.TestCase):
    def setUp(self):
        ship_station._order_status_cache.clear()
        ship_station._shipstation_unavailable_until = 0.0

    @patch("python_backend.integrations.ship_station.get_config")
    @patch("python_backend.integrations.ship_station.http_client.get")
    @patch("python_backend.integrations.ship_station.time.time", return_value=1000.0)
    def test_fetch_order_status_payment_required_pauses_and_returns_none(
        self, _mock_time, mock_get, mock_get_config
    ):
        mock_get_config.return_value = SimpleNamespace(
            ship_station={"api_token": "token", "api_key": "", "api_secret": ""}
        )

        resp = MagicMock()
        resp.status_code = 402
        resp.json.side_effect = ValueError("no json")
        resp.text = "Payment Required"
        http_error = requests.HTTPError("402 Client Error", response=resp)

        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = http_error
        mock_get.return_value = mock_response

        self.assertIsNone(ship_station.fetch_order_status("1266"))
        self.assertIsNone(ship_station.fetch_order_status("1266"))
        self.assertEqual(mock_get.call_count, 1)

    @patch("python_backend.integrations.ship_station.get_config")
    @patch("python_backend.integrations.ship_station.http_client.get")
    @patch("python_backend.integrations.ship_station.time.time", return_value=1000.0)
    def test_fetch_order_status_not_found_is_cached(
        self, _mock_time, mock_get, mock_get_config
    ):
        mock_get_config.return_value = SimpleNamespace(
            ship_station={"api_token": "token", "api_key": "", "api_secret": ""}
        )

        resp = MagicMock()
        resp.status_code = 404
        resp.json.side_effect = ValueError("no json")
        resp.text = "Not Found"
        http_error = requests.HTTPError("404 Client Error", response=resp)

        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = http_error
        mock_get.return_value = mock_response

        self.assertIsNone(ship_station.fetch_order_status("missing-order"))
        self.assertIsNone(ship_station.fetch_order_status("missing-order"))
        self.assertEqual(mock_get.call_count, 1)


if __name__ == "__main__":
    unittest.main()

