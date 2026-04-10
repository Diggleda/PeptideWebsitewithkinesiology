from __future__ import annotations

import importlib
import importlib.util
from pathlib import Path
import sys
import types
import unittest


def _module(name: str, **attrs) -> types.ModuleType:
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    return mod


def _ensure_package(name: str, path: Path) -> types.ModuleType:
    existing = sys.modules.get(name)
    if existing is not None:
        return existing
    package = types.ModuleType(name)
    package.__path__ = [str(path)]  # type: ignore[attr-defined]
    sys.modules[name] = package
    return package


class _FakeHTTPException(Exception):
    code = None

    def __init__(self, description: str = "", code: int | None = None):
        super().__init__(description)
        self.description = description
        if code is not None:
            self.code = code


class AuthHttpRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._saved_modules = {name: sys.modules.get(name) for name in (
            "flask",
            "jwt",
            "werkzeug",
            "werkzeug.exceptions",
            "python_backend.middleware.auth",
            "python_backend.services.admin_shadow_session_service",
            "python_backend.utils.http",
            "python_backend.services.auth_service",
            "python_backend.services.presence_service",
            "python_backend.repositories.user_repository",
        )}
        cls._saved_service_attrs = {}
        cls._saved_repository_attrs = {}

        fake_flask = _module(
            "flask",
            Response=object,
            jsonify=lambda value=None, *args, **kwargs: value,
            request=types.SimpleNamespace(headers={}, args={}, json=None, method="GET", path="/test"),
            g=types.SimpleNamespace(current_user=None),
        )
        fake_jwt = _module(
            "jwt",
            decode=lambda *args, **kwargs: {},
            ExpiredSignatureError=type("ExpiredSignatureError", (Exception,), {}),
            InvalidTokenError=type("InvalidTokenError", (Exception,), {}),
        )
        fake_werkzeug_exceptions = _module("werkzeug.exceptions", HTTPException=_FakeHTTPException)
        fake_werkzeug = _module("werkzeug", exceptions=fake_werkzeug_exceptions)

        sys.modules["flask"] = fake_flask
        sys.modules["jwt"] = fake_jwt
        sys.modules["werkzeug"] = fake_werkzeug
        sys.modules["werkzeug.exceptions"] = fake_werkzeug_exceptions

        repo_root = Path(__file__).resolve().parents[2]
        import python_backend  # noqa: F401

        services_pkg = importlib.import_module("python_backend.services")
        repositories_pkg = importlib.import_module("python_backend.repositories")
        _ensure_package("python_backend.middleware", repo_root / "python_backend" / "middleware")
        _ensure_package("python_backend.utils", repo_root / "python_backend" / "utils")

        fake_auth_service = _module("python_backend.services.auth_service", logout=lambda *args, **kwargs: None)
        fake_presence_service = _module("python_backend.services.presence_service", snapshot=lambda: {})
        fake_shadow_service = _module(
            "python_backend.services.admin_shadow_session_service",
            resolve_shadow_session=lambda payload: {},
        )
        fake_user_repository = _module("python_backend.repositories.user_repository", find_by_id=lambda _user_id: None)

        sys.modules["python_backend.services.auth_service"] = fake_auth_service
        sys.modules["python_backend.services.presence_service"] = fake_presence_service
        sys.modules["python_backend.services.admin_shadow_session_service"] = fake_shadow_service
        sys.modules["python_backend.repositories.user_repository"] = fake_user_repository

        for attr in ("get_config", "auth_service", "presence_service", "admin_shadow_session_service"):
            cls._saved_service_attrs[attr] = getattr(services_pkg, attr, None)
        services_pkg.get_config = lambda: types.SimpleNamespace(jwt_secret="test-secret")
        services_pkg.auth_service = fake_auth_service
        services_pkg.presence_service = fake_presence_service
        services_pkg.admin_shadow_session_service = fake_shadow_service

        cls._saved_repository_attrs["user_repository"] = getattr(repositories_pkg, "user_repository", None)
        repositories_pkg.user_repository = fake_user_repository

        cls.http = cls._load_module(
            "python_backend.utils.http",
            repo_root / "python_backend" / "utils" / "http.py",
        )
        cls.auth = cls._load_module(
            "python_backend.middleware.auth",
            repo_root / "python_backend" / "middleware" / "auth.py",
        )

    @classmethod
    def tearDownClass(cls) -> None:
        services_pkg = importlib.import_module("python_backend.services")
        repositories_pkg = importlib.import_module("python_backend.repositories")

        for attr, value in cls._saved_service_attrs.items():
            if value is None and hasattr(services_pkg, attr):
                delattr(services_pkg, attr)
            elif value is not None:
                setattr(services_pkg, attr, value)

        for attr, value in cls._saved_repository_attrs.items():
            if value is None and hasattr(repositories_pkg, attr):
                delattr(repositories_pkg, attr)
            elif value is not None:
                setattr(repositories_pkg, attr, value)

        for name, value in cls._saved_modules.items():
            if value is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = value

    @staticmethod
    def _load_module(name: str, path: Path):
        sys.modules.pop(name, None)
        spec = importlib.util.spec_from_file_location(name, path)
        if spec is None or spec.loader is None:
            raise unittest.SkipTest(f"unable to load module: {name}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
        return module

    def setUp(self) -> None:
        self.auth.request.headers = {}
        self.auth.request.method = "GET"
        self.auth.request.path = "/test"
        self.auth.g.current_user = None

    def test_require_auth_handles_missing_login_timestamps_without_name_error(self) -> None:
        payload = {
            "id": "user-1",
            "role": "doctor",
            "sid": "session-1",
            "email": "doctor@example.com",
            "iat": None,
        }
        self.auth.jwt.decode = lambda *args, **kwargs: payload
        self.auth.request.headers = {"Authorization": "Bearer token-1"}
        self.auth.user_repository.find_by_id = lambda _user_id: {"id": "user-1", "sessionId": "session-1"}
        self.auth.presence_service.snapshot = lambda: {}

        @self.auth.require_auth
        def protected():
            return {"ok": True}

        response = protected()
        self.assertEqual(response, {"ok": True})
        self.assertEqual(self.auth.g.current_user["id"], "user-1")

    def test_json_error_preserves_machine_code_from_service_error(self) -> None:
        error = self.http.service_error("SALES_REP_ACCESS_REQUIRED", 403)
        payload, status = self.http.json_error(error)

        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "SALES_REP_ACCESS_REQUIRED")
        self.assertEqual(payload["code"], "SALES_REP_ACCESS_REQUIRED")

    def test_json_error_defaults_code_for_human_message(self) -> None:
        error = self.http.service_error("Admin access required", 403)
        payload, status = self.http.json_error(error)

        self.assertEqual(status, 403)
        self.assertEqual(payload["error"], "Admin access required")
        self.assertEqual(payload["code"], "FORBIDDEN")


if __name__ == "__main__":
    unittest.main()
