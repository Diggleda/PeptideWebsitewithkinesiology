from __future__ import annotations

import sys
import types
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from flask import Flask, g


if "pymysql" not in sys.modules:
    fake_pymysql = types.ModuleType("pymysql")
    fake_pymysql.connect = lambda *args, **kwargs: None
    fake_pymysql.connections = types.SimpleNamespace(Connection=object)
    fake_pymysql.err = types.SimpleNamespace(OperationalError=Exception, InterfaceError=Exception)
    fake_pymysql_cursors = types.ModuleType("pymysql.cursors")
    fake_pymysql_cursors.DictCursor = object
    fake_pymysql.cursors = fake_pymysql_cursors
    sys.modules["pymysql"] = fake_pymysql
    sys.modules["pymysql.cursors"] = fake_pymysql_cursors


from python_backend.routes import delegation, events, orders, referrals, settings, woo
from python_backend.services import resource_version_service
from python_backend.utils.auth_cookies import MEDIA_AUTH_COOKIE_NAME


class ResourceVersionServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        resource_version_service._MEMORY_VERSIONS.clear()

    def tearDown(self) -> None:
        resource_version_service._MEMORY_VERSIONS.clear()

    def test_memory_bump_and_filtered_read(self) -> None:
        config = types.SimpleNamespace(mysql={"enabled": False})

        with patch.object(resource_version_service, "get_config", return_value=config):
            first = resource_version_service.bump("orders")
            second = resource_version_service.bump("orders")
            rows = resource_version_service.get_versions(["orders", "settings"])

        self.assertEqual(first["version"], 1)
        self.assertEqual(second["version"], 2)
        self.assertEqual(rows["orders"]["version"], 2)
        self.assertNotIn("settings", rows)

    def test_mysql_bump_upserts_and_reads_row(self) -> None:
        config = types.SimpleNamespace(mysql={"enabled": True})

        with patch.object(resource_version_service, "get_config", return_value=config), patch.object(
            resource_version_service.mysql_client,
            "execute",
            return_value=1,
        ) as execute, patch.object(
            resource_version_service.mysql_client,
            "fetch_one",
            return_value={
                "resource_name": "orders",
                "version": 7,
                "updated_at": datetime(2026, 5, 22, tzinfo=timezone.utc),
            },
        ):
            row = resource_version_service.bump("orders", metadata={"source": "test"})

        self.assertEqual(row["resource"], "orders")
        self.assertEqual(row["version"], 7)
        self.assertIn("ON DUPLICATE KEY UPDATE", execute.call_args.args[0])
        self.assertEqual(execute.call_args.args[1]["resource_name"], "orders")


class ResourceVersionRouteTests(unittest.TestCase):
    def _auth_patches(self):
        now = datetime.now(timezone.utc).isoformat()
        payload = {"id": "user-1", "role": "admin", "sid": "session-1", "iat": now}
        session = {"sessionId": "session-1", "lastLoginAt": now, "lastInteractionAt": now}
        return (
            patch(
                "python_backend.middleware.auth.get_config",
                return_value=types.SimpleNamespace(jwt_secret="test-secret"),
            ),
            patch("python_backend.middleware.auth.jwt.decode", return_value=payload),
            patch(
                "python_backend.middleware.auth.user_repository.find_session_by_id",
                return_value=session,
            ),
            patch("python_backend.middleware.auth.presence_service.snapshot", return_value={}),
        )

    def _events_app(self) -> Flask:
        app = Flask(__name__)
        app.config["TESTING"] = True
        app.register_blueprint(events.blueprint)
        return app

    def test_resource_versions_endpoint_returns_filtered_versions(self) -> None:
        app = self._events_app()
        patches = self._auth_patches()
        with app.test_client() as client, patches[0], patches[1], patches[2], patches[3], patch.object(
            events.resource_version_service,
            "get_versions",
            return_value={"orders": {"resource": "orders", "version": 5, "updatedAt": "2026-05-22T00:00:00Z"}},
        ) as get_versions:
            response = client.get(
                "/api/resource-versions?resources=orders",
                headers={"Authorization": "Bearer test-token"},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["resources"]["orders"]["version"], 5)
        get_versions.assert_called_once_with(["orders"])

    def test_events_endpoint_accepts_media_cookie_and_streams_heartbeat_and_change(self) -> None:
        app = self._events_app()
        initial = {"orders": {"resource": "orders", "version": 1, "updatedAt": "2026-05-22T00:00:00Z"}}
        changed = {"orders": {"resource": "orders", "version": 2, "updatedAt": "2026-05-22T00:00:02Z"}}
        patches = self._auth_patches()

        with app.test_client() as client, patches[0], patches[1], patches[2], patches[3], patch.object(
            events,
            "_HEARTBEAT_SECONDS",
            0,
        ), patch.object(events.resource_version_service, "get_versions", side_effect=[initial, changed]):
            try:
                client.set_cookie(MEDIA_AUTH_COOKIE_NAME, "test-token", path="/api")
            except TypeError:
                client.set_cookie("localhost", MEDIA_AUTH_COOKIE_NAME, "test-token", path="/api")
            response = client.get("/api/events?resources=orders", buffered=False)
            chunks = [next(response.response).decode("utf-8") for _ in range(3)]
            response.close()

        self.assertEqual(response.status_code, 200)
        self.assertIn("text/event-stream", response.headers.get("Content-Type", ""))
        self.assertEqual(response.headers.get("Cache-Control"), "no-store")
        self.assertEqual(chunks[0], ": connected\n\n")
        self.assertTrue(chunks[1].startswith(": heartbeat "))
        self.assertIn("event: orders.changed", chunks[2])
        self.assertIn('"resource":"orders"', chunks[2])
        self.assertIn('"version":2', chunks[2])


class ResourceVersionMutationBumpTests(unittest.TestCase):
    def _call_route(self, func, path: str, *, method: str = "POST", json: dict | None = None, user: dict | None = None, args=()):
        app = Flask(__name__)
        app.config["TESTING"] = True
        with app.test_request_context(path, method=method, json=json if json is not None else {}):
            g.current_user = user or {"id": "user-1", "role": "admin"}
            return getattr(func, "__wrapped__", func)(*args)

    def test_order_cancel_bumps_orders(self) -> None:
        with patch.object(orders.order_service, "cancel_order", return_value={"ok": True}), patch.object(
            orders.resource_version_service,
            "bump_many_safe",
        ) as bump:
            self._call_route(
                orders.cancel_order,
                "/api/orders/order-1/cancel",
                json={"reason": "test"},
                user={"id": "doctor-1", "role": "doctor"},
                args=("order-1",),
            )

        self.assertEqual(bump.call_args.args[0], ("orders",))
        self.assertEqual(bump.call_args.kwargs["metadata"]["source"], "orders.cancel")

    def test_patient_link_create_bumps_patient_links(self) -> None:
        with patch.object(
            delegation.delegation_service,
            "create_link",
            return_value={"token": "link-1", "linkType": "delegate"},
        ), patch.object(
            delegation.settings_service,
            "get_settings",
            return_value={"patientLinksEnabled": True},
        ), patch.object(delegation.usage_tracking_service, "track_event"), patch.object(
            delegation.resource_version_service,
            "bump_many_safe",
        ) as bump:
            self._call_route(
                delegation.create_link,
                "/api/delegation/links",
                json={},
                user={"id": "doctor-1", "role": "doctor"},
            )

        self.assertEqual(bump.call_args.args[0], ("patient-links",))
        self.assertEqual(bump.call_args.kwargs["metadata"]["source"], "delegation.create")

    def test_referral_submit_bumps_referrals(self) -> None:
        doctor = {"id": "doctor-1", "role": "doctor", "salesRepId": "rep-1"}
        with patch.object(referrals.user_repository, "find_by_id", return_value=doctor), patch.object(
            referrals.referral_service,
            "record_referral_submission",
            return_value={"id": "ref-1"},
        ), patch.object(referrals.resource_version_service, "bump_safe") as bump:
            self._call_route(
                referrals.submit_referral,
                "/api/referrals/doctor/referrals",
                json={"contactName": "Jane Example", "contactEmail": "jane@example.com"},
                user={"id": "doctor-1", "role": "doctor"},
            )

        bump.assert_called_once()
        self.assertEqual(bump.call_args.args[0], "referrals")
        self.assertEqual(bump.call_args.kwargs["metadata"]["source"], "referrals.doctor.create")

    def test_settings_update_bumps_settings(self) -> None:
        with patch.object(settings, "get_config", return_value=types.SimpleNamespace(mysql={"enabled": False})), patch.object(
            settings.settings_service,
            "update_settings",
            return_value={"shopEnabled": False},
        ), patch.object(
            settings.resource_version_service,
            "bump_many_safe",
        ) as bump:
            self._call_route(
                settings.update_shop,
                "/api/settings/shop",
                method="PUT",
                json={"enabled": False},
                user={"id": "admin-1", "role": "admin"},
            )

        self.assertEqual(bump.call_args.args[0], ("settings",))
        self.assertEqual(bump.call_args.kwargs["metadata"]["source"], "settings.shop")

    def test_catalog_coa_delete_bumps_catalog_when_payload_existed(self) -> None:
        with patch.object(
            woo.product_document_repository,
            "get_document_metadata",
            return_value={"sha256": "abc", "data_bytes": 12},
        ), patch.object(woo.product_document_repository, "clear_document_payload"), patch.object(
            woo.resource_version_service,
            "bump_safe",
        ) as bump:
            self._call_route(
                woo.delete_certificate_of_analysis,
                "/api/woo/products/123/certificate-of-analysis",
                method="DELETE",
                user={"id": "admin-1", "role": "admin"},
                args=(123,),
            )

        bump.assert_called_once()
        self.assertEqual(bump.call_args.args[0], "catalog")
        self.assertEqual(bump.call_args.kwargs["metadata"]["source"], "woo.coa.delete")


if __name__ == "__main__":
    unittest.main()
