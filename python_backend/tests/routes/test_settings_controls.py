import importlib.util
from pathlib import Path
import sys
import types
from datetime import datetime, timezone
import unittest
from unittest.mock import patch

try:
    from flask import Flask, g
except (ModuleNotFoundError, ImportError):  # pragma: no cover - local env fallback
    Flask = None
    g = None


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
        if Flask is None or g is None:
            self.skipTest("flask not installed")
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
            "physicianMapEnabled": False,
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

            with self.app.test_request_context("/api/settings/physician-map", method="GET"):
                response = self._make_response(settings.get_physician_map())
                self.assertEqual(
                    response.get_json(),
                    {"physicianMapEnabled": False, "mysqlEnabled": True},
                )

    def test_physician_map_routes_and_network_feed_respect_toggle(self):
        settings = self.settings

        with patch.object(settings.settings_service, "get_settings", return_value={
            "physicianMapEnabled": False,
        }), \
            patch.object(settings, "_mysql_enabled", return_value=True):
            with self.app.test_request_context("/api/settings/network/doctors", method="GET"):
                g.current_user = {"id": "doctor-1", "role": "doctor"}
                response = self._make_response(settings.get_network_doctors.__wrapped__())
                self.assertEqual(response.status_code, 403)
                self.assertEqual(
                    response.get_json(),
                    {"error": "Physician map is disabled", "code": "FORBIDDEN"},
                )

        with patch.object(settings.settings_service, "get_settings", return_value={
            "physicianMapEnabled": False,
        }), \
            patch.object(settings, "_build_physician_network_entries", return_value=[
                {
                    "id": "doctor-1",
                    "name": "Dr. Example",
                    "profileImageUrl": None,
                    "greaterArea": "Midwest",
                    "studyFocus": "Longevity",
                    "bio": "Bio",
                    "officeCity": "Indianapolis",
                    "officeState": "IN",
                }
            ]):
            with self.app.test_request_context("/api/settings/network/doctors", method="GET"):
                g.current_user = {"id": "doctor-2", "role": "test_doctor"}
                response = self._make_response(settings.get_network_doctors.__wrapped__())
                payload = response.get_json()
                self.assertEqual(response.status_code, 200)
                self.assertEqual(payload["doctors"][0]["id"], "doctor-1")
                self.assertEqual(payload["total"], 1)

        with patch.object(settings.settings_service, "get_settings", return_value={
            "physicianMapEnabled": True,
        }), \
            patch.object(settings.settings_service, "update_settings", return_value={
                "physicianMapEnabled": True,
            }), \
            patch.object(settings, "_build_physician_network_entries", return_value=[
                {
                    "id": "doctor-1",
                    "name": "Dr. Example",
                    "profileImageUrl": None,
                    "greaterArea": "Midwest",
                    "studyFocus": "Longevity",
                    "bio": "Bio",
                    "officeCity": "Indianapolis",
                    "officeState": "IN",
                }
            ]), \
            patch.object(settings, "_mysql_enabled", return_value=True):
            with self.app.test_request_context("/api/settings/network/doctors", method="GET"):
                g.current_user = {"id": "doctor-1", "role": "doctor"}
                response = self._make_response(settings.get_network_doctors.__wrapped__())
                payload = response.get_json()
                self.assertEqual(payload["doctors"][0]["id"], "doctor-1")
                self.assertEqual(payload["total"], 1)
                self.assertTrue(isinstance(payload.get("generatedAt"), str) and payload["generatedAt"])

            with self.app.test_request_context("/api/settings/physician-map", method="GET"):
                response = self._make_response(settings.get_physician_map())
                self.assertEqual(
                    response.get_json(),
                    {"physicianMapEnabled": True, "mysqlEnabled": True},
                )

            with self.app.test_request_context(
                "/api/settings/physician-map",
                method="PUT",
                json={"enabled": True},
            ):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.update_physician_map.__wrapped__())
                self.assertEqual(
                    response.get_json(),
                    {"physicianMapEnabled": True, "mysqlEnabled": True},
                )

    def test_physician_network_entries_require_presence_and_research_agreements(self):
        settings = self.settings

        with patch.object(settings.user_repository, "get_all", return_value=[
            {
                "id": "doctor-visible",
                "role": "doctor",
                "name": "Visible Doctor",
                "email": "visible@example.com",
                "profileOnboarding": True,
                "networkPresenceAgreement": True,
                "researchTermsAgreement": True,
                "bio": "Visible bio",
                "officeState": "IN",
                "lastLoginAt": "2026-04-12T10:00:00Z",
            },
            {
                "id": "doctor-visible-recent",
                "role": "doctor",
                "name": "Visible Recent Doctor",
                "email": "visible-recent@example.com",
                "profileOnboarding": True,
                "networkPresenceAgreement": True,
                "researchTermsAgreement": True,
                "bio": "Visible recent bio",
                "officeState": "CA",
                "lastLoginAt": "2026-04-13T10:00:00Z",
            },
            {
                "id": "doctor-hidden",
                "role": "doctor",
                "name": "Hidden Doctor",
                "email": "hidden@example.com",
                "profileOnboarding": True,
                "networkPresenceAgreement": False,
                "researchTermsAgreement": True,
                "bio": "Hidden bio",
                "officeState": "CA",
            },
            {
                "id": "doctor-no-research-terms",
                "role": "doctor",
                "name": "No Research Terms Doctor",
                "email": "noresearch@example.com",
                "profileOnboarding": True,
                "networkPresenceAgreement": True,
                "researchTermsAgreement": False,
                "bio": "No research terms bio",
                "officeState": "OH",
            },
            {
                "id": "doctor-no-onboarding",
                "role": "doctor",
                "name": "Incomplete Doctor",
                "email": "incomplete@example.com",
                "profileOnboarding": False,
                "networkPresenceAgreement": True,
                "researchTermsAgreement": True,
                "bio": "Incomplete bio",
                "officeState": "FL",
            },
            {
                "id": "doctor-test-role",
                "role": "test_doctor",
                "name": "Test Role Doctor",
                "email": "testrole@example.com",
                "profileOnboarding": True,
                "networkPresenceAgreement": True,
                "researchTermsAgreement": True,
                "bio": "Test role bio",
                "officeState": "TX",
            },
            {
                "id": "doctor-test-email",
                "role": "doctor",
                "name": "Test Email Doctor",
                "email": "test@doctor.com",
                "profileOnboarding": True,
                "networkPresenceAgreement": True,
                "researchTermsAgreement": True,
                "bio": "Test email bio",
                "officeState": "WA",
            },
        ]):
            doctors = settings._build_physician_network_entries()

        self.assertEqual(
            [entry["id"] for entry in doctors],
            ["doctor-visible-recent", "doctor-visible"],
        )
        self.assertEqual(doctors[0]["email"], "visible-recent@example.com")
        self.assertEqual(doctors[0]["lastLoginAt"], "2026-04-13T10:00:00Z")

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

    def test_user_profile_routes_include_modal_contact_fields_and_rep_phone_fallback(self):
        settings = self.settings
        user = {
            "id": "rep-user-7",
            "name": "Sales Rep One",
            "email": "rep.one@example.com",
            "role": "sales_rep",
            "status": "active",
            "profileImageUrl": "data:image/png;base64,QUJD",
            "salesRepId": None,
            "phone": None,
            "officeAddressLine1": "123 Main St",
            "officeAddressLine2": "Suite 400",
            "officeCity": "Indianapolis",
            "officeState": "IN",
            "officePostalCode": "46204",
            "officeCountry": "US",
            "resellerPermitFilePath": "uploads/reseller-permits/permit.pdf",
            "resellerPermitFileName": "permit.pdf",
            "resellerPermitUploadedAt": "2026-04-02T12:00:00Z",
        }
        rep = {
            "id": "rep-7",
            "legacyUserId": "rep-user-7",
            "email": "rep.one@example.com",
            "phone": "317-555-0101",
            "isPartner": True,
            "allowedRetail": False,
            "jurisdiction": "local",
        }

        with patch.object(settings.user_repository, "find_by_id", return_value=user), \
            patch.object(settings.user_repository, "get_all", return_value=[user]), \
            patch.object(settings.sales_rep_repository, "get_all", return_value=[rep]), \
            patch.object(settings.presence_service, "snapshot", return_value={}), \
            patch.object(settings.time, "time", return_value=1_000.0):
            with self.app.test_request_context("/api/settings/users/rep-user-7", method="GET"):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.get_user_profile.__wrapped__("rep-user-7"))
                payload = response.get_json()["user"]

            with self.app.test_request_context("/api/settings/users?ids=rep-user-7", method="GET"):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.get_user_profiles.__wrapped__())
                users_payload = response.get_json()["users"]

            with self.app.test_request_context("/api/settings/users/rep-user-7/profile-image", method="GET"):
                g.current_user = {"id": "admin-1", "role": "admin"}
                image_response = self._make_response(settings.get_user_profile_image.__wrapped__("rep-user-7"))

        self.assertEqual(payload["phone"], "317-555-0101")
        self.assertEqual(payload["salesRepId"], "rep-7")
        self.assertEqual(payload["isPartner"], True)
        self.assertEqual(payload["allowedRetail"], False)
        self.assertEqual(payload["jurisdiction"], "local")
        self.assertTrue(str(payload["profileImageUrl"]).endswith("/api/settings/users/rep-user-7/profile-image"))

        self.assertEqual(len(users_payload), 1)
        self.assertEqual(users_payload[0]["phone"], "317-555-0101")
        self.assertEqual(users_payload[0]["status"], "active")
        self.assertEqual(users_payload[0]["salesRepId"], "rep-7")
        self.assertEqual(users_payload[0]["isPartner"], True)
        self.assertEqual(users_payload[0]["allowedRetail"], False)
        self.assertEqual(users_payload[0]["jurisdiction"], "local")
        self.assertEqual(users_payload[0]["officeAddressLine1"], "123 Main St")
        self.assertEqual(users_payload[0]["officeAddressLine2"], "Suite 400")
        self.assertEqual(users_payload[0]["officeCity"], "Indianapolis")
        self.assertEqual(users_payload[0]["officeState"], "IN")
        self.assertEqual(users_payload[0]["officePostalCode"], "46204")
        self.assertEqual(users_payload[0]["officeCountry"], "US")
        self.assertEqual(users_payload[0]["resellerPermitFilePath"], "uploads/reseller-permits/permit.pdf")
        self.assertEqual(users_payload[0]["resellerPermitFileName"], "permit.pdf")
        self.assertEqual(users_payload[0]["resellerPermitUploadedAt"], "2026-04-02T12:00:00Z")
        self.assertTrue(str(users_payload[0]["profileImageUrl"]).endswith("/api/settings/users/rep-user-7/profile-image"))
        self.assertEqual(image_response.status_code, 200)
        self.assertEqual(image_response.mimetype, "image/png")
        self.assertEqual(image_response.get_data(), b"ABC")

    def test_beta_service_normalization_keeps_supported_keys_only(self):
        from python_backend.services import settings_service

        normalized = settings_service.normalize_settings({
            "betaServices": ["shop", "crm", "invalid", "shop", None, "research", "physicianMap"],
        })

        self.assertEqual(normalized["betaServices"], ["shop", "crm", "research", "physicianMap"])
        self.assertIn("betaServices", settings_service.DEFAULT_SETTINGS)

    def test_admin_database_visualizer_route_returns_table_and_column_metadata(self):
        settings = self.settings

        def fake_fetch_all(query, params=None):
            if "FROM information_schema.TABLES" in query:
                return [
                    {
                        "table_name": "users",
                        "engine": "InnoDB",
                        "data_bytes": 4096,
                        "index_bytes": 2048,
                        "updated_at": datetime(2026, 3, 24, 12, 0, tzinfo=timezone.utc),
                        "column_count": 3,
                    }
                ]
            if "FROM information_schema.COLUMNS" in query:
                return [
                    {
                        "column_name": "id",
                        "column_type": "varchar(32)",
                        "is_nullable": "NO",
                        "column_key": "PRI",
                        "column_default": None,
                        "extra": "",
                        "ordinal_position": 1,
                    },
                    {
                        "column_name": "email",
                        "column_type": "varchar(190)",
                        "is_nullable": "NO",
                        "column_key": "UNI",
                        "column_default": None,
                        "extra": "",
                        "ordinal_position": 2,
                    },
                ]
            if "FROM information_schema.STATISTICS" in query:
                return [
                    {
                        "index_name": "PRIMARY",
                        "non_unique": 0,
                        "column_name": "id",
                        "seq_in_index": 1,
                    },
                    {
                        "index_name": "email",
                        "non_unique": 0,
                        "column_name": "email",
                        "seq_in_index": 1,
                    },
                ]
            if "FROM information_schema.KEY_COLUMN_USAGE" in query and "kcu.TABLE_NAME = %(table_name)s" in query:
                return [
                    {
                        "constraint_name": "fk_users_sales_rep",
                        "column_name": "salesRepId",
                        "referenced_table_name": "sales_reps",
                        "referenced_column_name": "id",
                        "update_rule": "CASCADE",
                        "delete_rule": "SET NULL",
                    }
                ]
            if "FROM information_schema.KEY_COLUMN_USAGE" in query and "kcu.REFERENCED_TABLE_NAME = %(table_name)s" in query:
                return [
                    {
                        "constraint_name": "fk_orders_user",
                        "source_table_name": "orders",
                        "source_column_name": "user_id",
                        "referenced_column_name": "id",
                        "update_rule": "CASCADE",
                        "delete_rule": "RESTRICT",
                    }
                ]
            if "SELECT *" in query and "FROM `users`" in query:
                return [
                    {
                        "id": "user-1",
                        "email": '{"version":1,"wrapped_data_key":{"iv":"iv","ciphertext":"wrapped"},"iv":"cipher-iv","ciphertext":"ciphertext","aad":{"table":"users","field":"email"}}',
                    }
                ]
            self.fail(f"Unexpected fetch_all query: {query}")

        def fake_fetch_one(query, params=None):
            if "SELECT COUNT(*) AS row_count FROM `users`" in query:
                return {"row_count": 29}
            if "SHOW CREATE TABLE `users`" in query:
                return {
                    "Table": "users",
                    "Create Table": "CREATE TABLE `users` (`id` varchar(255) NOT NULL, PRIMARY KEY (`id`))",
                }
            self.fail(f"Unexpected fetch_one query: {query}")

        fake_config = types.SimpleNamespace(mysql={"enabled": True, "database": "PepPro", "host": "127.0.0.1"})

        with patch.object(settings, "get_config", return_value=fake_config), \
            patch.object(settings.mysql_client, "fetch_all", side_effect=fake_fetch_all), \
            patch.object(settings.mysql_client, "fetch_one", side_effect=fake_fetch_one), \
            patch.object(
                settings,
                "decrypt_text",
                side_effect=lambda value, aad=None: "doctor@example.com" if isinstance(value, str) and '"wrapped_data_key"' in value else value,
            ):
            with self.app.test_request_context("/api/settings/database-visualizer?table=users", method="GET"):
                g.current_user = {"id": "admin-1", "role": "admin"}
                response = self._make_response(settings.get_database_visualizer.__wrapped__())
                payload = response.get_json()

        self.assertTrue(payload["mysqlEnabled"])
        self.assertEqual(payload["databaseName"], "PepPro")
        self.assertEqual(payload["hostScope"], "local")
        self.assertEqual(payload["tables"][0]["name"], "users")
        self.assertEqual(payload["tables"][0]["rowCount"], 29)
        self.assertEqual(payload["selectedTable"]["name"], "users")
        self.assertEqual(payload["selectedTable"]["columns"][0]["name"], "id")
        self.assertEqual(payload["selectedTable"]["indexes"][0]["name"], "PRIMARY")
        self.assertEqual(payload["selectedTable"]["relationships"]["imports"][0]["referencedTable"], "sales_reps")
        self.assertEqual(payload["selectedTable"]["relationships"]["exports"][0]["sourceTable"], "orders")
        self.assertIn("CREATE TABLE `users`", payload["selectedTable"]["createStatement"])
        self.assertEqual(payload["selectedTable"]["preview"]["rows"][0]["values"]["email"]["value"], "doctor@example.com")
        self.assertTrue(payload["selectedTable"]["preview"]["rows"][0]["values"]["email"]["decrypted"])


if __name__ == "__main__":
    unittest.main()
