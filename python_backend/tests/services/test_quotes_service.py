from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from datetime import date
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
                        "date": date.today().isoformat(),
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


if __name__ == "__main__":
    unittest.main()
