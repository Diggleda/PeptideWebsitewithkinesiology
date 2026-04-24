import threading
import time
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

    def test_catalog_http_wall_timeout_reports_504_without_waiting_for_socket(self):
        started = threading.Event()
        released = threading.Event()
        original_release = woo_commerce._release_woo_http_permit

        def slow_get(*args, **kwargs):
            started.set()
            time.sleep(0.2)
            response = requests.Response()
            response.status_code = 200
            response._content = b"{}"
            return response

        def release_permit():
            original_release()
            released.set()

        with (
            patch.object(
                woo_commerce,
                "_client_config",
                return_value=("https://shop.example.test", "wc/v3", None, 0.05),
            ),
            patch.object(woo_commerce, "_timeout_seconds_for_endpoint", return_value=0.05),
            patch.object(woo_commerce, "_release_woo_http_permit", side_effect=release_permit),
            patch.object(woo_commerce.logger, "warning"),
            patch.object(woo_commerce.requests, "get", side_effect=slow_get),
        ):
            started_at = time.perf_counter()
            with self.assertRaises(woo_commerce.IntegrationError) as ctx:
                woo_commerce._fetch_catalog_http("products/1512", {"status": "publish"}, suppress_log=True)
            elapsed = time.perf_counter() - started_at
            released_before_context_exit = released.wait(timeout=1.0)

        self.assertTrue(started.is_set())
        self.assertLess(elapsed, 0.18)
        self.assertEqual(getattr(ctx.exception, "status", None), 504)
        self.assertTrue(released_before_context_exit)

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

    def test_proxy_returns_before_disk_cache_write_finishes(self):
        started = threading.Event()
        release = threading.Event()

        def slow_write(cache_key, payload):
            started.set()
            release.wait(timeout=1.0)

        with (
            patch.object(woo_commerce, "is_configured", return_value=True),
            patch.object(woo_commerce, "_read_disk_cache", return_value=None),
            patch.object(woo_commerce, "_fetch_catalog_http", return_value={"id": 1512}),
            patch.object(woo_commerce, "_write_disk_cache_sync", side_effect=slow_write),
        ):
            started_at = time.perf_counter()
            data, meta = woo_commerce.fetch_catalog_proxy("products/1512", {"status": "publish"})
            elapsed = time.perf_counter() - started_at
            self.assertTrue(started.wait(timeout=1.0))
            release.set()

        self.assertEqual(data, {"id": 1512})
        self.assertEqual(meta["cache"], "MISS")
        self.assertLess(elapsed, 0.1)


if __name__ == "__main__":
    unittest.main()
