from __future__ import annotations

import argparse
import time

from ..logging_config import configure_logging
from ..services import email_campaign_service
from ..worker_bootstrap import bootstrap


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Send queued TrufusionLabs admin email campaigns")
    parser.add_argument("--once", action="store_true", help="Process one batch and exit")
    parser.add_argument("--limit", type=int, default=25, help="Maximum recipients to process per batch")
    parser.add_argument("--interval", type=float, default=30.0, help="Seconds to sleep between batches")
    parser.add_argument("--throttle", type=float, default=0.25, help="Seconds to sleep between recipients")
    return parser


def main() -> int:
    args = _parser().parse_args()
    config = bootstrap()
    configure_logging(config)
    while True:
        email_campaign_service.process_pending_campaign_emails(
            limit=max(1, min(int(args.limit or 25), 250)),
            throttle_seconds=max(0.0, min(float(args.throttle or 0.0), 10.0)),
        )
        if args.once:
            return 0
        time.sleep(max(5.0, float(args.interval or 30.0)))


if __name__ == "__main__":
    raise SystemExit(main())
