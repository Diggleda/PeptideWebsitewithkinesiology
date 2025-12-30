from __future__ import annotations

import threading
from contextlib import contextmanager
from typing import Callable, Dict, Iterator, Optional, TypeVar

import pymysql
from pymysql.cursors import DictCursor

from ..config import AppConfig

_config: Optional[AppConfig] = None
_thread_local = threading.local()
_RetryResult = TypeVar("_RetryResult")


def configure(config: AppConfig) -> None:
    global _config
    _config = config


def _get_connection() -> pymysql.connections.Connection:
    if not _config:
        raise RuntimeError("MySQL configuration has not been initialised")

    connection = getattr(_thread_local, "connection", None)
    if connection and connection.open:
        try:
            connection.ping(reconnect=True)
            return connection
        except pymysql.err.Error:
            _reset_connection()

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
        connect_timeout=max(1, int(mysql_config.get("connect_timeout", 5) or 5)),
        read_timeout=max(1, int(mysql_config.get("read_timeout", 15) or 15)),
        write_timeout=max(1, int(mysql_config.get("write_timeout", 15) or 15)),
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


def _should_retry(error: Exception) -> bool:
    if isinstance(error, pymysql.err.OperationalError):
        err_code = error.args[0] if error.args else None
        return err_code in {2006, 2013}
    if isinstance(error, pymysql.err.InterfaceError):
        err_code = error.args[0] if error.args else None
        return err_code in {0, 2006, 2013}
    return False


def _reset_connection() -> None:
    connection = getattr(_thread_local, "connection", None)
    if connection:
        try:
            connection.close()
        except Exception:
            pass
    _thread_local.connection = None


def _run_with_retry(operation: Callable[[], _RetryResult]) -> _RetryResult:
    try:
        return operation()
    except (pymysql.err.OperationalError, pymysql.err.InterfaceError) as error:
        if not _should_retry(error):
            raise
        _reset_connection()
        return operation()


def execute(query: str, params: Optional[Dict] = None) -> int:
    return _run_with_retry(lambda: _execute(query, params))


def fetch_one(query: str, params: Optional[Dict] = None) -> Optional[Dict]:
    return _run_with_retry(lambda: _fetch_one(query, params))


def fetch_all(query: str, params: Optional[Dict] = None) -> list[Dict]:
    return _run_with_retry(lambda: _fetch_all(query, params))


def _execute(query: str, params: Optional[Dict]) -> int:
    with cursor() as cur:
        return cur.execute(query, params or {})


def _fetch_one(query: str, params: Optional[Dict]) -> Optional[Dict]:
    with cursor() as cur:
        cur.execute(query, params or {})
        return cur.fetchone()


def _fetch_all(query: str, params: Optional[Dict]) -> list[Dict]:
    with cursor() as cur:
        cur.execute(query, params or {})
        return cur.fetchall()
