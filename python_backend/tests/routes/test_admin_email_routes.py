from __future__ import annotations

import unittest
import re
import sys
import types
from urllib.parse import urlparse
from unittest.mock import patch

fake_pymysql = types.ModuleType("pymysql")
fake_pymysql.connect = lambda *args, **kwargs: None
fake_pymysql.connections = types.SimpleNamespace(Connection=object)
fake_pymysql.err = types.SimpleNamespace(OperationalError=Exception, InterfaceError=Exception)
fake_pymysql_cursors = types.ModuleType("pymysql.cursors")
fake_pymysql_cursors.DictCursor = object
fake_pymysql.cursors = fake_pymysql_cursors
sys.modules.setdefault("pymysql", fake_pymysql)
sys.modules.setdefault("pymysql.cursors", fake_pymysql_cursors)

fake_crypto = types.ModuleType("cryptography")
fake_hazmat = types.ModuleType("cryptography.hazmat")
fake_primitives = types.ModuleType("cryptography.hazmat.primitives")
fake_ciphers = types.ModuleType("cryptography.hazmat.primitives.ciphers")
fake_aead = types.ModuleType("cryptography.hazmat.primitives.ciphers.aead")


class _FakeAESGCM:
    def __init__(self, _key):
        pass

    def encrypt(self, _nonce, data, _aad):
        return data

    def decrypt(self, _nonce, data, _aad):
        return data


fake_aead.AESGCM = _FakeAESGCM
sys.modules.setdefault("cryptography", fake_crypto)
sys.modules.setdefault("cryptography.hazmat", fake_hazmat)
sys.modules.setdefault("cryptography.hazmat.primitives", fake_primitives)
sys.modules.setdefault("cryptography.hazmat.primitives.ciphers", fake_ciphers)
sys.modules.setdefault("cryptography.hazmat.primitives.ciphers.aead", fake_aead)

try:
    from flask import Flask
    from python_backend.middleware import auth as auth_middleware
    from python_backend.routes import admin_email
    _IMPORT_ERROR = None
except Exception as exc:  # pragma: no cover - local test env may not include Flask stack
    Flask = None
    auth_middleware = None
    admin_email = None
    _IMPORT_ERROR = exc


class AdminEmailRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        if Flask is None or auth_middleware is None or admin_email is None:
            self.skipTest(f"admin email route test requires Flask backend dependencies: {_IMPORT_ERROR}")
        self.app = Flask(__name__)
        self.app.register_blueprint(admin_email.blueprint)

    def test_templates_route_requires_admin_and_returns_templates(self) -> None:
        with self.app.test_client() as client, patch.object(
            auth_middleware,
            "_authenticate_request",
            return_value=None,
        ), patch.object(
            admin_email,
            "_current_admin",
            return_value={"id": "admin_1", "role": "admin"},
        ):
            response = client.get("/api/admin/email/templates")

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload["templates"][0]["id"], "delegate_links_announcement")

    def test_preview_route_returns_rendered_html(self) -> None:
        with self.app.test_client() as client, patch.object(
            auth_middleware,
            "_authenticate_request",
            return_value=None,
        ), patch.object(
            admin_email,
            "_current_admin",
            return_value={"id": "admin_1", "role": "admin"},
        ), patch.object(admin_email.email_campaign_service.email_campaign_repository, "log_event"):
            response = client.get(
                "/api/admin/email/templates/delegate_links_announcement/preview?doctor_name=Dr.%20Ada"
            )

        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertIn("Delegate Links: Extending Physician Reach", payload["html"])
        self.assertIn("Dr. Ada", payload["html"])
        self.assertIn("/api/admin/email/assets/trufusion-logo?token=", payload["html"])
        self.assertNotIn('src="cid:trufusion-logo"', payload["html"])

        match = re.search(r'https?://[^"]+/api/admin/email/assets/trufusion-logo\?token=[^"]+', payload["html"])
        self.assertIsNotNone(match)
        parsed = urlparse(match.group(0))
        asset_response = client.get(f"{parsed.path}?{parsed.query}")
        self.assertEqual(asset_response.status_code, 200)
        self.assertEqual(asset_response.mimetype, "image/png")
        self.assertGreater(len(asset_response.get_data()), 0)

    def test_unsubscribe_route_supports_json_and_redirect(self) -> None:
        with self.app.test_client() as client, patch.object(
            admin_email.email_campaign_service,
            "unsubscribe",
            return_value={"ok": True, "email": "doctor@example.com"},
        ) as unsubscribe, patch.object(
            admin_email.email_campaign_service,
            "unsubscribe_landing_url",
            return_value="https://www.trufusionlabs.com/?email_unsubscribed=1",
        ):
            json_response = client.get(
                "/api/admin/email/unsubscribe?email=doctor%40example.com&token=tok&format=json",
                headers={"Accept": "application/json"},
            )
            redirect_response = client.get(
                "/api/admin/email/unsubscribe?email=doctor%40example.com&token=tok",
            )

        self.assertEqual(json_response.status_code, 200)
        self.assertTrue(json_response.get_json()["ok"])
        self.assertEqual(redirect_response.status_code, 302)
        self.assertEqual(redirect_response.headers["Location"], "https://www.trufusionlabs.com/?email_unsubscribed=1")
        self.assertEqual(unsubscribe.call_count, 2)

    def test_campaign_create_route_passes_admin_context(self) -> None:
        with self.app.test_client() as client, patch.object(
            auth_middleware,
            "_authenticate_request",
            return_value=None,
        ), patch.object(
            admin_email,
            "_current_admin",
            return_value={"id": "admin_1", "role": "admin"},
        ), patch.object(
            admin_email.email_campaign_service,
            "create_campaign",
            return_value={"campaign": {"id": "emc_1"}},
        ) as create_campaign:
            response = client.post(
                "/api/admin/email/campaigns",
                json={"templateId": "delegate_links_announcement"},
            )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["campaign"]["id"], "emc_1")
        self.assertEqual(create_campaign.call_args.kwargs["admin"]["id"], "admin_1")

    def test_recipient_estimate_route_requires_admin_context(self) -> None:
        with self.app.test_client() as client, patch.object(
            auth_middleware,
            "_authenticate_request",
            return_value=None,
        ), patch.object(
            admin_email,
            "_current_admin",
            return_value={"id": "admin_1", "role": "admin"},
        ), patch.object(
            admin_email.email_campaign_service,
            "estimate_recipients",
            return_value={"recipientCount": 42},
        ) as estimate_recipients:
            response = client.post(
                "/api/admin/email/recipients/estimate",
                json={
                    "templateId": "delegate_links_announcement",
                    "recipientSelection": {"mode": "all_verified_physicians"},
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()["recipientCount"], 42)
        self.assertEqual(
            estimate_recipients.call_args.args[0]["recipientSelection"]["mode"],
            "all_verified_physicians",
        )

    def test_campaign_delete_route_passes_admin_context(self) -> None:
        with self.app.test_client() as client, patch.object(
            auth_middleware,
            "_authenticate_request",
            return_value=None,
        ), patch.object(
            admin_email,
            "_current_admin",
            return_value={"id": "admin_1", "role": "admin"},
        ), patch.object(
            admin_email.email_campaign_service,
            "delete_draft_campaign",
            return_value={"deleted": True},
        ) as delete_campaign:
            response = client.delete("/api/admin/email/campaigns/emc_1")

        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.get_json()["deleted"])
        self.assertEqual(delete_campaign.call_args.args[0], "emc_1")
        self.assertEqual(delete_campaign.call_args.kwargs["admin"]["id"], "admin_1")


if __name__ == "__main__":
    unittest.main()
