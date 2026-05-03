import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

try:
    import flask  # noqa: F401
except ModuleNotFoundError:  # pragma: no cover - local env fallback
    flask = None


class TestSettingsLiveUsers(unittest.TestCase):
    @staticmethod
    def _load_settings_module():
        if flask is None or getattr(flask, "__trufusion_fake__", False):
            raise unittest.SkipTest("flask not installed")
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

    def test_live_users_payload_excludes_profile_fields_and_avatar_does_not_affect_etag(self):
        settings = self._load_settings_module()

        def build_user(profile_image_url: str | None):
            return {
                "id": "u1",
                "name": "Avatar User",
                "email": "avatar@example.com",
                "role": "admin",
                "isOnline": False,
                "lastLoginAt": "2026-03-20T12:00:00Z",
                "lastSeenAt": None,
                "lastInteractionAt": None,
                "profileImageUrl": profile_image_url,
                "greaterArea": "Midwest",
                "studyFocus": "Metabolism",
                "bio": "Long physician bio",
                "isPartner": True,
                "allowedRetail": True,
            }

        with patch.object(settings.user_repository, "get_all", return_value=[build_user("data:image/png;base64,AAA")]), \
            patch.object(settings.presence_service, "snapshot", return_value={}), \
            patch.object(settings.time, "time", return_value=1_000.0):
            payload_with_avatar = settings._compute_live_users_payload()

        self.assertNotIn("profileImageUrl", payload_with_avatar["users"][0])
        self.assertNotIn("greaterArea", payload_with_avatar["users"][0])
        self.assertNotIn("studyFocus", payload_with_avatar["users"][0])
        self.assertNotIn("bio", payload_with_avatar["users"][0])
        self.assertEqual(payload_with_avatar["users"][0]["isPartner"], True)
        self.assertEqual(payload_with_avatar["users"][0]["allowedRetail"], True)
        self.assertIsInstance(payload_with_avatar.get("etag"), str)
        self.assertTrue(payload_with_avatar["etag"])

        with patch.object(settings.user_repository, "get_all", return_value=[build_user(None)]), \
            patch.object(settings.presence_service, "snapshot", return_value={}), \
            patch.object(settings.time, "time", return_value=1_000.0):
            payload_without_avatar = settings._compute_live_users_payload()

        self.assertNotIn("profileImageUrl", payload_without_avatar["users"][0])
        self.assertEqual(payload_with_avatar["etag"], payload_without_avatar["etag"])

    def test_presence_snapshot_treats_fresh_local_heartbeat_as_online(self):
        settings = self._load_settings_module()

        snapshot = settings._compute_presence_snapshot(
            {
                "id": "doctor-1",
                "role": "doctor",
                "isOnline": False,
                "lastSeenAt": "1970-01-01T00:01:40Z",
                "lastLoginAt": "1970-01-01T00:01:40Z",
            },
            now_epoch=1_000.0,
            online_threshold_s=300.0,
            idle_threshold_s=600.0,
            presence={
                "doctor-1": {
                    "lastHeartbeatAt": 990.0,
                    "lastInteractionAt": 990.0,
                    "onlineSinceAt": 990.0,
                    "isIdle": False,
                }
            },
        )

        self.assertTrue(snapshot["isOnline"])
        self.assertEqual(snapshot["lastSeenAt"], "1970-01-01T00:16:30Z")

    def test_live_users_cache_invalidates_when_presence_revision_changes(self):
        settings = self._load_settings_module()
        original_cache = dict(settings._LIVE_USERS_CACHE)
        try:
            settings._LIVE_USERS_CACHE.clear()
            settings._LIVE_USERS_CACHE.update(
                {
                    "payload": {"etag": "stale"},
                    "expiresAt": 1_005.0,
                    "revision": 1,
                }
            )

            with patch.object(settings.time, "monotonic", return_value=1_000.0), \
                patch.object(settings.presence_service, "current_revision", return_value=2), \
                patch.object(settings, "_compute_live_users_payload", return_value={"etag": "fresh"}) as compute:
                payload = settings._compute_live_users_cached()

            self.assertEqual(payload, {"etag": "fresh"})
            compute.assert_called_once()
        finally:
            settings._LIVE_USERS_CACHE.clear()
            settings._LIVE_USERS_CACHE.update(original_cache)

    def test_live_clients_cache_invalidates_when_presence_revision_changes(self):
        settings = self._load_settings_module()
        original_cache = dict(settings._LIVE_CLIENTS_CACHE)
        try:
            settings._LIVE_CLIENTS_CACHE.clear()
            settings._LIVE_CLIENTS_CACHE["rep-1"] = {
                "at": 1_000.0,
                "revision": 1,
                "payload": {"etag": "stale"},
            }

            with patch.object(settings.time, "monotonic", return_value=1_000.0), \
                patch.object(settings.presence_service, "current_revision", return_value=2), \
                patch.object(settings, "_compute_live_clients_payload", return_value={"etag": "fresh"}) as compute:
                payload = settings._compute_live_clients_cached_with_scope(
                    target_sales_rep_id="rep-1",
                    strict_assignment=False,
                )

            self.assertEqual(payload, {"etag": "fresh"})
            compute.assert_called_once_with(target_sales_rep_id="rep-1", strict_assignment=False)
        finally:
            settings._LIVE_CLIENTS_CACHE.clear()
            settings._LIVE_CLIENTS_CACHE.update(original_cache)


if __name__ == "__main__":
    unittest.main()
