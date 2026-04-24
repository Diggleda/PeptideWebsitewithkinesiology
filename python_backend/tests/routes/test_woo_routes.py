import unittest
from unittest.mock import patch

try:
    from flask import Flask
    from python_backend.routes import woo
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - local test env may not include Flask stack
    Flask = None
    woo = None
    _IMPORT_ERROR = exc


class WooRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        if Flask is None or woo is None:
            self.skipTest(f"woo route test requires Flask backend dependencies: {_IMPORT_ERROR}")
        self.app = Flask(__name__)
        self.app.register_blueprint(woo.blueprint)

    def test_get_product_prefers_catalog_snapshot(self) -> None:
        snapshot = {"id": 1512, "name": "Snapshot Product", "status": "publish"}

        with self.app.test_client() as client, patch.object(
            woo.catalog_snapshot_service,
            "get_catalog_product",
            return_value=snapshot,
        ) as get_catalog_product, patch.object(woo.woo_commerce, "fetch_catalog_proxy") as fetch_catalog_proxy:
            response = client.get("/api/woo/products/1512")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), snapshot)
        self.assertEqual(response.headers.get("X-PepPro-Cache"), "SNAPSHOT")
        get_catalog_product.assert_called_once_with(1512)
        fetch_catalog_proxy.assert_not_called()

    def test_get_product_falls_back_to_live_proxy_when_snapshot_missing(self) -> None:
        err = RuntimeError("NOT_FOUND")
        setattr(err, "status", 404)
        live_payload = {"id": 1512, "name": "Live Product", "status": "publish"}

        with self.app.test_client() as client, patch.object(
            woo.catalog_snapshot_service,
            "get_catalog_product",
            side_effect=err,
        ) as get_catalog_product, patch.object(
            woo.woo_commerce,
            "fetch_catalog_proxy",
            return_value=(live_payload, {"cache": "MISS", "ttlSeconds": 600}),
        ) as fetch_catalog_proxy:
            response = client.get("/api/woo/products/1512")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), live_payload)
        self.assertEqual(response.headers.get("X-PepPro-Cache"), "MISS")
        get_catalog_product.assert_called_once_with(1512)
        fetch_catalog_proxy.assert_called_once()

    def test_get_product_force_query_bypasses_snapshot(self) -> None:
        live_payload = {"id": 1512, "name": "Live Product", "status": "publish"}

        with self.app.test_client() as client, patch.object(
            woo.catalog_snapshot_service,
            "get_catalog_product",
        ) as get_catalog_product, patch.object(
            woo.woo_commerce,
            "fetch_catalog_proxy",
            return_value=(live_payload, {"cache": "MISS", "ttlSeconds": 600, "noStore": True}),
        ) as fetch_catalog_proxy:
            response = client.get("/api/woo/products/1512?force=1")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json(), live_payload)
        get_catalog_product.assert_not_called()
        fetch_catalog_proxy.assert_called_once()


if __name__ == "__main__":
    unittest.main()
