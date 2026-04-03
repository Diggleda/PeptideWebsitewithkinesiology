from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from python_backend import config


class ConfigRuntimeEnvTests(unittest.TestCase):
    def test_development_fallback_loads_repo_dotenv_without_python_dotenv(self) -> None:
        original_base_dir = config.BASE_DIR
        original_loader = config.load_dotenv
        try:
            with TemporaryDirectory() as tempdir:
                base_dir = Path(tempdir)
                (base_dir / ".env").write_text(
                    "UPS_CLIENT_ID=test-client\nUPS_CLIENT_SECRET=test-secret\nUPS_USE_CIE=true\n",
                    encoding="utf-8",
                )
                config.BASE_DIR = base_dir
                config.load_dotenv = None
                with patch.dict(os.environ, {}, clear=True):
                    config._load_dotenv("development")
                    self.assertEqual(os.environ.get("UPS_CLIENT_ID"), "test-client")
                    self.assertEqual(os.environ.get("UPS_CLIENT_SECRET"), "test-secret")
                    self.assertEqual(os.environ.get("UPS_USE_CIE"), "true")
        finally:
            config.BASE_DIR = original_base_dir
            config.load_dotenv = original_loader

    def test_external_dotenv_override_uses_fallback_loader_without_python_dotenv(self) -> None:
        original_loader = config.load_dotenv
        try:
            with TemporaryDirectory() as tempdir:
                external_path = Path(tempdir) / "peppr-api.env"
                external_path.write_text("UPS_CLIENT_ID=external-client\n", encoding="utf-8")
                config.load_dotenv = None
                with patch.dict(
                    os.environ,
                    {
                        "NODE_ENV": "production",
                        "DOTENV_CONFIG_PATH": str(external_path),
                    },
                    clear=True,
                ):
                    config._load_dotenv("production")
                    self.assertEqual(os.environ.get("UPS_CLIENT_ID"), "external-client")
        finally:
            config.load_dotenv = original_loader

    def test_production_skips_repo_dotenv_without_override(self) -> None:
        calls: list[Path] = []
        original_base_dir = config.BASE_DIR
        original_loader = config.load_dotenv
        try:
            with TemporaryDirectory() as tempdir:
                config.BASE_DIR = Path(tempdir)
                config.load_dotenv = lambda path: calls.append(Path(path))
                with patch.dict(os.environ, {"NODE_ENV": "production"}, clear=True):
                    config._load_dotenv("production")
        finally:
            config.BASE_DIR = original_base_dir
            config.load_dotenv = original_loader

        self.assertEqual(calls, [])

    def test_production_rejects_repo_scoped_dotenv_override(self) -> None:
        with patch.dict(
            os.environ,
            {
                "NODE_ENV": "production",
                "DOTENV_CONFIG_PATH": str(config.BASE_DIR / "local.env"),
            },
            clear=True,
        ):
            with self.assertRaises(RuntimeError):
                config._load_dotenv("production")

    def test_production_accepts_external_dotenv_override(self) -> None:
        calls: list[Path] = []
        original_loader = config.load_dotenv
        try:
            with TemporaryDirectory() as tempdir:
                external_path = Path(tempdir) / "peppr-api.env"
                config.load_dotenv = lambda path: calls.append(Path(path))
                with patch.dict(
                    os.environ,
                    {
                        "NODE_ENV": "production",
                        "DOTENV_CONFIG_PATH": str(external_path),
                    },
                    clear=True,
                ):
                    config._load_dotenv("production")
        finally:
            config.load_dotenv = original_loader

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], external_path)

    def test_load_config_requires_data_encryption_key_in_production(self) -> None:
        with patch.object(config, "_load_dotenv", lambda *_args, **_kwargs: None):
            with patch.dict(
                os.environ,
                {
                    "NODE_ENV": "production",
                    "JWT_SECRET": "x" * 64,
                    "MYSQL_ENABLED": "true",
                    "MYSQL_SSL": "true",
                    "FRONTEND_BASE_URL": "https://prod.example",
                },
                clear=True,
            ):
                with self.assertRaises(RuntimeError):
                    config.load_config()

    def test_load_config_requires_mysql_ssl_in_production(self) -> None:
        with patch.object(config, "_load_dotenv", lambda *_args, **_kwargs: None):
            with patch.dict(
                os.environ,
                {
                    "NODE_ENV": "production",
                    "JWT_SECRET": "x" * 64,
                    "DATA_ENCRYPTION_KEY": "enc-key",
                    "FRONTEND_BASE_URL": "https://prod.example",
                    "MYSQL_ENABLED": "true",
                    "MYSQL_HOST": "db.example",
                },
                clear=True,
            ):
                with self.assertRaises(RuntimeError):
                    config.load_config()

    def test_load_config_allows_local_mysql_without_ssl_in_production(self) -> None:
        with patch.object(config, "_load_dotenv", lambda *_args, **_kwargs: None):
            with patch.dict(
                os.environ,
                {
                    "NODE_ENV": "production",
                    "JWT_SECRET": "x" * 64,
                    "DATA_ENCRYPTION_KEY": "enc-key",
                    "FRONTEND_BASE_URL": "https://prod.example",
                    "MYSQL_ENABLED": "true",
                    "MYSQL_HOST": "127.0.0.1",
                },
                clear=True,
            ):
                loaded = config.load_config()

        self.assertFalse(bool(loaded.mysql.get("ssl")))


if __name__ == "__main__":
    unittest.main()
