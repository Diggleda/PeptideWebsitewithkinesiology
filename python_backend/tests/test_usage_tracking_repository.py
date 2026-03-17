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

from python_backend.repositories import usage_tracking_repository


class UsageTrackingRepositoryTests(unittest.TestCase):
    def setUp(self) -> None:
        usage_tracking_repository._USAGE_TRACKING_COLUMNS_CACHE = None

    def test_insert_event_uses_legacy_details_column_when_present(self):
        with patch("python_backend.repositories.usage_tracking_repository._using_mysql", return_value=True), patch(
            "python_backend.repositories.usage_tracking_repository.mysql_client.fetch_all",
            side_effect=[
                [{"COLUMN_NAME": "event"}, {"COLUMN_NAME": "details"}],
                [],
            ],
        ), patch("python_backend.repositories.usage_tracking_repository.mysql_client.execute") as mock_execute:
            tracked = usage_tracking_repository.insert_event("delegate_link_created", {"who": {"id": "u1"}}, strict=True)

        self.assertTrue(tracked)
        sql = mock_execute.call_args[0][0]
        self.assertIn("INSERT INTO usage_tracking (event, `details`)", sql)

    def test_insert_event_raises_for_incompatible_schema_in_strict_mode(self):
        with patch("python_backend.repositories.usage_tracking_repository._using_mysql", return_value=True), patch(
            "python_backend.repositories.usage_tracking_repository.mysql_client.fetch_all",
            return_value=[{"COLUMN_NAME": "event"}],
        ):
            with self.assertRaises(RuntimeError) as ctx:
                usage_tracking_repository.insert_event("delegate_link_created", {"who": {"id": "u1"}}, strict=True)

        self.assertIn("usage_tracking table is missing the required columns", str(ctx.exception))

    def test_insert_event_uses_plain_text_json_payload(self):
        with patch("python_backend.repositories.usage_tracking_repository._using_mysql", return_value=True), patch(
            "python_backend.repositories.usage_tracking_repository.mysql_client.fetch_all",
            side_effect=[
                [{"COLUMN_NAME": "id"}, {"COLUMN_NAME": "event"}, {"COLUMN_NAME": "details_json"}],
                [],
            ],
        ), patch("python_backend.repositories.usage_tracking_repository.mysql_client.execute") as mock_execute:
            tracked = usage_tracking_repository.insert_event("delegate_link_created", {"who": {"id": "u1"}}, strict=True)

        self.assertTrue(tracked)
        sql = mock_execute.call_args[0][0]
        self.assertIn("VALUES (%(event)s, %(details_json)s)", sql)
        self.assertNotIn("CAST(%(details_json)s AS JSON)", sql)

    def test_insert_event_merges_instances_into_existing_event_row(self):
        existing_payload = {
            "count": 1,
            "instances": [
                {
                    "who": {"id": "u1"},
                    "when": "2026-03-17T02:00:00+00:00",
                    "tab": "delegate_links",
                }
            ],
        }
        execute_calls = []

        def fake_execute(sql, params):
            execute_calls.append((sql, params))
            return 1

        with patch("python_backend.repositories.usage_tracking_repository._using_mysql", return_value=True), patch(
            "python_backend.repositories.usage_tracking_repository.mysql_client.fetch_all",
            side_effect=[
                [{"COLUMN_NAME": "id"}, {"COLUMN_NAME": "event"}, {"COLUMN_NAME": "details_json"}],
                [{"id": 1, "payload_value": json.dumps(existing_payload)}],
            ],
        ), patch("python_backend.repositories.usage_tracking_repository.mysql_client.execute", side_effect=fake_execute):
            tracked = usage_tracking_repository.insert_event(
                "delegate_link_tab_clicked",
                {
                    "who": {"id": "u2"},
                    "when": "2026-03-17T03:00:00+00:00",
                    "tab": "delegate_links",
                },
                strict=True,
            )

        self.assertTrue(tracked)
        self.assertEqual(len(execute_calls), 1)
        sql, params = execute_calls[0]
        self.assertIn("UPDATE usage_tracking", sql)
        payload = json.loads(params["details_json"])
        self.assertEqual(payload["count"], 2)
        self.assertEqual(len(payload["instances"]), 2)
        self.assertEqual(payload["instances"][0]["who"]["id"], "u1")
        self.assertEqual(payload["instances"][1]["who"]["id"], "u2")
        self.assertNotIn("who", payload)
        self.assertNotIn("when", payload)
        self.assertNotIn("tab", payload)


if __name__ == "__main__":
    unittest.main()
