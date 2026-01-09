from __future__ import annotations

import os
import threading
from typing import Any, Optional, Tuple, Union

import requests

DEFAULT_CONNECT_TIMEOUT_SECONDS = float(
    os.environ.get("HTTP_CONNECT_TIMEOUT_SECONDS", "3.5").strip() or 3.5
)
DEFAULT_READ_TIMEOUT_SECONDS = float(
    os.environ.get("HTTP_READ_TIMEOUT_SECONDS", "12").strip() or 12
)
DEFAULT_TIMEOUT: Tuple[float, float] = (
    DEFAULT_CONNECT_TIMEOUT_SECONDS,
    DEFAULT_READ_TIMEOUT_SECONDS,
)

_HTTP_CONCURRENCY = int(os.environ.get("HTTP_CONCURRENCY", "4").strip() or 4)
_HTTP_CONCURRENCY = max(1, min(_HTTP_CONCURRENCY, 16))
_http_semaphore = threading.BoundedSemaphore(_HTTP_CONCURRENCY)

_ACQUIRE_TIMEOUT_SECONDS = float(
    os.environ.get("HTTP_ACQUIRE_TIMEOUT_SECONDS", "15").strip() or 15
)


TimeoutArg = Union[None, float, int, Tuple[float, float]]


def request_with_session(
    session: requests.Session, method: str, url: str, *, timeout: TimeoutArg = None, **kwargs: Any
) -> requests.Response:
    """
    Like `request()`, but uses an existing requests.Session (for cookies/connection pooling).
    """
    effective_timeout: TimeoutArg = timeout
    if effective_timeout is None:
        effective_timeout = DEFAULT_TIMEOUT

    acquired = _http_semaphore.acquire(timeout=_ACQUIRE_TIMEOUT_SECONDS)
    if not acquired:
        raise requests.Timeout("Outbound HTTP concurrency limit reached")
    try:
        return session.request(method, url, timeout=effective_timeout, **kwargs)
    finally:
        try:
            _http_semaphore.release()
        except ValueError:
            pass


def request(method: str, url: str, *, timeout: TimeoutArg = None, **kwargs: Any) -> requests.Response:
    """
    Small wrapper around requests.request() that:
      - enforces sane default timeouts
      - limits concurrent outbound HTTP per-process
    """
    effective_timeout: TimeoutArg = timeout
    if effective_timeout is None:
        effective_timeout = DEFAULT_TIMEOUT

    acquired = _http_semaphore.acquire(timeout=_ACQUIRE_TIMEOUT_SECONDS)
    if not acquired:
        raise requests.Timeout("Outbound HTTP concurrency limit reached")
    try:
        return requests.request(method, url, timeout=effective_timeout, **kwargs)
    finally:
        try:
            _http_semaphore.release()
        except ValueError:
            pass


def get(url: str, *, timeout: TimeoutArg = None, **kwargs: Any) -> requests.Response:
    return request("GET", url, timeout=timeout, **kwargs)


def post(url: str, *, timeout: TimeoutArg = None, **kwargs: Any) -> requests.Response:
    return request("POST", url, timeout=timeout, **kwargs)
