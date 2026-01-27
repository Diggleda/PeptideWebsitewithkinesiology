import unittest
from unittest.mock import patch


class TestPresenceService(unittest.TestCase):
    def test_is_recent_epoch_threshold(self):
        try:
            from python_backend.services import presence_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        now = 1_000.0
        self.assertTrue(
            presence_service.is_recent_epoch(900.0, now_epoch=now, threshold_s=200.0, future_skew_s=5.0)
        )
        self.assertFalse(
            presence_service.is_recent_epoch(700.0, now_epoch=now, threshold_s=200.0, future_skew_s=5.0)
        )

    def test_is_recent_epoch_future_skew(self):
        try:
            from python_backend.services import presence_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        now = 1_000.0
        # Within allowed skew -> treat as recent (clock drift, ordering, etc.)
        self.assertTrue(
            presence_service.is_recent_epoch(1_002.0, now_epoch=now, threshold_s=10.0, future_skew_s=5.0)
        )
        # Too far in the future -> not recent.
        self.assertFalse(
            presence_service.is_recent_epoch(1_010.0, now_epoch=now, threshold_s=10.0, future_skew_s=5.0)
        )

    def test_is_recent_epoch_invalid_values(self):
        try:
            from python_backend.services import presence_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        self.assertFalse(presence_service.is_recent_epoch(None, threshold_s=10.0, now_epoch=1.0))
        self.assertFalse(presence_service.is_recent_epoch(0, threshold_s=10.0, now_epoch=1.0))
        self.assertFalse(presence_service.is_recent_epoch("nope", threshold_s=10.0, now_epoch=1.0))

    def test_prune_stale_removes_entries(self):
        try:
            from python_backend.services import presence_service
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        user_id = "u123"
        presence_service.clear_user(user_id)
        try:
            with patch.object(presence_service.time, "time", return_value=1000.0):
                presence_service.record_ping(user_id, kind="heartbeat")

            with patch.object(presence_service.time, "time", return_value=2000.0):
                removed = presence_service.prune_stale(max_age_s=500.0)

            self.assertGreaterEqual(removed, 1)
            self.assertNotIn(user_id, presence_service.snapshot())
        finally:
            presence_service.clear_user(user_id)


if __name__ == "__main__":
    unittest.main()

