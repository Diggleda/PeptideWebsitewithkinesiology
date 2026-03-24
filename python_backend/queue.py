from __future__ import annotations

import os
from typing import Any, Optional

import redis
from rq import Queue

_QUEUE: Queue | None = None


def _redis_url() -> str:
    return (os.environ.get("REDIS_URL") or "redis://127.0.0.1:6379/0").strip()

def _to_float(value: str | None, fallback: float) -> float:
    raw = (value or "").strip()
    if not raw:
        return fallback
    try:
        parsed = float(raw)
        if parsed <= 0:
            return fallback
        return parsed
    except Exception:
        return fallback


def _redis_client() -> redis.Redis:
    # Prevent requests (including health checks) from hanging indefinitely when Redis is down
    # or blocked by network/firewall issues.
    connect_timeout = _to_float(os.environ.get("REDIS_CONNECT_TIMEOUT_SECONDS"), 1.0)
    socket_timeout = _to_float(os.environ.get("REDIS_SOCKET_TIMEOUT_SECONDS"), 1.0)
    return redis.from_url(
        _redis_url(),
        socket_connect_timeout=connect_timeout,
        socket_timeout=socket_timeout,
        retry_on_timeout=False,
    )


def get_queue(name: str | None = None) -> Queue:
    global _QUEUE
    if _QUEUE is not None:
        return _QUEUE

    queue_name = (name or os.environ.get("RQ_QUEUE") or "peppr").strip() or "peppr"
    connection = _redis_client()
    _QUEUE = Queue(queue_name, connection=connection, default_timeout=int(os.environ.get("RQ_JOB_TIMEOUT_SECONDS") or 300))
    return _QUEUE


def enqueue(
    func: Any,
    *args: Any,
    job_id: str | None = None,
    description: str | None = None,
    ttl_seconds: int | None = None,
    result_ttl_seconds: int | None = None,
    **kwargs: Any,
):
    """
    Enqueue a job onto Redis/RQ.

    - `ttl_seconds`: how long the job can sit in the queue before expiring.
    - `result_ttl_seconds`: how long to keep the result/metadata after finishing.
    """
    queue = get_queue()
    ttl = int(ttl_seconds or os.environ.get("RQ_JOB_TTL_SECONDS") or 3600)
    result_ttl = int(result_ttl_seconds or os.environ.get("RQ_RESULT_TTL_SECONDS") or 86400)
    return queue.enqueue(func, *args, job_id=job_id, description=description, ttl=ttl, result_ttl=result_ttl, **kwargs)


def ping() -> dict[str, Any]:
    connection = _redis_client()
    pong = connection.ping()
    return {"ok": bool(pong), "redisUrl": _redis_url()}
