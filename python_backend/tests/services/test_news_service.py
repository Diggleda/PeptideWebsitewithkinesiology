import unittest
from unittest.mock import patch


class TestNewsService(unittest.TestCase):
    def test_fetch_peptide_news_uses_cached_items_within_ttl(self):
        try:
            from python_backend.services import news_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        item = news_service.NewsItem(title="Cached", url="https://example.com", summary="ok")

        with patch.object(news_service, "_CACHE", {"items": None, "expiresAt": 0.0, "fetchedAt": 0.0}), \
            patch.object(news_service, "_INFLIGHT_EVENT", None), \
            patch.object(news_service, "_fetch_page_html", return_value="<html />") as fetch_html, \
            patch.object(news_service, "_parse_news", return_value=[item]) as parse_news, \
            patch.object(news_service, "_sort_by_date", side_effect=lambda items: items), \
            patch.object(news_service.time, "monotonic", side_effect=[100.0, 100.0, 101.0]):
            first = news_service.fetch_peptide_news(limit=8)
            second = news_service.fetch_peptide_news(limit=8)

        self.assertEqual(len(first), 1)
        self.assertEqual(len(second), 1)
        self.assertEqual(first[0].title, "Cached")
        self.assertEqual(second[0].title, "Cached")
        self.assertEqual(fetch_html.call_count, 1)
        self.assertEqual(parse_news.call_count, 1)


if __name__ == "__main__":
    unittest.main()
