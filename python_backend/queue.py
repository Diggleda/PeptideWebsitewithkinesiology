from __future__ import annotations

import os
from typing import Any, Optional

import redis
from rq import Queue

_QUEUE: Queue | None = None


def _redis_url() -> str:
    return (os.environ.get("REDIS_URL") or "redis://127.0.0.1:6379/0").strip()


def get_queue(name: str | None = None) -> Queue:
    global _QUEUE
    if _QUEUE is not None:
        return _QUEUE

    queue_name = (name or os.environ.get("RQ_QUEUE") or "peppr").strip() or "peppr"
    connection = redis.from_url(_redis_url())
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
    connection = redis.from_url(_redis_url())
    pong = connection.ping()
    return {"ok": bool(pong), "redisUrl": _redis_url()}

