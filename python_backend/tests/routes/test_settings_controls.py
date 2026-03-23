import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

from flask import Flask, g


class TestSettingsControls(unittest.TestCase):
    @staticmethod
    def _load_settings_module():
        try:
            import python_backend  # noqa: F401
        except ModuleNotFoundError as exc:
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc

        routes_dir = Path(__file__).resolve().parents[2] / "routes"
        package_name = "python_backend.routes"
        module_name = "python_backend.routes.settings"

        package = sys.modules.get(package_name)
        if package is None:
            package = types.ModuleType(package_name)
            package.__path__ = [str(routes_dir)]  # type: ignore[attr-defined]
            sys.modules[package_name] = package

        existing = sys.modules.get(module_name)
        if existing is not None:
            return existing

        spec = importlib.util.spec_from_file_location(module_name, routes_dir / "settings.py")
        if spec is None or spec.loader is None:
            raise unittest.SkipTest("unable to load settings route module")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module

    def setUp(self):
        self.app = Flask(__name__)
        self.settings = self._load_settings_module()

    def _make_response(self, result):
        return self.app.make_response(result)

    def test_public_settings_routes_include_mysql_enabled(self):
        settings = self.settings

        with patch.object(settings.settings_service, "get_settings", return_value={
            "shopEnabled": False,
            "patientLinksEnabled": True,
            "crmEnabled": False,
            "peptideForumEnabled": True,
            "researchDashboardEnabled": True,
        }), \
            patch.object(settings, "_get_delegate_links_doctors", return_value=[
                {"userId": "doctor-1", "delegateLinksEnabled": True},
                {"userId": "doctor-2", "delegateLinksEnabled": False},
            ]), \
            patch.object(settings, "_migrate_legacy_delegate_links_to_users"), \
            patch.object(settings, "_mysql_enabled", return_value=True):
            with self.app.test_request_context("/api/settings/shop", method="GET"):
                response = self._make_response(settings.get_shop())
                self.assertEqual(response.get_json(), {"shopEnabled": False, "mysqlEnabled": True})

            with self.app.test_request_context("/api/settings/patient-links", method="GET"):
                response = self._make_response(settings.get_patient_links())
                self.assertEqual(
                    response.get_json(),
                    {
                        "patientLinksEnabled": True,
                        "patientLinksDoctorUserIds": ["doctor-1"],
                        "mysqlEnabled": True,
                    },
                )

            with self.app.test_request_context("/api/settings/crm", method="GET"):
                response = self._make_response(settings.get_crm())
                self.assertEqual(response.get_json(), {"crmEnabled": False, "mysqlEnabled": True})

            with self.app.test_request_context("/api/settings/forum", method="GET"):
                response = self._make_response(settings.get_forum())
                self.assertEqual(
                    response.get_json(),
                    {"peptideForumEnabled": True, "mysqlEnabled": True},
                )

            with self.app.test_request_context("/api/settings/research", method="GET"):
                response = self._make_response(settings.get_research())
                self.assertEqual(
                    response.get_json(),
                    {"researchDashboardEnabled": True, "mysqlEnabled": True},
                )

    def test_admin_beta_and_test_payment_routes_include_mysql_enabled(self):
        settings = self.settings

        with patch.object(settings.settings_service, "get_settings", return_value={
            "betaServices": ["shop", "crm"],
            "testPaymentsOverrideEnabled": True,
        }), \
            patch.object(settings.settings_service, "update_settings", side_effect=[
                {"betaServices": ["shop", "research"]},
                {"testPaymentsOverrideEnabled": False},
            ]), \
            patch.object(settings, "_mysql_enabled", return_value=True):
            with self.app.test_request_context("/api/settings/beta-services", method="GET"):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.get_beta_services.__wrapped__())
                self.assertEqual(
                    response.get_json(),
                    {"betaServices": ["shop", "crm"], "mysqlEnabled": True},
                )

            with self.app.test_request_context("/api/settings/beta-services", method="GET"):
                g.current_user = {"id": "doctor-1", "role": "doctor"}
                response = self._make_response(settings.get_beta_services.__wrapped__())
                self.assertEqual(
                    response.get_json(),
                    {"betaServices": ["shop", "crm"], "mysqlEnabled": True},
                )

            with self.app.test_request_context(
                "/api/settings/beta-services",
                method="PUT",
                json={"betaServices": ["shop", "research", "invalid"]},
            ):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.update_beta_services.__wrapped__())
                self.assertEqual(
                    response.get_json(),
                    {"betaServices": ["shop", "research"], "mysqlEnabled": True},
                )

            with self.app.test_request_context("/api/settings/test-payments-override", method="GET"):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.get_test_payments_override.__wrapped__())
                self.assertEqual(
                    response.get_json(),
                    {"testPaymentsOverrideEnabled": True, "mysqlEnabled": True},
                )

            with self.app.test_request_context(
                "/api/settings/test-payments-override",
                method="PUT",
                json={"enabled": False},
            ):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.update_test_payments_override.__wrapped__())
                self.assertEqual(
                    response.get_json(),
                    {"testPaymentsOverrideEnabled": False, "mysqlEnabled": True},
                )

    def test_beta_service_normalization_keeps_supported_keys_only(self):
        from python_backend.services import settings_service

        normalized = settings_service.normalize_settings({
            "betaServices": ["shop", "crm", "invalid", "shop", None, "research"],
        })

        self.assertEqual(normalized["betaServices"], ["shop", "crm", "research"])
        self.assertIn("betaServices", settings_service.DEFAULT_SETTINGS)


if __name__ == "__main__":
    unittest.main()
