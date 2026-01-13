import unittest
from unittest.mock import patch


class TestCatalogSnapshotPrune(unittest.TestCase):
    def test_prune_deletes_snapshot_rows_and_coa_stubs(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        # Existing snapshot rows in DB: 1,2,3. Woo currently has 1,3.
        with patch.object(svc, "mysql_client") as mock_mysql_client:
            mock_mysql_client.fetch_all.return_value = [
                {"woo_product_id": 1},
                {"woo_product_id": 2},
                {"woo_product_id": 3},
            ]
            # First delete (snapshots) deletes 2 rows (light+full), second (coa stubs) deletes 1 stub.
            mock_mysql_client.execute.side_effect = [2, 1]

            result = svc._prune_missing_products({1, 3}, fetch_hit_limit=False)

        self.assertTrue(result["ok"])
        self.assertEqual(result["prunedProducts"], 1)
        self.assertEqual(result["deletedSnapshotRows"], 2)
        self.assertEqual(result["deletedCoaStubRows"], 1)
        self.assertEqual(mock_mysql_client.execute.call_count, 2)

    def test_prune_skips_when_too_few_products(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.dict("os.environ", {"CATALOG_SNAPSHOT_PRUNE_MIN_PRODUCTS": "5"}), patch.object(
            svc, "mysql_client"
        ) as mock_mysql_client:
            result = svc._prune_missing_products({1, 2}, fetch_hit_limit=False)

        self.assertFalse(result["ok"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "too_few_products")
        mock_mysql_client.fetch_all.assert_not_called()
        mock_mysql_client.execute.assert_not_called()

    def test_prune_skips_when_fetch_incomplete(self):
        try:
            from python_backend.services import catalog_snapshot_service as svc
        except ModuleNotFoundError as exc:
            self.skipTest(f"python deps not installed: {exc}")

        with patch.object(svc, "mysql_client") as mock_mysql_client:
            result = svc._prune_missing_products({1, 2, 3}, fetch_hit_limit=True)

        self.assertFalse(result["ok"])
        self.assertTrue(result["skipped"])
        self.assertEqual(result["reason"], "fetch_incomplete")
        mock_mysql_client.fetch_all.assert_not_called()
        mock_mysql_client.execute.assert_not_called()


if __name__ == "__main__":
    unittest.main()
