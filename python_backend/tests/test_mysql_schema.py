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
    def test_physician_recommendations_table_stores_json_snapshot(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS physician_product_recommendations", schema_sql)
        self.assertIn("recommendations_json LONGTEXT NOT NULL", schema_sql)
        self.assertIn("UNIQUE KEY uniq_physician_recs_user_model (user_id, model_version)", schema_sql)
        self.assertNotIn("rank_position INT UNSIGNED", schema_sql)

    def test_users_table_stores_delegate_background_in_requested_columns(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("delegate_background_url LONGTEXT NULL", schema_sql)
        self.assertIn("delegate_background_color VARCHAR(16) NULL", schema_sql)
        self.assertNotIn("delegate_background_image_url LONGTEXT NULL", schema_sql)

    def test_email_verification_schema_exists(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("email_verified_at DATETIME NULL", schema_sql)
        self.assertIn("email_verification_sent_at DATETIME NULL", schema_sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS email_verification_tokens", schema_sql)
        self.assertIn("token_sha256 CHAR(64) PRIMARY KEY", schema_sql)
        self.assertIn("user_id VARCHAR(64) NOT NULL", schema_sql)
        self.assertIn("KEY idx_email_verification_tokens_expires (expires_at)", schema_sql)

    def test_product_brochure_info_schema_exists(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS product_brochure_info", schema_sql)
        self.assertIn("product_name VARCHAR(255) NOT NULL", schema_sql)
        self.assertIn("product_sku VARCHAR(128) NOT NULL", schema_sql)
        self.assertIn("product_description LONGTEXT NULL", schema_sql)
        self.assertIn("product_information LONGTEXT NULL", schema_sql)
        self.assertIn("UNIQUE KEY uq_product_brochure_info_sku (product_sku)", schema_sql)

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
