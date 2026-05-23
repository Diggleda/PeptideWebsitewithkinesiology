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

from python_backend.repositories import legal_acceptance_repository


class LegalAcceptanceRepositoryTests(unittest.TestCase):
    def test_record_acceptances_updates_one_json_row_per_user(self) -> None:
        config = types.SimpleNamespace(mysql={"enabled": True})
        existing_history = {
            "schemaVersion": 1,
            "events": [
                {
                    "acceptedAt": "2026-05-01 12:00:00",
                    "acceptanceContext": "research_terms_agreement",
                    "documents": [{"documentKey": "terms", "documentVersion": "2026.05.01"}],
                }
            ],
        }

        with patch.object(legal_acceptance_repository, "get_config", return_value=config), \
            patch.object(
                legal_acceptance_repository.mysql_client,
                "fetch_one",
                return_value={"acceptances_json": json.dumps(existing_history)},
            ) as fetch_one, \
            patch.object(legal_acceptance_repository.mysql_client, "execute", return_value=1) as execute:
            count = legal_acceptance_repository.record_acceptances(
                user_id="doctor-1",
                documents=[
                    {"document_key": "terms", "document_version": "2026.05.23"},
                    {"document_key": "shipping", "document_version": "2026.05.23"},
                    {"document_key": "privacy", "document_version": "2026.05.23"},
                ],
                accepted_at="2026-05-23T19:30:00Z",
                acceptance_context="research_terms_agreement",
                ip_hash="a" * 64,
                user_agent_hash="b" * 64,
            )

        self.assertEqual(count, 3)
        fetch_one.assert_called_once()
        execute.assert_called_once()
        sql, params = execute.call_args.args
        self.assertIn("ON DUPLICATE KEY UPDATE", sql)
        self.assertEqual(params["user_id"], "doctor-1")
        self.assertEqual(params["latest_terms_version"], "2026.05.23")
        self.assertEqual(params["latest_shipping_policy_version"], "2026.05.23")
        self.assertEqual(params["latest_privacy_policy_version"], "2026.05.23")
        self.assertEqual(params["latest_accepted_at"], "2026-05-23 19:30:00")

        stored_history = json.loads(params["acceptances_json"])
        self.assertEqual(stored_history["schemaVersion"], 1)
        self.assertEqual(len(stored_history["events"]), 2)
        latest_event = stored_history["events"][-1]
        self.assertEqual(latest_event["acceptedAt"], "2026-05-23 19:30:00")
        self.assertEqual(latest_event["acceptanceContext"], "research_terms_agreement")
        self.assertEqual(
            latest_event["documents"],
            [
                {"documentKey": "terms", "documentVersion": "2026.05.23"},
                {"documentKey": "shipping", "documentVersion": "2026.05.23"},
                {"documentKey": "privacy", "documentVersion": "2026.05.23"},
            ],
        )


if __name__ == "__main__":
    unittest.main()
