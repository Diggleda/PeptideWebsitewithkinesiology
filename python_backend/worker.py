from __future__ import annotations

import os

from rq import Connection, Worker

from .queue import get_queue
from .worker_bootstrap import bootstrap


def main() -> None:
    bootstrap()
    queue = get_queue()
    with Connection(queue.connection):
        # Listen only on the configured queue to keep workloads isolated.
        Worker([queue.name]).work(logging_level=os.environ.get("RQ_LOG_LEVEL") or "INFO")


if __name__ == "__main__":
    main()

