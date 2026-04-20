import unittest
from unittest.mock import patch


class TestNewsService(unittest.TestCase):
    def test_fetch_peptide_news_uses_fresh_cached_items_within_ttl(self):
        try:
            from python_backend.services import news_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        item = news_service.NewsItem(title="Cached", url="https://example.com", summary="ok")

        with patch.object(
            news_service,
            "_CACHE",
            {"items": [item], "expiresAt": 200.0, "fetchedAt": 100.0},
        ), \
            patch.object(news_service, "_CACHE_LOADED", True), \
            patch.object(news_service, "_INFLIGHT_EVENT", None), \
            patch.object(news_service, "_fetch_page_html", return_value="<html />") as fetch_html, \
            patch.object(news_service, "_parse_news", return_value=[item]) as parse_news, \
            patch.object(news_service, "_sort_by_date", side_effect=lambda items: items), \
            patch.object(news_service, "_persist_cache_snapshot"), \
            patch.object(news_service.time, "time", side_effect=[100.0, 101.0]):
            first = news_service.fetch_peptide_news(limit=8)
            second = news_service.fetch_peptide_news(limit=8)

        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 1)
        self.assertEqual(first[0].title, "Cached")
        self.assertEqual(second[0].title, "Cached")
        self.assertEqual(fetch_html.call_count, 0)
        self.assertEqual(parse_news.call_count, 0)

    def test_fetch_peptide_news_returns_stale_cache_and_schedules_refresh(self):
        try:
            from python_backend.services import news_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        stale_item = news_service.NewsItem(title="Stale", url="https://example.com/stale", summary="old")

        with patch.object(
            news_service,
            "_CACHE",
            {"items": [stale_item], "expiresAt": 50.0, "fetchedAt": 40.0},
        ), patch.object(news_service, "_CACHE_LOADED", True), \
            patch.object(news_service, "_schedule_refresh_locked") as schedule_refresh, \
            patch.object(news_service.time, "time", return_value=100.0):
            items = news_service.fetch_peptide_news(limit=8)

        self.assertEqual([item.title for item in items], ["Stale"])
        schedule_refresh.assert_called_once()

    def test_fetch_peptide_news_returns_empty_and_schedules_refresh_without_blocking_when_cache_missing(self):
        try:
            from python_backend.services import news_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(
            news_service,
            "_CACHE",
            {"items": None, "expiresAt": 0.0, "fetchedAt": 0.0},
        ), patch.object(news_service, "_CACHE_LOADED", True), \
            patch.object(news_service, "_schedule_refresh_locked") as schedule_refresh, \
            patch.object(news_service.time, "time", return_value=100.0):
            items = news_service.fetch_peptide_news(limit=8)

        self.assertEqual(items, [])
        schedule_refresh.assert_called_once()


if __name__ == "__main__":
    unittest.main()
