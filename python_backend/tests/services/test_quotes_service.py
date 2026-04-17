from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

fake_requests = types.ModuleType("requests")


class _FakeRequestException(Exception):
    pass


fake_requests.RequestException = _FakeRequestException
sys.modules.setdefault("requests", fake_requests)

from python_backend.services import quotes_service


class QuotesServiceTests(unittest.TestCase):
    def test_get_daily_quote_uses_today_cache_without_fetching_feed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir)
            (data_dir / "daily-quote.json").write_text(
                json.dumps(
                    {
                        "date": quotes_service._today_key(),
                        "id": "quote-1",
                        "text": "Cached daily quote",
                        "author": "PepPro",
                    }
                )
            )
            config = SimpleNamespace(data_dir=data_dir, quotes={}, integrations={})

            with patch.object(quotes_service, "get_config", return_value=config), patch.object(
                quotes_service,
                "_fetch_quotes",
                side_effect=AssertionError("quote feed should not be fetched when today's cache exists"),
            ):
                result = quotes_service.get_daily_quote()

        self.assertEqual(
            result,
            {
                "text": "Cached daily quote",
                "author": "PepPro",
            },
        )

    def test_get_daily_quote_uses_cached_feed_when_todays_selection_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir)
            (data_dir / "quotes-feed.json").write_text(
                json.dumps(
                    {
                        "fetchedAt": "2026-04-16T00:00:00Z",
                        "quotes": [
                            {
                                "id": "quote-2",
                                "text": "Feed cached quote",
                                "author": "PepPro",
                            }
                        ],
                    }
                )
            )
            config = SimpleNamespace(data_dir=data_dir, quotes={}, integrations={})

            with patch.object(quotes_service, "get_config", return_value=config), patch.object(
                quotes_service,
                "_fetch_quotes",
                side_effect=AssertionError("quote feed should not be fetched when feed cache exists"),
            ):
                result = quotes_service.get_daily_quote()

            stored = json.loads((data_dir / "daily-quote.json").read_text())

        self.assertEqual(
            result,
            {
                "text": "Feed cached quote",
                "author": "PepPro",
            },
        )
        self.assertEqual(stored["text"], "Feed cached quote")

    def test_get_daily_quote_prefers_mysql_and_rewrites_legacy_cache_shape(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            data_dir = Path(tmpdir)
            (data_dir / "daily-quote.json").write_text(
                json.dumps(
                    {
                        "date": quotes_service._today_key(),
                        "id": 165,
                    }
                )
            )
            config = SimpleNamespace(data_dir=data_dir, quotes={}, integrations={})
            mysql_stub = SimpleNamespace(
                is_enabled=lambda: True,
                fetch_all=lambda *args, **kwargs: [
                    {
                        "id": 165,
                        "text": "Database quote",
                        "author": "PepPro",
                    }
                ],
            )

            with patch.object(quotes_service, "get_config", return_value=config), patch.object(
                quotes_service,
                "mysql_client",
                mysql_stub,
            ), patch.object(
                quotes_service.http_client,
                "get",
                side_effect=AssertionError("remote quote feed should not be fetched when MySQL is available"),
            ):
                result = quotes_service.get_daily_quote()

            stored = json.loads((data_dir / "daily-quote.json").read_text())

        self.assertEqual(
            result,
            {
                "text": "Database quote",
                "author": "PepPro",
            },
        )
        self.assertEqual(stored["text"], "Database quote")
        self.assertEqual(stored["author"], "PepPro")


if __name__ == "__main__":
    unittest.main()
