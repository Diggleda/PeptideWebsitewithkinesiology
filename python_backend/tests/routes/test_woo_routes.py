from io import BytesIO
import unittest
from unittest.mock import patch

try:
    from flask import Flask
    from python_backend.middleware import auth as auth_middleware
    from python_backend.routes import woo
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - local test env may not include Flask stack
    Flask = None
    auth_middleware = None
    woo = None
    _IMPORT_ERROR = exc


class WooRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        if Flask is None or woo is None or auth_middleware is None:
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
        self.assertEqual(response.headers.get("X-TruFusion-Cache"), "SNAPSHOT")
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
        self.assertEqual(response.headers.get("X-TruFusion-Cache"), "MISS")
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

    def test_upload_certificate_accepts_pdf_and_normalizes_metadata(self) -> None:
        calls = []

        def fake_upsert_document(**kwargs):
            calls.append(kwargs)
            return {
                "woo_product_id": kwargs["woo_product_id"],
                "mime_type": kwargs["mime_type"],
                "filename": kwargs["filename"],
            }

        with self.app.test_client() as client, patch.object(
            auth_middleware,
            "_authenticate_request",
            return_value=None,
        ), patch.object(
            woo,
            "_require_admin",
            return_value=None,
        ), patch.object(
            woo.product_document_repository,
            "upsert_document",
            side_effect=fake_upsert_document,
        ):
            response = client.post(
                "/api/woo/products/1512/certificate-of-analysis",
                data={"file": (BytesIO(b"%PDF-1.4\n% test pdf\n"), "batch-coa")},
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["woo_product_id"], 1512)
        self.assertEqual(calls[0]["mime_type"], "application/pdf")
        self.assertEqual(calls[0]["filename"], "batch-coa.pdf")

    def test_upload_certificate_rejects_unsupported_file_type(self) -> None:
        with self.app.test_client() as client, patch.object(
            auth_middleware,
            "_authenticate_request",
            return_value=None,
        ), patch.object(
            woo,
            "_require_admin",
            return_value=None,
        ), patch.object(
            woo.product_document_repository,
            "upsert_document",
        ) as upsert_document:
            response = client.post(
                "/api/woo/products/1512/certificate-of-analysis",
                data={"file": (BytesIO(b"not a certificate"), "coa.txt")},
                content_type="multipart/form-data",
            )

        self.assertEqual(response.status_code, 415)
        upsert_document.assert_not_called()


if __name__ == "__main__":
    unittest.main()
