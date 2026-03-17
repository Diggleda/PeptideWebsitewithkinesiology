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
            return_value=[{"COLUMN_NAME": "event"}, {"COLUMN_NAME": "details"}],
        ), patch("python_backend.repositories.usage_tracking_repository.mysql_client.execute") as mock_execute:
            tracked = usage_tracking_repository.insert_event("delegate_link_created", {"who": {"id": "u1"}}, strict=True)

        self.assertTrue(tracked)
        sql = mock_execute.call_args[0][0]
        self.assertIn("INSERT INTO usage_tracking (event, details)", sql)

    def test_insert_event_raises_for_incompatible_schema_in_strict_mode(self):
        with patch("python_backend.repositories.usage_tracking_repository._using_mysql", return_value=True), patch(
            "python_backend.repositories.usage_tracking_repository.mysql_client.fetch_all",
            return_value=[{"COLUMN_NAME": "event"}],
        ):
            with self.assertRaises(RuntimeError) as ctx:
                usage_tracking_repository.insert_event("delegate_link_created", {"who": {"id": "u1"}}, strict=True)

        self.assertIn("usage_tracking table is missing the required columns", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
