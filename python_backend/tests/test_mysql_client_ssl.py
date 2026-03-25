from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from python_backend.database import mysql_client


class MysqlClientSslTests(unittest.TestCase):
    def setUp(self) -> None:
        self._original_config = mysql_client._config
        self._original_pool = mysql_client._pool
        self._original_pool_total = mysql_client._pool_total

    def tearDown(self) -> None:
        mysql_client._config = self._original_config
        mysql_client._pool = self._original_pool
        mysql_client._pool_total = self._original_pool_total

    def _configure(self, ssl_enabled: bool, *, enforce_negotiated: bool = False) -> None:
        mysql_client.configure(
            SimpleNamespace(
                mysql={
                    "enabled": True,
                    "host": "db.example",
                    "port": 3306,
                    "user": "peppr",
                    "password": "secret",
                    "database": "peppr",
                    "connection_limit": 4,
                    "ssl": ssl_enabled,
                    "ssl_require_negotiated": enforce_negotiated,
                    "connect_timeout": 5,
                    "read_timeout": 15,
                    "write_timeout": 15,
                }
            )
        )

    def test_create_connection_enables_ssl_when_configured(self) -> None:
        self._configure(True)

        fake_cursor = unittest.mock.Mock()
        fake_cursor.fetchone.return_value = {"Value": "TLS_AES_256_GCM_SHA384"}
        fake_connection = unittest.mock.Mock()
        fake_connection.cursor.return_value = fake_cursor

        with patch.object(mysql_client.pymysql, "connect", return_value=fake_connection) as connect:
            mysql_client._create_connection()

        self.assertEqual(connect.call_args.kwargs["ssl"], {})

    def test_create_connection_omits_ssl_when_disabled(self) -> None:
        self._configure(False)

        with patch.object(mysql_client.pymysql, "connect", return_value=object()) as connect:
            mysql_client._create_connection()

        self.assertIsNone(connect.call_args.kwargs["ssl"])

    def test_create_connection_warns_when_tls_not_negotiated_and_enforcement_disabled(self) -> None:
        self._configure(True, enforce_negotiated=False)

        fake_cursor = unittest.mock.Mock()
        fake_cursor.fetchone.return_value = {"Value": ""}
        fake_connection = unittest.mock.Mock()
        fake_connection.cursor.return_value = fake_cursor

        with patch.object(mysql_client.pymysql, "connect", return_value=fake_connection):
            connection = mysql_client._create_connection()

        self.assertIs(connection, fake_connection)
        fake_connection.close.assert_not_called()

    def test_create_connection_raises_when_tls_not_negotiated_and_enforced(self) -> None:
        self._configure(True, enforce_negotiated=True)

        fake_cursor = unittest.mock.Mock()
        fake_cursor.fetchone.return_value = {"Value": ""}
        fake_connection = unittest.mock.Mock()
        fake_connection.cursor.return_value = fake_cursor

        with patch.object(mysql_client.pymysql, "connect", return_value=fake_connection):
            with self.assertRaises(mysql_client.MySQLTlsRequiredError):
                mysql_client._create_connection()

        fake_connection.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
