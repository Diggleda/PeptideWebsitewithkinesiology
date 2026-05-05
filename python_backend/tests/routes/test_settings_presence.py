import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch


class TestSettingsPresence(unittest.TestCase):
    @staticmethod
    def _load_settings_module():
        try:
            import python_backend  # noqa: F401
            from flask import Flask  # noqa: F401
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

    def test_record_presence_ignores_shadow_sessions(self):
        try:
            from flask import Flask
        except (ModuleNotFoundError, ImportError) as exc:
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc

        settings = self._load_settings_module()
        app = Flask(__name__)

        with app.test_request_context(
            "/api/settings/presence",
            method="POST",
            json={"kind": "heartbeat", "isIdle": False},
        ):
            settings.g.current_user = {
                "id": "doctor-1",
                "role": "doctor",
                "shadow": True,
                "readOnly": True,
            }
            settings.g.shadow_context = {"active": True}

            with patch.object(settings.presence_service, "record_ping") as record_ping, \
                patch.object(settings.user_repository, "find_by_id") as find_by_id, \
                patch.object(settings.user_repository, "update") as update_user:
                response, status = settings.record_presence.__wrapped__()

            self.assertEqual(status, 200)
            self.assertEqual(
                response.get_json(),
                {"ok": True, "skipped": True, "reason": "shadow_session"},
            )
            record_ping.assert_not_called()
            find_by_id.assert_not_called()
            update_user.assert_not_called()

    def test_record_presence_persists_before_recording_local_presence(self):
        try:
            from flask import Flask
        except (ModuleNotFoundError, ImportError) as exc:
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc

        settings = self._load_settings_module()
        app = Flask(__name__)
        calls = []

        def persist_presence(*args, **kwargs):
            calls.append("persist")
            return True

        def record_ping(*args, **kwargs):
            calls.append("record")
            return {}

        with app.test_request_context(
            "/api/settings/presence",
            method="POST",
            json={"kind": "interaction", "isIdle": False},
        ):
            settings.g.current_user = {
                "id": "doctor-1",
                "role": "doctor",
            }
            settings.g.shadow_context = None

            with patch.object(settings.user_repository, "record_presence_ping", side_effect=persist_presence) as persist, \
                patch.object(settings.presence_service, "record_ping", side_effect=record_ping) as local_record:
                response, status = settings.record_presence.__wrapped__()

        self.assertEqual(status, 200)
        self.assertEqual(response.get_json(), {"ok": True})
        self.assertEqual(calls, ["persist", "record"])
        persist.assert_called_once()
        self.assertEqual(persist.call_args.kwargs.get("bump_interaction"), True)
        local_record.assert_called_once()

    def test_record_presence_logout_clears_local_presence_after_persisting_offline(self):
        try:
            from flask import Flask
        except (ModuleNotFoundError, ImportError) as exc:
            raise unittest.SkipTest(f"python deps not installed: {exc}") from exc

        settings = self._load_settings_module()
        app = Flask(__name__)
        existing = {
            "id": "doctor-1",
            "email": "doctor@example.com",
            "isOnline": True,
            "isIdle": True,
            "lastSeenAt": "2026-05-03T20:00:00Z",
        }

        with app.test_request_context(
            "/api/settings/presence",
            method="POST",
            json={"kind": "logout", "isIdle": False},
        ):
            settings.g.current_user = {
                "id": "doctor-1",
                "role": "doctor",
            }
            settings.g.shadow_context = None

            with patch.object(settings.user_repository, "find_by_id", return_value=existing) as find_by_id, \
                patch.object(settings.user_repository, "update", return_value={**existing, "isOnline": False}) as update_user, \
                patch.object(settings.presence_service, "clear_user") as clear_user, \
                patch.object(settings.presence_service, "record_ping") as record_ping:
                response, status = settings.record_presence.__wrapped__()

        self.assertEqual(status, 200)
        self.assertEqual(response.get_json(), {"ok": True})
        find_by_id.assert_called_once_with("doctor-1")
        update_user.assert_called_once()
        payload = update_user.call_args.args[0]
        self.assertEqual(payload["isOnline"], False)
        self.assertEqual(payload["isIdle"], False)
        self.assertNotEqual(payload["lastSeenAt"], existing["lastSeenAt"])
        clear_user.assert_called_once_with("doctor-1")
        record_ping.assert_not_called()


if __name__ == "__main__":
    unittest.main()
