from __future__ import annotations

import argparse
import json

from python_backend.services.catalog_snapshot_service import sync_catalog_snapshots
from python_backend.worker_bootstrap import bootstrap


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the catalog snapshot sync once for use with cron/systemd timers.",
    )
    parser.add_argument(
        "--skip-variations",
        action="store_true",
        help="Sync only product/category snapshots and skip variable-product variation payloads.",
    )
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    bootstrap()
    result = sync_catalog_snapshots(include_variations=not args.skip_variations)
    print(json.dumps(result, indent=2, sort_keys=True))
    if result.get("ok"):
        return 0
    if result.get("skipped"):
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
