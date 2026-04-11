from __future__ import annotations

import json
import sys
import types
import unittest
from unittest.mock import patch

fake_pymysql = types.ModuleType("pymysql")
fake_pymysql.connect = lambda *args, **kwargs: None
fake_pymysql.connections = types.SimpleNamespace(Connection=object)
fake_pymysql.err = types.SimpleNamespace(OperationalError=Exception, InterfaceError=Exception)
fake_pymysql_cursors = types.ModuleType("pymysql.cursors")
fake_pymysql_cursors.DictCursor = object
fake_pymysql.cursors = fake_pymysql_cursors
sys.modules.setdefault("pymysql", fake_pymysql)
sys.modules.setdefault("pymysql.cursors", fake_pymysql_cursors)

from python_backend.database import mysql_schema


class MysqlSchemaTests(unittest.TestCase):
    def test_network_presence_backfill_runs_once_and_records_marker(self) -> None:
        execute_calls = []

        def fake_execute(query, params=None):
            execute_calls.append((query, params))
            if "UPDATE users" in query:
                return 17
            return 1

        with patch("python_backend.database.mysql_schema.mysql_client.fetch_one", return_value=None), \
            patch("python_backend.database.mysql_schema.mysql_client.execute", side_effect=fake_execute):
            mysql_schema._backfill_network_presence_agreement_once(table_exists=lambda _table: True)

        self.assertEqual(len(execute_calls), 2)
        self.assertIn("UPDATE users", execute_calls[0][0])
        self.assertIn("INSERT INTO settings", execute_calls[1][0])
        self.assertEqual(
            execute_calls[1][1]["key"],
            "migration_network_presence_agreement_backfill_v1",
        )
        marker_payload = json.loads(execute_calls[1][1]["value_json"])
        self.assertEqual(marker_payload["affectedRows"], 17)
        self.assertTrue(marker_payload["ranAt"])

    def test_network_presence_backfill_skips_when_marker_exists(self) -> None:
        with patch(
            "python_backend.database.mysql_schema.mysql_client.fetch_one",
            return_value={"value_json": '{"affectedRows": 17}'},
        ), \
            patch("python_backend.database.mysql_schema.mysql_client.execute") as execute:
            mysql_schema._backfill_network_presence_agreement_once(table_exists=lambda _table: True)

        execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
