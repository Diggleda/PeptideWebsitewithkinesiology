from __future__ import annotations

import unittest

from python_backend.config import AppConfig
from python_backend import config as config_module
from python_backend import services as services_module


class ServicesConfigFallbackTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original_app_config = services_module._APP_CONFIG
        self._original_config_cache = config_module._CONFIG_CACHE

    def tearDown(self) -> None:
        services_module._APP_CONFIG = self._original_app_config
        config_module._CONFIG_CACHE = self._original_config_cache

    def test_get_config_falls_back_to_global_config_cache(self) -> None:
        services_module._APP_CONFIG = None
        fallback = AppConfig(
            node_env="production",
            port=8000,
            jwt_secret="jwt-secret",
            data_dir=config_module._resolve_path(None, "server-data"),
            cors_allow_list=["https://peppro.net"],
            body_limit="1mb",
            backend_build="test-build",
            log_level="info",
            woo_commerce={},
            ship_engine={},
            stripe={},
            referral={},
            encryption={"key": "test-key"},
            ship_station={},
            ups={},
            mysql={},
            integrations={},
            quotes={},
            frontend_base_url="https://peppro.net",
            password_reset_public_base_url="https://peppro.net/reset",
            password_reset_fallback_email_enabled=True,
            password_reset_debug_response_enabled=False,
            flask_settings={},
        )
        config_module._CONFIG_CACHE = fallback

        resolved = services_module.get_config()

        self.assertIs(resolved, fallback)


if __name__ == "__main__":
    unittest.main()
