import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch


class TestCatalogSnapshotVariations(unittest.TestCase):
    def test_variations_prefer_sql_snapshot_when_priced(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        snapshot = {
            "variations": [
                {"id": 101, "price": "99.00"},
                {"id": 102, "price": "149.00"},
            ]
        }

        with patch.object(svc, "get_config", return_value=SimpleNamespace(mysql={"enabled": True})), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client, patch.object(svc.woo_commerce, "fetch_catalog_proxy") as mock_proxy:
            mock_mysql_client.fetch_one.return_value = {"data": json.dumps(snapshot).encode("utf-8")}

            result = svc.get_catalog_product_variations(55)

        self.assertEqual(result, snapshot["variations"])
        mock_proxy.assert_not_called()

    def test_variations_fall_back_to_live_when_snapshot_missing_price_data(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        snapshot = {"variations": [{"id": 101, "attributes": [{"name": "Strength", "option": "10mg"}]}]}
        live = [
            {"id": 101, "price": "99.00"},
            {"id": 102, "price": "149.00"},
        ]

        with patch.object(svc, "get_config", return_value=SimpleNamespace(mysql={"enabled": True})), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client, patch.object(
            svc.woo_commerce, "fetch_catalog_proxy", return_value=(live, {"cache": "MISS"})
        ) as mock_proxy:
            mock_mysql_client.fetch_one.return_value = {"data": json.dumps(snapshot)}

            result = svc.get_catalog_product_variations(55)

        self.assertEqual(result, live)
        mock_proxy.assert_called_once_with(
            "products/55/variations",
            {"per_page": 100, "status": "publish"},
        )

    def test_variations_force_refresh_bypasses_snapshot(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        snapshot = {"variations": [{"id": 101, "price": "99.00"}]}
        live = [
            {"id": 101, "price": "109.00"},
            {"id": 102, "price": "159.00"},
        ]

        with patch.object(svc, "get_config", return_value=SimpleNamespace(mysql={"enabled": True})), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client, patch.object(
            svc.woo_commerce, "fetch_catalog_fresh", return_value=(live, {"cache": "FRESH"})
        ) as mock_fresh, patch.object(svc.woo_commerce, "fetch_catalog_proxy") as mock_proxy:
            mock_mysql_client.fetch_one.return_value = {"data": json.dumps(snapshot).encode("utf-8")}

            result = svc.get_catalog_product_variations(55, force=True)

        self.assertEqual(result, live)
        mock_fresh.assert_called_once_with(
            "products/55/variations",
            {"per_page": 100, "status": "publish"},
            acquire_timeout=15,
        )
        mock_proxy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
