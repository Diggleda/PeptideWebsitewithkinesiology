import unittest
import sys
import types
from unittest.mock import patch

if "pymysql" not in sys.modules:
    pymysql_stub = types.ModuleType("pymysql")
    pymysql_stub.connect = lambda *args, **kwargs: None
    pymysql_stub.connections = types.SimpleNamespace(Connection=object)
    pymysql_stub.err = types.SimpleNamespace(Error=Exception, OperationalError=Exception)
    cursors_stub = types.ModuleType("pymysql.cursors")
    cursors_stub.DictCursor = object
    pymysql_stub.cursors = cursors_stub
    sys.modules["pymysql"] = pymysql_stub
    sys.modules["pymysql.cursors"] = cursors_stub

if "python_backend.storage" not in sys.modules:
    storage_stub = types.ModuleType("python_backend.storage")
    storage_stub.order_store = None
    sys.modules["python_backend.storage"] = storage_stub

from python_backend.repositories import order_repository


class TestOrderRepositoryShippedAt(unittest.TestCase):
    def test_to_db_params_uses_explicit_shipstation_ship_date(self):
        params = order_repository._to_db_params(
            {
                "id": "order-1",
                "userId": "user-1",
                "status": "completed",
                "trackingNumber": "1Z999",
                "integrationDetails": {
                    "shipStation": {
                        "shipDate": "2026-01-24",
                    }
                },
            }
        )

        self.assertEqual(params["shipped_at"], "2026-01-24 00:00:00")

    def test_to_db_params_does_not_invent_shipped_at_from_status_and_tracking(self):
        params = order_repository._to_db_params(
            {
                "id": "order-2",
                "userId": "user-2",
                "status": "completed",
                "trackingNumber": "1Z999",
            }
        )

        self.assertIsNone(params["shipped_at"])

    @patch("python_backend.repositories.order_repository.find_by_id", return_value={"id": "order-3"})
    @patch("python_backend.repositories.order_repository.mysql_client.execute")
    @patch("python_backend.repositories.order_repository._using_mysql", return_value=True)
    def test_insert_preserves_existing_shipped_at(self, _using_mysql, mock_execute, _find_by_id):
        order_repository.insert(
            {
                "id": "order-3",
                "userId": "user-3",
                "status": "completed",
            }
        )

        sql = mock_execute.call_args[0][0]
        self.assertIn("shipped_at = COALESCE(shipped_at, VALUES(shipped_at))", sql)

    @patch("python_backend.repositories.order_repository.find_by_id", return_value={"id": "order-4"})
    @patch("python_backend.repositories.order_repository.mysql_client.execute")
    @patch("python_backend.repositories.order_repository._using_mysql", return_value=True)
    def test_update_preserves_existing_shipped_at(self, _using_mysql, mock_execute, _find_by_id):
        order_repository.update(
            {
                "id": "order-4",
                "userId": "user-4",
                "status": "completed",
            }
        )

        sql = mock_execute.call_args[0][0]
        self.assertIn("shipped_at = COALESCE(shipped_at, %(shipped_at)s)", sql)


if __name__ == "__main__":
    unittest.main()
