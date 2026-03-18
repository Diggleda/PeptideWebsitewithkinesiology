import json
import sys
import types
import unittest
from unittest.mock import patch

if "pymysql" not in sys.modules:
    pymysql_stub = types.ModuleType("pymysql")
    pymysql_stub.connect = lambda *args, **kwargs: None
    pymysql_stub.connections = types.SimpleNamespace(Connection=object)
    pymysql_stub.err = types.SimpleNamespace(Error=Exception, OperationalError=Exception, InterfaceError=Exception)
    cursors_stub = types.ModuleType("pymysql.cursors")
    cursors_stub.DictCursor = object
    pymysql_stub.cursors = cursors_stub
    sys.modules["pymysql"] = pymysql_stub
    sys.modules["pymysql.cursors"] = cursors_stub

if "requests" not in sys.modules:
    requests_stub = types.ModuleType("requests")
    requests_stub.RequestException = Exception
    requests_stub.HTTPError = Exception
    requests_stub.Session = object
    sys.modules["requests"] = requests_stub

from python_backend.scripts import backfill_shipdates


class TestBackfillShipdates(unittest.TestCase):
    def test_patch_payload_overwrites_stale_ship_date_fields(self):
        payload_raw = json.dumps(
            {
                "shippedAt": "2026-02-20",
                "shipped_at": "2026-02-20",
                "integrations": {"shipStation": {"shipDate": "2026-02-20"}},
                "order": {
                    "shippedAt": "2026-02-20",
                    "shipped_at": "2026-02-20",
                    "shippingEstimate": {"shipDate": "2026-02-20"},
                },
            }
        )

        patched = backfill_shipdates._patch_payload(
            payload_raw,
            {"shipDate": "2026-03-05", "trackingNumber": "1ZTEST", "carrierCode": "ups", "status": "shipped"},
        )
        payload = json.loads(patched)

        self.assertEqual(payload["shippedAt"], "2026-03-05")
        self.assertEqual(payload["shipped_at"], "2026-03-05")
        self.assertEqual(payload["integrations"]["shipStation"]["shipDate"], "2026-03-05")
        self.assertEqual(payload["order"]["shippedAt"], "2026-03-05")
        self.assertEqual(payload["order"]["shipped_at"], "2026-03-05")
        self.assertEqual(payload["order"]["shippingEstimate"]["shipDate"], "2026-03-05")

    @patch("python_backend.scripts.backfill_shipdates.mysql_client.execute")
    def test_apply_update_overwrites_existing_shipped_at(self, mock_execute):
        changed = backfill_shipdates._apply_update(
            "orders",
            "1469",
            {"shipDate": "2026-03-05", "trackingNumber": "1ZTEST"},
            json.dumps({"order": {"shippedAt": "2026-02-20"}}),
            require_tracking=False,
        )

        self.assertTrue(changed)
        sql, params = mock_execute.call_args[0]
        self.assertIn("SET shipped_at = %(shipped_at)s", sql)
        self.assertEqual(params["shipped_at"], "2026-03-05 00:00:00")


if __name__ == "__main__":
    unittest.main()
