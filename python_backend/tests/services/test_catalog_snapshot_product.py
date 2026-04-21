import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class TestCatalogSnapshotProduct(unittest.TestCase):
    def test_product_detail_uses_full_snapshot_when_available(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        full_snapshot = {"id": 1512, "name": "Full Product", "variations": [{"id": 88}]}

        with patch.object(svc, "get_config", return_value=SimpleNamespace(mysql={"enabled": True})), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client:
            mock_mysql_client.fetch_one.return_value = {"data": json.dumps(full_snapshot)}

            result = svc.get_catalog_product(1512)

        self.assertEqual(result, full_snapshot)
        query, params = mock_mysql_client.fetch_one.call_args.args
        self.assertIn("ORDER BY CASE", query)
        self.assertEqual(params["kind_full"], svc.KIND_CATALOG_PRODUCT_FULL)
        self.assertEqual(params["kind_light"], svc.KIND_CATALOG_PRODUCT_LIGHT)

    def test_product_detail_falls_back_to_light_snapshot(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        light_snapshot = {"id": 1512, "name": "Light Product", "type": "simple"}

        with patch.object(svc, "get_config", return_value=SimpleNamespace(mysql={"enabled": True})), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client:
            mock_mysql_client.fetch_one.return_value = {"data": json.dumps(light_snapshot)}

            result = svc.get_catalog_product(1512)

        self.assertEqual(result, light_snapshot)

    def test_product_detail_returns_404_when_no_snapshot_exists(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(svc, "get_config", return_value=SimpleNamespace(mysql={"enabled": True})), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client:
            mock_mysql_client.fetch_one.return_value = None

            with self.assertRaises(RuntimeError) as ctx:
                svc.get_catalog_product(1512)

        self.assertEqual(str(ctx.exception), "NOT_FOUND")
        self.assertEqual(getattr(ctx.exception, "status", None), 404)


if __name__ == "__main__":
    unittest.main()
