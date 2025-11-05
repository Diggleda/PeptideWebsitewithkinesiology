from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Dict, Iterator, Optional

import pymysql
from pymysql.cursors import DictCursor

from ..config import AppConfig

_config: Optional[AppConfig] = None
_thread_local = threading.local()


def configure(config: AppConfig) -> None:
    global _config
    _config = config


def _get_connection() -> pymysql.connections.Connection:
    if not _config:
        raise RuntimeError("MySQL configuration has not been initialised")

    connection = getattr(_thread_local, "connection", None)
    if connection and connection.open:
        return connection

    mysql_config = _config.mysql

    ssl_disabled = not mysql_config.get("ssl")
    ssl_params = None
    if not ssl_disabled:
        ssl_params = {"ssl": {}}

    connection = pymysql.connect(
        host=mysql_config.get("host"),
        port=int(mysql_config.get("port", 3306)),
        user=mysql_config.get("user"),
        password=mysql_config.get("password"),
        database=mysql_config.get("database"),
        cursorclass=DictCursor,
        autocommit=False,
        charset="utf8mb4",
        ssl=ssl_params,
    )

    _thread_local.connection = connection
    return connection


@contextmanager
def cursor() -> Iterator[pymysql.cursors.DictCursor]:
    connection = _get_connection()
    cur = connection.cursor()
    try:
        yield cur
        connection.commit()
    except Exception:
        try:
            connection.rollback()
        finally:
            pass
        raise
    finally:
        cur.close()


def execute(query: str, params: Optional[Dict] = None) -> int:
    with cursor() as cur:
        return cur.execute(query, params or {})


def fetch_one(query: str, params: Optional[Dict] = None) -> Optional[Dict]:
    with cursor() as cur:
        cur.execute(query, params or {})
        return cur.fetchone()


def fetch_all(query: str, params: Optional[Dict] = None) -> list[Dict]:
    with cursor() as cur:
        cur.execute(query, params or {})
        return cur.fetchall()
