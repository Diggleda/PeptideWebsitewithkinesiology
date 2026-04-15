import unittest
from types import SimpleNamespace
from unittest.mock import patch


class TestSettingsService(unittest.TestCase):
    def test_load_from_sql_does_not_backfill_missing_defaults_on_read(self):
        try:
            from python_backend.services import settings_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(svc, "get_config", return_value=SimpleNamespace(mysql={"enabled": True})), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client:
            mock_mysql_client.fetch_all.return_value = [
                {"key": "shopEnabled", "value_json": "false"},
            ]

            result = svc._load_from_sql()

        self.assertIsNotNone(result)
        self.assertEqual(result["shopEnabled"], False)
        self.assertEqual(result["researchDashboardEnabled"], False)
        mock_mysql_client.execute.assert_not_called()

    def test_get_settings_reuses_short_lived_cache(self):
        try:
            from python_backend.services import settings_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        initial_cache = {"value": None, "expiresAt": 0.0}

        with patch.object(svc, "_SETTINGS_CACHE", initial_cache), patch.object(
            svc, "_SETTINGS_CACHE_TTL_SECONDS", 5.0
        ), patch.object(
            svc, "_read_settings_uncached", return_value={"shopEnabled": False, "crmEnabled": True}
        ) as read_settings, patch.object(
            svc.time, "monotonic", side_effect=[100.0, 100.0, 100.0, 101.0]
        ):
            first = svc.get_settings()
            first["shopEnabled"] = True
            second = svc.get_settings()

        self.assertEqual(read_settings.call_count, 1)
        self.assertEqual(second["shopEnabled"], False)
        self.assertEqual(second["crmEnabled"], True)


if __name__ == "__main__":
    unittest.main()
