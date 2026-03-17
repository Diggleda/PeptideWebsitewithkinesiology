import sys
import types
import unittest
from unittest.mock import patch


def _install_test_stubs() -> None:
    if "pymysql" not in sys.modules:
        pymysql = types.ModuleType("pymysql")
        pymysql_cursors = types.ModuleType("pymysql.cursors")

        class DictCursor:
            pass

        pymysql_cursors.DictCursor = DictCursor

        class _Connections(types.SimpleNamespace):
            class Connection:
                pass

        pymysql.connections = _Connections()

        def connect(*_args, **_kwargs):
            raise RuntimeError("pymysql.connect called during unit test")

        pymysql.connect = connect
        sys.modules["pymysql"] = pymysql
        sys.modules["pymysql.cursors"] = pymysql_cursors


class UsageTrackingServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        _install_test_stubs()
        from python_backend.services import usage_tracking_service

        cls.usage_tracking_service = usage_tracking_service

    def test_track_event_builds_actor_and_timestamp_details(self):
        service = self.usage_tracking_service
        with patch("python_backend.repositories.usage_tracking_repository.insert_event", return_value=True) as insert_event:
            tracked = service.track_event(
                "delegate_link_tab_clicked",
                actor={"id": "doc-1", "name": "Dr. Test", "email": "doc@example.com", "role": "doctor"},
                metadata={"tab": "patient_links"},
                strict=True,
            )

        self.assertTrue(tracked)
        insert_event.assert_called_once()
        event_name, details = insert_event.call_args.args[:2]
        self.assertEqual(event_name, "delegate_link_tab_clicked")
        self.assertEqual(details["tab"], "patient_links")
        self.assertEqual(details["who"]["id"], "doc-1")
        self.assertEqual(details["who"]["name"], "Dr. Test")
        self.assertEqual(details["who"]["email"], "doc@example.com")
        self.assertEqual(details["who"]["role"], "doctor")
        self.assertIsInstance(details["when"], str)

    def test_track_event_returns_false_for_blank_event(self):
        service = self.usage_tracking_service
        with patch("python_backend.repositories.usage_tracking_repository.insert_event") as insert_event:
            tracked = service.track_event("   ", strict=True)

        self.assertFalse(tracked)
        insert_event.assert_not_called()


if __name__ == "__main__":
    unittest.main()
