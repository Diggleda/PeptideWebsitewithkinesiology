from __future__ import annotations

import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from python_backend.services import sales_prospect_quote_pdf_service as service


class SalesProspectQuotePdfServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._disk_cache_temp_dir = tempfile.TemporaryDirectory()
        self._disk_cache_dir_patch = patch.object(
            service,
            "_quote_pdf_disk_cache_dir",
            return_value=Path(self._disk_cache_temp_dir.name),
        )
        self._disk_cache_dir_patch.start()
        self._original_node_bridge_skip_until = service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC
        service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = 0.0
        self._original_node_worker_process = service._NODE_WORKER_PROCESS
        service._NODE_WORKER_PROCESS = None
        self._original_node_worker_signature = service._NODE_WORKER_SIGNATURE
        service._NODE_WORKER_SIGNATURE = None
        service._QUOTE_PDF_RENDER_CACHE.clear()
        service._SKU_PRODUCT_IMAGE_CACHE.clear()
        service._IMAGE_DATA_URL_CACHE.clear()
        service._QUOTE_PDF_RENDER_INFLIGHT.clear()
        service._SKU_PRODUCT_IMAGE_INFLIGHT.clear()
        service._IMAGE_DATA_URL_INFLIGHT.clear()
        self._original_cached_woo_sku_image_map = service._CACHED_WOO_SKU_IMAGE_MAP
        service._CACHED_WOO_SKU_IMAGE_MAP = None

    def tearDown(self) -> None:
        try:
            service._shutdown_node_worker_process()
        except Exception:
            pass
        self._disk_cache_dir_patch.stop()
        self._disk_cache_temp_dir.cleanup()
        service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = self._original_node_bridge_skip_until
        service._NODE_WORKER_PROCESS = self._original_node_worker_process
        service._NODE_WORKER_SIGNATURE = self._original_node_worker_signature
        service._QUOTE_PDF_RENDER_CACHE.clear()
        service._SKU_PRODUCT_IMAGE_CACHE.clear()
        service._IMAGE_DATA_URL_CACHE.clear()
        service._QUOTE_PDF_RENDER_INFLIGHT.clear()
        service._SKU_PRODUCT_IMAGE_INFLIGHT.clear()
        service._IMAGE_DATA_URL_INFLIGHT.clear()
        service._CACHED_WOO_SKU_IMAGE_MAP = self._original_cached_woo_sku_image_map

    def test_render_quote_html_uses_logo_image_when_available(self) -> None:
        quote = {
            "revisionNumber": 1,
            "title": "Quote for Client Example",
            "quotePayloadJson": {
                "prospect": {"contactName": "Client Example"},
                "salesRep": {"name": "Rep Example", "email": "rep@example.com", "phone": "317-555-0101"},
                "items": [],
            },
        }

        with patch.object(service, "_get_logo_data_url", return_value="data:image/png;base64,abc123"):
            html = service._render_quote_html(quote)

        self.assertIn('<img class="brand-logo" src="data:image/png;base64,abc123" alt="PepPro" />', html)
        self.assertNotIn('<div class="brand">PepPro</div>', html)
        self.assertIn('<div class="meta-label">Physician</div>', html)
        self.assertNotIn('<div class="meta-label">Prospect</div>', html)
        self.assertIn("317-555-0101", html)

    def test_ensure_node_worker_process_restarts_when_renderer_signature_changes(self) -> None:
        class DummyProcess:
            def __init__(self, label: str) -> None:
                self.label = label
                self.stdin = None
                self.stdout = None
                self.stderr = None
                self._returncode = None

            def poll(self):
                return self._returncode

            def terminate(self) -> None:
                self._returncode = 0

            def wait(self, timeout=None) -> int:
                return 0

            def kill(self) -> None:
                self._returncode = -9

        started: list[DummyProcess] = []

        def fake_popen(*args, **kwargs):
            process = DummyProcess(f"worker-{len(started) + 1}")
            started.append(process)
            return process

        with patch.object(service, "_worker_script_path", return_value=Path(__file__)), patch.object(
            service, "_find_node_binary", return_value="node"
        ), patch.object(service, "_build_node_renderer_env", return_value={}), patch.object(
            service, "_node_worker_signature", side_effect=["sig-a", "sig-a", "sig-b"]
        ), patch.object(service.subprocess, "Popen", side_effect=fake_popen):
            first = service._ensure_node_worker_process()
            second = service._ensure_node_worker_process()
            third = service._ensure_node_worker_process()

        self.assertIs(first, second)
        self.assertIsNotNone(first)
        self.assertIsNotNone(third)
        self.assertIsNot(first, third)
        self.assertEqual(len(started), 2)

    def test_render_quote_html_displays_subtotal_with_colon(self) -> None:
        quote = {
            "revisionNumber": 1,
            "currency": "USD",
            "subtotal": 93.91,
            "quotePayloadJson": {
                "prospect": {"contactName": "Client Example"},
                "items": [],
            },
        }

        html = service._render_quote_html(quote)

        self.assertIn('<div class="summary-row">', html)
        self.assertIn('<span>Subtotal:</span>', html)
        self.assertIn('<span>$93.91</span>', html)

    def test_resolve_quote_item_image_data_urls_preserves_item_order(self) -> None:
        items = [
            {"name": "First"},
            {"name": "Second"},
        ]

        def resolve(item):
            if item["name"] == "First":
                time.sleep(0.03)
                return "data:image/png;base64,first"
            return "data:image/png;base64,second"

        with patch.object(service, "_resolve_quote_item_image_data_url", side_effect=resolve):
            resolved = service._resolve_quote_item_image_data_urls(items)

        self.assertEqual(
            resolved,
            [
                "data:image/png;base64,first",
                "data:image/png;base64,second",
            ],
        )

    def test_collect_quote_item_image_candidates_prefers_cached_woo_proxy_image_before_live_product_cache(self) -> None:
        item = {"sku": "SKU-123"}
        service._SKU_PRODUCT_IMAGE_CACHE["SKU-123"] = "https://cdn.example.com/products/live-fallback.png"

        with patch.object(
            service,
            "_get_cached_woo_sku_image_map",
            return_value={"SKU-123": "https://cdn.example.com/products/sku-123.png"},
        ):
            candidates = service._collect_quote_item_image_candidates(item)

        self.assertEqual(candidates, ["https://cdn.example.com/products/sku-123.png"])

    def test_generate_prospect_quote_pdf_uses_system_browser_renderer_when_node_bridge_is_unavailable(self) -> None:
        with patch.object(service, "_run_node_worker_bridge", return_value=None), patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service,
            "_run_system_browser_renderer",
            return_value={"pdf": b"%PDF-1.4 styled", "filename": "PepPro_Quote_Client_Example_2.pdf"},
        ), patch.object(service, "_allow_text_fallback", return_value=False):
            rendered = service.generate_prospect_quote_pdf({"revisionNumber": 2, "quotePayloadJson": {}})

        self.assertEqual(rendered["pdf"], b"%PDF-1.4 styled")
        self.assertEqual(rendered["filename"], "PepPro_Quote_Client_Example_2.pdf")

    def test_generate_prospect_quote_pdf_caches_successful_result_for_same_quote(self) -> None:
        quote = {"id": "quote-1", "revisionNumber": 2, "quotePayloadJson": {"prospect": {"contactName": "Client Example"}}}

        with patch.object(service, "_run_node_worker_bridge", return_value=None), patch.object(
            service,
            "_run_node_bridge",
            return_value={"pdf": b"%PDF-1.4 styled", "filename": "PepPro_Quote_Client_Example_2.pdf"},
        ) as run_node_bridge, patch.object(service, "_run_system_browser_renderer") as run_system_browser_renderer:
            first = service.generate_prospect_quote_pdf(quote)
            second = service.generate_prospect_quote_pdf(quote)

        self.assertEqual(run_node_bridge.call_count, 1)
        run_system_browser_renderer.assert_not_called()
        self.assertEqual(first["pdf"], second["pdf"])
        self.assertEqual(first["filename"], second["filename"])

    def test_generate_prospect_quote_pdf_uses_disk_cache_after_memory_cache_reset(self) -> None:
        quote = {"id": "quote-2", "revisionNumber": 2, "quotePayloadJson": {"prospect": {"contactName": "Client Example"}}}

        with patch.object(service, "_run_node_worker_bridge", return_value=None), patch.object(
            service,
            "_run_node_bridge",
            return_value={"pdf": b"%PDF-1.4 styled", "filename": "PepPro_Quote_Client_Example_2.pdf"},
        ) as run_node_bridge, patch.object(service, "_run_system_browser_renderer") as run_system_browser_renderer:
            first = service.generate_prospect_quote_pdf(quote)
            service._QUOTE_PDF_RENDER_CACHE.clear()
            second = service.generate_prospect_quote_pdf(quote)

        self.assertEqual(run_node_bridge.call_count, 1)
        run_system_browser_renderer.assert_not_called()
        self.assertEqual(first["pdf"], second["pdf"])
        self.assertEqual(first["filename"], second["filename"])

    def test_generate_prospect_quote_pdf_rehydrates_memory_from_disk_without_rewriting_disk_cache(self) -> None:
        quote = {"id": "quote-2b", "revisionNumber": 2, "quotePayloadJson": {"prospect": {"contactName": "Client Example"}}}

        with patch.object(service, "_run_node_worker_bridge", return_value=None), patch.object(
            service,
            "_run_node_bridge",
            return_value={"pdf": b"%PDF-1.4 styled", "filename": "PepPro_Quote_Client_Example_2.pdf"},
        ), patch.object(service, "_store_rendered_quote_pdf_to_disk", wraps=service._store_rendered_quote_pdf_to_disk) as store_to_disk:
            first = service.generate_prospect_quote_pdf(quote)

        self.assertEqual(store_to_disk.call_count, 1)
        service._QUOTE_PDF_RENDER_CACHE.clear()

        with patch.object(service, "_store_rendered_quote_pdf_to_disk", wraps=service._store_rendered_quote_pdf_to_disk) as store_to_disk_again, patch.object(
            service, "_run_node_worker_bridge", side_effect=AssertionError("renderer should not run on disk cache hit")
        ), patch.object(
            service, "_run_node_bridge", side_effect=AssertionError("renderer should not run on disk cache hit")
        ), patch.object(
            service, "_run_system_browser_renderer", side_effect=AssertionError("renderer should not run on disk cache hit")
        ):
            second = service.generate_prospect_quote_pdf(quote)

        self.assertEqual(store_to_disk_again.call_count, 0)
        self.assertEqual(first["pdf"], second["pdf"])
        self.assertEqual(first["filename"], second["filename"])

    def test_build_quote_render_cache_key_includes_template_version(self) -> None:
        quote = {"id": "quote-cache-version", "revisionNumber": 2, "quotePayloadJson": {"prospect": {"contactName": "Client Example"}}}

        with patch.object(service, "_QUOTE_PDF_TEMPLATE_VERSION", "version-a"):
            first = service._build_quote_render_cache_key(quote)

        with patch.object(service, "_QUOTE_PDF_TEMPLATE_VERSION", "version-b"):
            second = service._build_quote_render_cache_key(quote)

        self.assertNotEqual(first, second)

    def test_run_node_bridge_skips_lookup_during_retry_cooldown(self) -> None:
        service._NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + 30

        with patch.object(service, "_find_node_binary", side_effect=AssertionError("bridge lookup should be skipped")):
            rendered = service._run_node_bridge({"revisionNumber": 1, "quotePayloadJson": {}})

        self.assertIsNone(rendered)

    def test_generate_prospect_quote_pdf_prefers_node_worker_before_one_shot_bridge(self) -> None:
        quote = {"id": "quote-worker-1", "revisionNumber": 3, "quotePayloadJson": {"prospect": {"contactName": "Worker Example"}}}

        with patch.object(
            service,
            "_run_node_worker_bridge",
            return_value={"pdf": b"%PDF-1.4 worker", "filename": "PepPro_Quote_Worker_Example_3.pdf"},
        ) as run_node_worker, patch.object(service, "_run_node_bridge", side_effect=AssertionError("one-shot bridge should not run")), patch.object(
            service, "_run_system_browser_renderer", side_effect=AssertionError("browser fallback should not run")
        ):
            rendered = service.generate_prospect_quote_pdf(quote)

        self.assertEqual(run_node_worker.call_count, 1)
        self.assertEqual(rendered["pdf"], b"%PDF-1.4 worker")
        self.assertEqual(rendered["filename"], "PepPro_Quote_Worker_Example_3.pdf")

    def test_generate_prospect_quote_pdf_deduplicates_inflight_render_for_same_quote(self) -> None:
        quote = {"id": "quote-inflight-1", "revisionNumber": 4, "quotePayloadJson": {"prospect": {"contactName": "Client Example"}}}
        render_started = threading.Event()
        release_render = threading.Event()
        render_calls = 0
        render_calls_lock = threading.Lock()

        def render(_: dict) -> dict:
            nonlocal render_calls
            with render_calls_lock:
                render_calls += 1
            render_started.set()
            self.assertTrue(release_render.wait(timeout=1.0))
            return {"pdf": b"%PDF-1.4 shared", "filename": "PepPro_Quote_Client_Example_4.pdf"}

        with patch.object(service, "_run_node_worker_bridge", side_effect=render), patch.object(
            service, "_run_node_bridge", side_effect=AssertionError("fallback renderer should not run")
        ), patch.object(service, "_run_system_browser_renderer", side_effect=AssertionError("fallback renderer should not run")):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first_future = executor.submit(service.generate_prospect_quote_pdf, quote)
                self.assertTrue(render_started.wait(timeout=1.0))
                second_future = executor.submit(service.generate_prospect_quote_pdf, quote)
                time.sleep(0.05)
                release_render.set()
                first = first_future.result(timeout=1.0)
                second = second_future.result(timeout=1.0)

        self.assertEqual(render_calls, 1)
        self.assertEqual(first["pdf"], second["pdf"])
        self.assertEqual(first["filename"], second["filename"])

    def test_fetch_image_as_data_url_deduplicates_inflight_fetches(self) -> None:
        started = threading.Event()
        release = threading.Event()
        call_count = 0
        call_count_lock = threading.Lock()

        class FakeResponse:
            headers = {"Content-Type": "image/png"}

            def read(self) -> bytes:
                return b"png-bytes"

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, exc_type, exc, tb) -> bool:
                return False

        def fake_urlopen(request, timeout):
            del request, timeout
            nonlocal call_count
            with call_count_lock:
                call_count += 1
            started.set()
            self.assertTrue(release.wait(timeout=1.0))
            return FakeResponse()

        url = "https://cdn.example.com/test-image.png"
        with patch.object(service, "urlopen", side_effect=fake_urlopen):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first_future = executor.submit(service._fetch_image_as_data_url, url)
                self.assertTrue(started.wait(timeout=1.0))
                second_future = executor.submit(service._fetch_image_as_data_url, url)
                time.sleep(0.05)
                release.set()
                first = first_future.result(timeout=1.0)
                second = second_future.result(timeout=1.0)

        self.assertEqual(call_count, 1)
        self.assertEqual(first, second)
        self.assertTrue(str(first).startswith("data:image/png;base64,"))

    def test_collect_quote_item_image_candidates_deduplicates_inflight_sku_lookups(self) -> None:
        started = threading.Event()
        release = threading.Event()
        call_count = 0
        call_count_lock = threading.Lock()

        def fake_find_product_by_sku(sku: str):
            self.assertEqual(sku, "SKU-123")
            nonlocal call_count
            with call_count_lock:
                call_count += 1
            started.set()
            self.assertTrue(release.wait(timeout=1.0))
            return {"image": "https://cdn.example.com/sku-123.png"}

        item = {"sku": "SKU-123"}
        with patch.object(service, "_get_cached_woo_sku_image_map", return_value={}), patch.object(
            service,
            "_lookup_product_image_source_for_sku",
            side_effect=fake_find_product_by_sku,
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                first_future = executor.submit(service._collect_quote_item_image_candidates, item)
                self.assertTrue(started.wait(timeout=1.0))
                second_future = executor.submit(service._collect_quote_item_image_candidates, item)
                time.sleep(0.05)
                release.set()
                first = first_future.result(timeout=1.0)
                second = second_future.result(timeout=1.0)

        self.assertEqual(call_count, 1)
        self.assertEqual(first, ["https://cdn.example.com/sku-123.png"])
        self.assertEqual(second, ["https://cdn.example.com/sku-123.png"])

    def test_generate_prospect_quote_pdf_falls_back_when_enabled(self) -> None:
        quote = {
            "prospectId": "prospect-1",
            "revisionNumber": 2,
            "title": "Quote for Client Example",
            "currency": "USD",
            "subtotal": 1131.87,
            "quotePayloadJson": {
                "notes": "Call before shipping",
                "prospect": {
                    "contactName": "Client Example",
                    "contactEmail": "client@example.com",
                },
                "salesRep": {
                    "name": "Peter J. Gibbons",
                    "email": "rep@example.com",
                },
                "items": [
                    {
                        "name": "Oxytocin N - 10mg",
                        "quantity": 1,
                        "unitPrice": 93.91,
                        "lineTotal": 93.91,
                        "sku": "OXYT-10",
                    }
                ],
            },
        }

        with patch.object(service, "_run_node_worker_bridge", return_value=None), patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service, "_run_system_browser_renderer", return_value=None
        ), patch.object(service, "_allow_text_fallback", return_value=True):
            rendered = service.generate_prospect_quote_pdf(quote)

        self.assertTrue(rendered["pdf"].startswith(b"%PDF-1.4"))
        self.assertEqual(rendered["filename"], "PepPro_Quote_Client_Example_2.pdf")

    def test_build_fallback_quote_pdf_uses_physician_label(self) -> None:
        quote = {
            "revisionNumber": 2,
            "title": "Quote for Client Example",
            "quotePayloadJson": {
                "prospect": {
                    "contactName": "Client Example",
                    "contactEmail": "client@example.com",
                },
                "salesRep": {
                    "name": "Rep Example",
                    "phone": "317-555-0101",
                },
                "items": [],
            },
        }

        with patch.object(service, "_build_simple_text_pdf", return_value=b"%PDF-1.4 fallback") as build_pdf:
            rendered = service._build_fallback_quote_pdf(quote)

        self.assertEqual(rendered["pdf"], b"%PDF-1.4 fallback")
        self.assertEqual(build_pdf.call_count, 1)
        text_body = build_pdf.call_args.args[0]
        self.assertIn("Physician: Client Example", text_body)
        self.assertNotIn("Prospect: Client Example", text_body)
        self.assertIn("Sales Rep Phone: 317-555-0101", text_body)

    def test_generate_prospect_quote_pdf_raises_when_renderer_unavailable_and_fallback_disabled(self) -> None:
        with patch.object(service, "_run_node_worker_bridge", return_value=None), patch.object(service, "_run_node_bridge", return_value=None), patch.object(
            service, "_run_system_browser_renderer", return_value=None
        ), patch.object(
            service, "_allow_text_fallback", return_value=False
        ):
            with self.assertRaises(ValueError) as context:
                service.generate_prospect_quote_pdf({"revisionNumber": 1, "quotePayloadJson": {}})

        self.assertEqual(str(context.exception), "QUOTE_PDF_RENDERER_UNAVAILABLE")


if __name__ == "__main__":
    unittest.main()
