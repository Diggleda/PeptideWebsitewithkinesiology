from __future__ import annotations

import json
import inspect
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
        self.assertIn("receive_patient_link_update_emails TINYINT(1) NOT NULL DEFAULT 1", schema_sql)
        self.assertIn("website_url VARCHAR(500) NULL", schema_sql)
        self.assertIn("research_terms_agreement_version VARCHAR(64) NULL", schema_sql)
        self.assertIn("research_shipping_policy_version VARCHAR(64) NULL", schema_sql)
        self.assertIn("research_privacy_policy_version VARCHAR(64) NULL", schema_sql)
        self.assertIn("research_terms_agreement_accepted_at DATETIME NULL", schema_sql)
        self.assertNotIn("delegate_background_image_url LONGTEXT NULL", schema_sql)

    def test_email_verification_schema_exists(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("email_verified_at DATETIME NULL", schema_sql)
        self.assertIn("email_verification_sent_at DATETIME NULL", schema_sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS email_verification_tokens", schema_sql)
        self.assertIn("token_sha256 CHAR(64) PRIMARY KEY", schema_sql)
        self.assertIn("user_id VARCHAR(64) NOT NULL", schema_sql)
        self.assertIn("KEY idx_email_verification_tokens_expires (expires_at)", schema_sql)

    def test_email_campaign_schema_exists(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS email_campaigns", schema_sql)
        self.assertIn("campaign_type VARCHAR(64) NOT NULL", schema_sql)
        self.assertIn("template_id VARCHAR(128) NOT NULL", schema_sql)
        self.assertIn("status VARCHAR(32) NOT NULL DEFAULT 'draft'", schema_sql)
        self.assertIn("variables_json JSON NULL", schema_sql)
        self.assertIn("scheduled_at DATETIME NULL", schema_sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS email_campaign_recipients", schema_sql)
        self.assertIn("recipient_email VARCHAR(190) NOT NULL", schema_sql)
        self.assertIn("error_message LONGTEXT NULL", schema_sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS email_events", schema_sql)
        self.assertIn("event_type VARCHAR(64) NOT NULL", schema_sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS email_unsubscribes", schema_sql)
        self.assertIn("recipient_email VARCHAR(190) PRIMARY KEY", schema_sql)

        schema_migrations = inspect.getsource(mysql_schema.ensure_schema)
        self.assertIn("ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS scheduled_at DATETIME NULL", schema_migrations)

    def test_product_brochure_info_schema_exists(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS product_brochure_info", schema_sql)
        self.assertIn("product_id BIGINT UNSIGNED NULL", schema_sql)
        self.assertIn("parent_product_id BIGINT UNSIGNED NULL", schema_sql)
        self.assertIn("variation_id BIGINT UNSIGNED NULL", schema_sql)
        self.assertIn("parent_sku VARCHAR(128) NULL", schema_sql)
        self.assertIn("product_name VARCHAR(255) NOT NULL", schema_sql)
        self.assertIn("product_sku VARCHAR(128) NOT NULL", schema_sql)
        self.assertIn("product_description LONGTEXT NULL", schema_sql)
        self.assertIn("product_information LONGTEXT NULL", schema_sql)
        self.assertIn("UNIQUE KEY uq_product_brochure_info_sku (product_sku)", schema_sql)
        self.assertIn("INDEX idx_product_brochure_info_product_id (product_id)", schema_sql)
        self.assertIn("INDEX idx_product_brochure_info_variation_id (variation_id)", schema_sql)

    def test_patient_links_schema_supports_link_types_and_public_view_analytics(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS patient_links", schema_sql)
        self.assertIn("link_type VARCHAR(32) NOT NULL DEFAULT 'delegate'", schema_sql)
        self.assertIn("created_by_user_id VARCHAR(32) NULL", schema_sql)
        self.assertIn("brochure_name LONGTEXT NULL", schema_sql)
        self.assertIn("view_count INT NOT NULL DEFAULT 0", schema_sql)
        self.assertIn("first_viewed_at DATETIME NULL", schema_sql)
        self.assertIn("last_viewed_at DATETIME NULL", schema_sql)
        self.assertIn("last_user_agent_hash CHAR(64) NULL", schema_sql)
        self.assertIn("last_ip_hash CHAR(64) NULL", schema_sql)
        self.assertIn("KEY idx_patient_links_type (link_type)", schema_sql)

    def test_resource_versions_schema_exists(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS resource_versions", schema_sql)
        self.assertIn("resource_name VARCHAR(64) NOT NULL PRIMARY KEY", schema_sql)
        self.assertIn("version BIGINT UNSIGNED NOT NULL DEFAULT 0", schema_sql)
        self.assertIn("metadata_json JSON NULL", schema_sql)
        self.assertIn("KEY idx_resource_versions_updated (updated_at)", schema_sql)

    def test_contact_forms_schema_stores_npi_verification_fields(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS contact_forms", schema_sql)
        self.assertIn("website_url VARCHAR(500) NULL", schema_sql)
        self.assertIn("npi_number VARCHAR(20) NULL", schema_sql)
        self.assertIn("npi_provider_name VARCHAR(255) NULL", schema_sql)
        self.assertIn("npi_verification_status VARCHAR(32) NULL", schema_sql)

    def test_legal_acceptances_schema_exists(self) -> None:
        schema_sql = "\n".join(mysql_schema.CREATE_TABLE_STATEMENTS)

        self.assertIn("CREATE TABLE IF NOT EXISTS legal_acceptances", schema_sql)
        self.assertIn("user_id VARCHAR(64) NOT NULL", schema_sql)
        self.assertIn("acceptances_json JSON NOT NULL", schema_sql)
        self.assertIn("latest_terms_version VARCHAR(64) NULL", schema_sql)
        self.assertIn("latest_shipping_policy_version VARCHAR(64) NULL", schema_sql)
        self.assertIn("latest_privacy_policy_version VARCHAR(64) NULL", schema_sql)
        self.assertIn("latest_accepted_at DATETIME NULL", schema_sql)
        self.assertIn("UNIQUE KEY uniq_legal_acceptances_user (user_id)", schema_sql)
        self.assertIn("KEY idx_legal_acceptances_latest_accepted (latest_accepted_at)", schema_sql)
        self.assertNotIn("document_key VARCHAR(64) NOT NULL", schema_sql)

    def test_ensure_schema_drops_legacy_legal_acceptance_events_table(self) -> None:
        execute_calls = []

        def fake_fetch_one(query, params=None):
            if params and params.get("table") == "legal_acceptance_events_legacy":
                return {"cnt": 1}
            return {"cnt": 1}

        def fake_execute(query, params=None):
            execute_calls.append(" ".join(str(query).split()))
            return 1

        with patch.object(mysql_schema, "CREATE_TABLE_STATEMENTS", []), \
            patch("python_backend.database.mysql_schema.mysql_client.fetch_one", side_effect=fake_fetch_one), \
            patch("python_backend.database.mysql_schema.mysql_client.execute", side_effect=fake_execute):
            mysql_schema.ensure_schema()

        self.assertIn("DROP TABLE legal_acceptance_events_legacy", execute_calls)

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
