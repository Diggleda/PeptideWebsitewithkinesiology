import threading
import unittest
from unittest.mock import Mock, patch

import requests

from python_backend.integrations import woo_commerce


class WooCommerceProxyGuardrailTests(unittest.TestCase):
    def setUp(self):
        self.original_inflight_wait = woo_commerce._WOO_PROXY_INFLIGHT_WAIT_SECONDS
        with woo_commerce._catalog_cache_lock:
            woo_commerce._catalog_cache.clear()
            woo_commerce._inflight.clear()
            woo_commerce._proxy_failures.clear()

    def tearDown(self):
        woo_commerce._WOO_PROXY_INFLIGHT_WAIT_SECONDS = self.original_inflight_wait
        with woo_commerce._catalog_cache_lock:
            woo_commerce._catalog_cache.clear()
            woo_commerce._inflight.clear()
            woo_commerce._proxy_failures.clear()

    def test_follower_does_not_start_second_live_fetch_after_wait_timeout(self):
        params = {"status": "publish"}
        cache_key = woo_commerce._build_cache_key("products/1512", params)
        woo_commerce._WOO_PROXY_INFLIGHT_WAIT_SECONDS = 0.01
        with woo_commerce._catalog_cache_lock:
            woo_commerce._inflight[cache_key] = {
                "event": threading.Event(),
                "data": None,
                "error": None,
                "leader": True,
            }

        with (
            patch.object(woo_commerce, "is_configured", return_value=True),
            patch.object(woo_commerce, "_read_disk_cache", return_value=None),
            patch.object(woo_commerce, "_fetch_catalog_http") as fetch_catalog_http,
        ):
            with self.assertRaises(woo_commerce.IntegrationError) as ctx:
                woo_commerce.fetch_catalog_proxy("products/1512", params)

        fetch_catalog_http.assert_not_called()
        self.assertEqual(getattr(ctx.exception, "status", None), 503)

    def test_catalog_http_timeout_reports_504(self):
        with (
            patch.object(
                woo_commerce,
                "_client_config",
                return_value=("https://shop.example.test", "wc/v3", None, 120),
            ),
            patch.object(woo_commerce.logger, "warning"),
            patch.object(woo_commerce.requests, "get", side_effect=requests.Timeout("slow upstream")),
        ):
            with self.assertRaises(woo_commerce.IntegrationError) as ctx:
                woo_commerce._fetch_catalog_http("products/1512", {"status": "publish"}, suppress_log=True)

        self.assertEqual(getattr(ctx.exception, "status", None), 504)

    def test_catalog_http_busy_reports_503(self):
        acquired_permits = []
        for _ in range(woo_commerce._WOO_HTTP_CONCURRENCY):
            acquired = woo_commerce._woo_http_semaphore.acquire(blocking=False)
            self.assertTrue(acquired)
            acquired_permits.append(True)
        try:
            with (
                patch.object(
                    woo_commerce,
                    "_client_config",
                    return_value=("https://shop.example.test", "wc/v3", None, 120),
                ),
                patch.object(woo_commerce.requests, "get", Mock()),
            ):
                with self.assertRaises(woo_commerce.IntegrationError) as ctx:
                    woo_commerce._fetch_catalog_http(
                        "products/1512",
                        {"status": "publish"},
                        suppress_log=True,
                        acquire_timeout=0.01,
                    )
        finally:
            for _ in acquired_permits:
                try:
                    woo_commerce._woo_http_semaphore.release()
                except ValueError:
                    pass

        self.assertEqual(getattr(ctx.exception, "status", None), 503)


if __name__ == "__main__":
    unittest.main()
