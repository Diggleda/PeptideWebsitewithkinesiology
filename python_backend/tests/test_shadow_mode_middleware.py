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


class _FakeJsonResponse(dict):
    status_code = 200


fake_flask = _module(
    "flask",
    Flask=object,
    Response=object,
    jsonify=lambda value=None, *args, **kwargs: _FakeJsonResponse(value or {}),
    request=types.SimpleNamespace(headers={}, method="GET", path="/test"),
    g=types.SimpleNamespace(current_user=None, shadow_context=None),
)
sys.modules["flask"] = fake_flask


fake_jwt = _module(
    "jwt",
    decode=lambda *args, **kwargs: {},
    ExpiredSignatureError=type("ExpiredSignatureError", (Exception,), {}),
    InvalidTokenError=type("InvalidTokenError", (Exception,), {}),
)
sys.modules["jwt"] = fake_jwt

import python_backend  # noqa: F401

services_pkg = importlib.import_module("python_backend.services")
repositories_pkg = importlib.import_module("python_backend.repositories")

fake_auth_service = _module("python_backend.services.auth_service", logout=lambda *args, **kwargs: None)
fake_presence_service = _module("python_backend.services.presence_service", snapshot=lambda: {})
fake_shadow_service = _module(
    "python_backend.services.admin_shadow_session_service",
    resolve_shadow_session=lambda payload: {},
)
fake_user_repository = _module(
    "python_backend.repositories.user_repository",
    find_by_id=lambda _user_id: None,
    find_session_by_id=lambda _user_id: None,
)

sys.modules["python_backend.services.auth_service"] = fake_auth_service
sys.modules["python_backend.services.presence_service"] = fake_presence_service
sys.modules["python_backend.services.admin_shadow_session_service"] = fake_shadow_service
sys.modules["python_backend.repositories.user_repository"] = fake_user_repository

services_pkg.auth_service = fake_auth_service
services_pkg.presence_service = fake_presence_service
services_pkg.admin_shadow_session_service = fake_shadow_service
services_pkg.get_config = lambda: SimpleNamespace(jwt_secret="shadow-test-secret")
repositories_pkg.user_repository = fake_user_repository

sys.modules.pop("python_backend.middleware.auth", None)
sys.modules.pop("python_backend.middleware.shadow_mode", None)

auth_module = importlib.import_module("python_backend.middleware.auth")
shadow_mode_module = importlib.import_module("python_backend.middleware.shadow_mode")
require_auth = auth_module.require_auth
init_shadow_mode = shadow_mode_module.init_shadow_mode


class ShadowModeMiddlewareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.secret = "shadow-test-secret"
        self.auth = auth_module
        self.shadow_mode = shadow_mode_module
        self.auth.request.headers = {}
        self.auth.request.method = "GET"
        self.auth.request.path = "/api/protected"
        self.auth.g.current_user = None
        self.auth.g.shadow_context = None
        self.shadow_mode.request.headers = {}
        self.shadow_mode.request.method = "GET"
        self.shadow_mode.request.path = "/api/protected"

        class _FakeApp:
            def __init__(self):
                self.before_request_func = None

            def before_request(self, func):
                self.before_request_func = func
                return func

        self.app = _FakeApp()
        init_shadow_mode(self.app)

    def _token(self) -> dict:
        return {
            "id": "doctor-1",
            "email": "doctor@example.com",
            "role": "doctor",
            "shadow": True,
            "shadowMode": "maintenance",
            "shadowAdminId": "admin-1",
            "shadowSessionId": "shadow-session-1",
            "readOnly": True,
        }

    def test_shadow_token_maps_to_target_user_on_get(self) -> None:
        resolved = {
            "targetUser": {
                "id": "doctor-1",
                "email": "doctor@example.com",
                "role": "doctor",
            },
            "shadowContext": {
                "active": True,
                "mode": "maintenance",
                "readOnly": True,
                "adminUserId": "admin-1",
                "adminName": "Admin User",
                "targetUserId": "doctor-1",
                "startedAt": "2026-01-01T00:00:00Z",
                "expiresAt": "2026-01-01T00:30:00Z",
            },
        }

        @self.auth.require_auth
        def protected():
            return {
                "currentUserId": self.auth.g.current_user.get("id"),
                "role": self.auth.g.current_user.get("role"),
                "shadowContext": getattr(self.auth.g, "shadow_context", None),
            }

        self.auth.request.headers = {"Authorization": "Bearer shadow-token"}
        with patch("python_backend.middleware.auth.get_config", return_value=SimpleNamespace(jwt_secret=self.secret)), \
            patch("python_backend.middleware.auth.jwt.decode", return_value=self._token()), \
            patch("python_backend.middleware.auth.admin_shadow_session_service.resolve_shadow_session", return_value=resolved):
            payload = protected()
        self.assertEqual(payload["currentUserId"], "doctor-1")
        self.assertEqual(payload["role"], "doctor")
        self.assertTrue(payload["shadowContext"]["active"])

    def test_shadow_token_blocks_mutating_requests_globally(self) -> None:
        self.shadow_mode.request.method = "POST"
        self.shadow_mode.request.path = "/api/protected-write"
        self.shadow_mode.request.headers = {"Authorization": "Bearer shadow-token"}
        with patch("python_backend.middleware.shadow_mode.get_config", return_value=SimpleNamespace(jwt_secret=self.secret)), \
            patch("python_backend.middleware.shadow_mode.jwt.decode", return_value=self._token()):
            response = self.app.before_request_func()
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response["code"], "SHADOW_READ_ONLY")

    def test_shadow_token_can_still_hit_logout_allowlist(self) -> None:
        self.shadow_mode.request.method = "POST"
        self.shadow_mode.request.path = "/api/auth/logout"
        self.shadow_mode.request.headers = {"Authorization": "Bearer shadow-token"}
        with patch("python_backend.middleware.shadow_mode.get_config", return_value=SimpleNamespace(jwt_secret=self.secret)), \
            patch("python_backend.middleware.shadow_mode.jwt.decode", return_value=self._token()):
            response = self.app.before_request_func()
        self.assertIsNone(response)


if __name__ == "__main__":
    unittest.main()
