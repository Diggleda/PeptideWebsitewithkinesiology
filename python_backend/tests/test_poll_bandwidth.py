import importlib.util
from pathlib import Path
import sys
import unittest


def _load_poll_bandwidth_module():
    module_name = "python_backend.scripts.poll_bandwidth"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing

    script_path = Path(__file__).resolve().parents[1] / "scripts" / "poll_bandwidth.py"
    spec = importlib.util.spec_from_file_location(module_name, script_path)
    if spec is None or spec.loader is None:
        raise unittest.SkipTest("unable to load poll_bandwidth.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class TestPollBandwidth(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = _load_poll_bandwidth_module()

    def test_parse_http_access_line_reads_new_request_log_format(self):
        line = (
            "2026-03-27 11:32:10,123 INFO peppro.http :: "
            "HTTP method=GET path=/api/orders/abc123 route=/api/orders/<order_id> "
            "status=200 duration_ms=42.5 req_bytes=0 resp_bytes=8192 "
            "client_ip=203.0.113.10 resp_type=application/json"
        )

        entry = self.module.parse_http_access_line(line)

        self.assertIsNotNone(entry)
        self.assertEqual(entry.method, "GET")
        self.assertEqual(entry.path, "/api/orders/abc123")
        self.assertEqual(entry.route, "/api/orders/<order_id>")
        self.assertEqual(entry.status, 200)
        self.assertEqual(entry.duration_ms, 42.5)
        self.assertEqual(entry.req_bytes, 0)
        self.assertEqual(entry.resp_bytes, 8192)
        self.assertEqual(entry.client_ip, "203.0.113.10")
        self.assertEqual(entry.resp_type, "application/json")

    def test_build_report_groups_routes_and_skips_health_by_default(self):
        parse = self.module.parse_http_access_line
        report = self.module.build_report(
            [
                parse(
                    "HTTP method=GET path=/api/health route=/api/health "
                    "status=200 duration_ms=5.0 req_bytes=0 resp_bytes=1024 "
                    "client_ip=127.0.0.1 resp_type=application/json"
                ),
                parse(
                    "HTTP method=GET path=/api/orders/a1 route=/api/orders/<order_id> "
                    "status=200 duration_ms=25.0 req_bytes=0 resp_bytes=4096 "
                    "client_ip=203.0.113.10 resp_type=application/json"
                ),
                parse(
                    "HTTP method=GET path=/api/orders/a2 route=/api/orders/<order_id> "
                    "status=200 duration_ms=35.0 req_bytes=0 resp_bytes=2048 "
                    "client_ip=203.0.113.10 resp_type=application/json"
                ),
                parse(
                    "HTTP method=POST path=/api/contact route=/api/contact "
                    "status=201 duration_ms=80.0 req_bytes=512 resp_bytes=256 "
                    "client_ip=198.51.100.20 resp_type=application/json"
                ),
                parse(
                    "HTTP method=GET path=/api/auth/me route=/api/auth/me "
                    "status=502 duration_ms=150.0 req_bytes=0 resp_bytes=128 "
                    "client_ip=203.0.113.10 resp_type=application/json"
                ),
            ],
            include_health=False,
        )

        totals = report["totals"]
        routes = report["routes"]
        clients = report["clients"]
        error_routes = report["error_routes"]

        self.assertEqual(totals.count, 4)
        self.assertEqual(totals.req_bytes, 512)
        self.assertEqual(totals.resp_bytes, 6528)
        self.assertEqual(routes[0].label, "GET /api/orders/<order_id>")
        self.assertEqual(routes[0].count, 2)
        self.assertEqual(routes[0].resp_bytes, 6144)
        self.assertEqual(clients[0].label, "203.0.113.10")
        self.assertEqual(clients[0].count, 3)
        self.assertEqual(clients[0].resp_bytes, 6272)
        self.assertEqual(error_routes[0].label, "GET /api/auth/me")
        self.assertEqual(error_routes[0].error_count, 1)

    def test_diagnose_log_window_detects_legacy_http_lines(self):
        hints = self.module.diagnose_log_window(
            [
                "2026-03-27 11:40:00,000 INFO peppro.http :: HTTP GET /api/orders -> 200 (12.0 ms)",
            ]
        )

        self.assertTrue(hints)
        self.assertIn("legacy HTTP log line", hints[0])


if __name__ == "__main__":
    unittest.main()
