from __future__ import annotations

import threading
from queue import Empty, Queue
from contextlib import contextmanager
from typing import Callable, Dict, Iterator, Optional, TypeVar

import pymysql
from pymysql.cursors import DictCursor

from ..config import AppConfig

_config: Optional[AppConfig] = None
_pool: Optional[Queue[pymysql.connections.Connection]] = None
_pool_lock = threading.Lock()
_pool_total = 0
_RetryResult = TypeVar("_RetryResult")


def configure(config: AppConfig) -> None:
    global _config
    global _pool
    global _pool_total
    _config = config
    with _pool_lock:
        _pool_total = 0
        limit = _pool_limit()
        _pool = Queue(maxsize=limit)

def _pool_limit() -> int:
    if not _config:
        raise RuntimeError("MySQL configuration has not been initialised")
    mysql_config = _config.mysql
    limit = int(mysql_config.get("connection_limit", 3) or 3)
    return max(1, min(limit, 32))


def _create_connection() -> pymysql.connections.Connection:
    if not _config:
        raise RuntimeError("MySQL configuration has not been initialised")
    mysql_config = _config.mysql

    ssl_disabled = not mysql_config.get("ssl")
    ssl_params = None
    if not ssl_disabled:
        ssl_params = {"ssl": {}}

    return pymysql.connect(
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


def _discard_connection(connection: Optional[pymysql.connections.Connection]) -> None:
    global _pool_total
    if not connection:
        return
    try:
        connection.close()
    except Exception:
        pass
    with _pool_lock:
        _pool_total = max(0, _pool_total - 1)


def _acquire_connection() -> pymysql.connections.Connection:
    global _pool_total
    if not _config:
        raise RuntimeError("MySQL configuration has not been initialised")
    if _pool is None:
        configure(_config)
    assert _pool is not None

    connection: Optional[pymysql.connections.Connection] = None
    try:
        connection = _pool.get_nowait()
    except Empty:
        pass

    if connection is None:
        with _pool_lock:
            limit = _pool_limit()
            if _pool_total < limit:
                _pool_total += 1
                try:
                    connection = _create_connection()
                except Exception:
                    _pool_total = max(0, _pool_total - 1)
                    raise

    if connection is None:
        # Pool saturated; wait briefly for a free slot.
        try:
            connection = _pool.get(timeout=max(0.25, min(2.0, float(_config.mysql.get("connect_timeout", 5) or 5))))
        except Empty as exc:
            raise pymysql.err.OperationalError(1203, "MySQL connection pool exhausted") from exc

    if not connection.open:
        _discard_connection(connection)
        with _pool_lock:
            _pool_total += 1
        connection = _create_connection()

    try:
        connection.ping(reconnect=True)
    except pymysql.err.Error:
        _discard_connection(connection)
        with _pool_lock:
            _pool_total += 1
        connection = _create_connection()

    return connection


def _release_connection(connection: Optional[pymysql.connections.Connection]) -> None:
    if connection is None:
        return
    if not connection.open:
        _discard_connection(connection)
        return
    if _pool is None:
        _discard_connection(connection)
        return
    try:
        _pool.put_nowait(connection)
    except Exception:
        _discard_connection(connection)


@contextmanager
def cursor() -> Iterator[pymysql.cursors.DictCursor]:
    connection: Optional[pymysql.connections.Connection] = _acquire_connection()
    cur = connection.cursor()
    try:
        yield cur
        connection.commit()
    except Exception as exc:
        try:
            connection.rollback()
        finally:
            pass
        if isinstance(exc, (pymysql.err.OperationalError, pymysql.err.InterfaceError)):
            _discard_connection(connection)
            connection = None
        raise
    finally:
        cur.close()
        _release_connection(connection)


def _should_retry(error: Exception) -> bool:
    if isinstance(error, pymysql.err.OperationalError):
        err_code = error.args[0] if error.args else None
        return err_code in {2006, 2013}
    if isinstance(error, pymysql.err.InterfaceError):
        err_code = error.args[0] if error.args else None
        return err_code in {0, 2006, 2013}
    return False


def _run_with_retry(operation: Callable[[], _RetryResult]) -> _RetryResult:
    try:
        return operation()
    except (pymysql.err.OperationalError, pymysql.err.InterfaceError) as error:
        if not _should_retry(error):
            raise
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
