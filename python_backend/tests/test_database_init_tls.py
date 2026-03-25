from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from python_backend.database import init_database, mysql_client
import python_backend.database as database_module


class DatabaseInitTlsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original_configured = database_module._CONFIGURED
        database_module._CONFIGURED = False

    def tearDown(self) -> None:
        database_module._CONFIGURED = self._original_configured

    def test_init_database_re_raises_tls_requirement_failures(self) -> None:
        config = SimpleNamespace(mysql={"enabled": True})

        with patch.object(mysql_client, "configure"), \
            patch.object(
                database_module.mysql_schema,
                "ensure_schema",
                side_effect=mysql_client.MySQLTlsRequiredError("tls missing"),
            ):
            with self.assertRaises(mysql_client.MySQLTlsRequiredError):
                init_database(config)

        self.assertTrue(config.mysql["enabled"])


if __name__ == "__main__":
    unittest.main()
