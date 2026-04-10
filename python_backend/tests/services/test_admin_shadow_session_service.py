from __future__ import annotations

import importlib
from types import SimpleNamespace
import sys
import types
import unittest
from unittest.mock import patch


def _module(name: str, **attrs):
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    return mod


import python_backend  # noqa: F401

services_pkg = importlib.import_module("python_backend.services")
repositories_pkg = importlib.import_module("python_backend.repositories")

fake_flask = _module(
    "flask",
    Response=object,
    jsonify=lambda value=None, *args, **kwargs: value,
    request=types.SimpleNamespace(headers={}, args={}, json=None, method="GET", path="/test"),
)
fake_werkzeug_exceptions = _module("werkzeug.exceptions", HTTPException=Exception)
fake_werkzeug = _module("werkzeug", exceptions=fake_werkzeug_exceptions)
sys.modules["flask"] = fake_flask
sys.modules["werkzeug"] = fake_werkzeug
sys.modules["werkzeug.exceptions"] = fake_werkzeug_exceptions

fake_mysql_client = _module(
    "python_backend.database.mysql_client",
    is_enabled=lambda: False,
    execute=lambda *args, **kwargs: 0,
    fetch_one=lambda *args, **kwargs: None,
)
fake_database_pkg = _module("python_backend.database", mysql_client=fake_mysql_client)
fake_database_pkg.__path__ = []  # type: ignore[attr-defined]
sys.modules["python_backend.database"] = fake_database_pkg
sys.modules["python_backend.database.mysql_client"] = fake_mysql_client

fake_auth_service = _module(
    "python_backend.services.auth_service",
    _create_auth_token=lambda *args, **kwargs: "shadow-jwt",
    get_profile=lambda *args, **kwargs: {},
)
fake_user_repository = _module(
    "python_backend.repositories.user_repository",
    find_by_id=lambda _user_id: None,
)
sys.modules["python_backend.services.auth_service"] = fake_auth_service
sys.modules["python_backend.repositories.user_repository"] = fake_user_repository
services_pkg.auth_service = fake_auth_service
services_pkg.get_config = lambda: SimpleNamespace(frontend_base_url="https://portal.peppro.test")
repositories_pkg.user_repository = fake_user_repository

sys.modules.pop("python_backend.repositories.admin_shadow_session_repository", None)
sys.modules.pop("python_backend.services.admin_shadow_session_service", None)

admin_shadow_session_repository = importlib.import_module(
    "python_backend.repositories.admin_shadow_session_repository"
)
repositories_pkg.admin_shadow_session_repository = admin_shadow_session_repository
admin_shadow_session_service = importlib.import_module(
    "python_backend.services.admin_shadow_session_service"
)
services_pkg.admin_shadow_session_service = admin_shadow_session_service


class AdminShadowSessionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        admin_shadow_session_repository.reset_in_memory_state()

    def tearDown(self) -> None:
        admin_shadow_session_repository.reset_in_memory_state()

    def _users(self):
        return {
            "admin-1": {
                "id": "admin-1",
                "role": "admin",
                "name": "Admin User",
                "email": "admin@example.com",
            },
            "doctor-1": {
                "id": "doctor-1",
                "role": "doctor",
                "name": "Doctor User",
                "email": "doctor@example.com",
            },
            "sales-1": {
                "id": "sales-1",
                "role": "sales_rep",
                "name": "Sales Rep User",
                "email": "sales@example.com",
            },
        }

    def test_create_exchange_resolve_and_end_shadow_session(self) -> None:
        users = self._users()
        issued = {}

        def fake_find_by_id(user_id: str):
            return users.get(str(user_id))

        def fake_create_auth_token(payload, *, expires_in_seconds=0):
            issued["payload"] = dict(payload)
            issued["expires_in_seconds"] = expires_in_seconds
            return "shadow-jwt"

        with patch.object(admin_shadow_session_service, "get_config", return_value=SimpleNamespace(frontend_base_url="https://portal.peppro.test")), \
            patch.object(admin_shadow_session_service.user_repository, "find_by_id", side_effect=fake_find_by_id), \
            patch.object(admin_shadow_session_service.auth_service, "_create_auth_token", side_effect=fake_create_auth_token), \
            patch.object(
                admin_shadow_session_service.auth_service,
                "get_profile",
                return_value={
                    "id": "doctor-1",
                    "role": "doctor",
                    "name": "Doctor User",
                    "email": "doctor@example.com",
                },
            ):
            created = admin_shadow_session_service.create_shadow_session(
                {"id": "admin-1", "role": "admin"},
                "doctor-1",
            )
            self.assertEqual(created["targetUserId"], "doctor-1")
            self.assertEqual(created["targetRole"], "doctor")
            self.assertTrue(str(created["launchToken"]).strip())
            self.assertEqual(
                created["launchUrl"],
                f"https://portal.peppro.test/?shadow={created['launchToken']}",
            )

            exchanged = admin_shadow_session_service.exchange_shadow_session(created["launchToken"])
            self.assertEqual(exchanged["token"], "shadow-jwt")
            self.assertEqual(exchanged["user"]["id"], "doctor-1")
            self.assertTrue(exchanged["user"]["shadowContext"]["active"])
            self.assertEqual(issued["payload"]["shadowSessionId"], created["shadowSessionId"])
            self.assertEqual(issued["payload"]["shadowAdminId"], "admin-1")
            self.assertTrue(issued["payload"]["readOnly"])
            self.assertEqual(issued["expires_in_seconds"], 30 * 60)

            resolved = admin_shadow_session_service.resolve_shadow_session(issued["payload"])
            self.assertEqual(resolved["targetUser"]["id"], "doctor-1")
            self.assertEqual(resolved["shadowContext"]["adminUserId"], "admin-1")
            self.assertEqual(resolved["shadowContext"]["targetUserId"], "doctor-1")

            ended = admin_shadow_session_service.end_shadow_session_from_payload(issued["payload"])
            self.assertEqual(ended, {"ok": True})

            with self.assertRaises(Exception) as ended_error:
                admin_shadow_session_service.resolve_shadow_session(issued["payload"])
            self.assertEqual(getattr(ended_error.exception, "error_code", None), "TOKEN_REVOKED")

            with self.assertRaises(Exception) as consumed_error:
                admin_shadow_session_service.exchange_shadow_session(created["launchToken"])
            self.assertEqual(getattr(consumed_error.exception, "error_code", None), "SHADOW_LAUNCH_TOKEN_INVALID")

    def test_create_shadow_session_rejects_non_admin_actor(self) -> None:
        users = self._users()
        with patch.object(
            admin_shadow_session_service.user_repository,
            "find_by_id",
            side_effect=lambda user_id: users.get(str(user_id)),
        ):
            with self.assertRaises(Exception) as error:
                admin_shadow_session_service.create_shadow_session(
                    {"id": "sales-1", "role": "sales_rep"},
                    "doctor-1",
                )
        self.assertEqual(getattr(error.exception, "status", None), 403)

    def test_create_shadow_session_rejects_admin_target(self) -> None:
        users = self._users()
        users["admin-target"] = {
            "id": "admin-target",
            "role": "admin",
            "name": "Second Admin",
            "email": "admin2@example.com",
        }
        with patch.object(
            admin_shadow_session_service.user_repository,
            "find_by_id",
            side_effect=lambda user_id: users.get(str(user_id)),
        ):
            with self.assertRaises(Exception) as error:
                admin_shadow_session_service.create_shadow_session(
                    {"id": "admin-1", "role": "admin"},
                    "admin-target",
                )
        self.assertEqual(getattr(error.exception, "status", None), 403)
        self.assertEqual(getattr(error.exception, "error_code", None), "ADMIN_TARGET_NOT_ALLOWED")


if __name__ == "__main__":
    unittest.main()
