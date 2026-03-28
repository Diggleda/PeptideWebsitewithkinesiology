#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence


_HTTP_LOG_PATTERN = re.compile(
    r"HTTP method=(?P<method>[A-Z]+) "
    r"path=(?P<path>\S+) "
    r"route=(?P<route>\S+) "
    r"status=(?P<status>\d{3}) "
    r"duration_ms=(?P<duration_ms>-?\d+(?:\.\d+)?) "
    r"req_bytes=(?P<req_bytes>-?\d+) "
    r"resp_bytes=(?P<resp_bytes>-?\d+) "
    r"client_ip=(?P<client_ip>\S+) "
    r"resp_type=(?P<resp_type>\S+)"
)
_LEGACY_HTTP_LOG_PATTERN = re.compile(
    r"HTTP\s+[A-Z]+\s+\S+\s+->\s+\d{3}\s+\(-?\d+(?:\.\d+)?\s+ms\)"
)


@dataclass(frozen=True)
class RequestLogEntry:
    method: str
    path: str
    route: str
    status: int
    duration_ms: float | None
    req_bytes: int | None
    resp_bytes: int | None
    client_ip: str
    resp_type: str


@dataclass
class AggregateBucket:
    label: str
    count: int = 0
    req_bytes: int = 0
    resp_bytes: int = 0
    duration_ms_total: float = 0.0
    duration_count: int = 0
    status_counts: Counter[int] = field(default_factory=Counter)
    content_types: Counter[str] = field(default_factory=Counter)
    sample_path: str | None = None

    def add(self, entry: RequestLogEntry) -> None:
        self.count += 1
        self.req_bytes += max(0, int(entry.req_bytes or 0))
        self.resp_bytes += max(0, int(entry.resp_bytes or 0))
        if entry.duration_ms is not None and entry.duration_ms >= 0:
            self.duration_ms_total += float(entry.duration_ms)
            self.duration_count += 1
        self.status_counts.update([entry.status])
        self.content_types.update([entry.resp_type or "unknown"])
        if not self.sample_path:
            self.sample_path = entry.path

    @property
    def avg_resp_bytes(self) -> float:
        return float(self.resp_bytes) / float(self.count) if self.count > 0 else 0.0

    @property
    def avg_duration_ms(self) -> float | None:
        if self.duration_count <= 0:
            return None
        return self.duration_ms_total / float(self.duration_count)


def _parse_byte_value(raw: str) -> int | None:
    value = int(raw)
    return value if value >= 0 else None


def _parse_duration_value(raw: str) -> float | None:
    value = float(raw)
    return value if value >= 0 else None


def parse_http_access_line(line: str) -> RequestLogEntry | None:
    match = _HTTP_LOG_PATTERN.search(line)
    if not match:
        return None
    groups = match.groupdict()
    return RequestLogEntry(
        method=groups["method"],
        path=groups["path"],
        route=groups["route"],
        status=int(groups["status"]),
        duration_ms=_parse_duration_value(groups["duration_ms"]),
        req_bytes=_parse_byte_value(groups["req_bytes"]),
        resp_bytes=_parse_byte_value(groups["resp_bytes"]),
        client_ip=groups["client_ip"],
        resp_type=groups["resp_type"],
    )


def _is_diagnostic_route(entry: RequestLogEntry) -> bool:
    route = entry.route or entry.path
    return route.startswith("/api/health") or route == "/api/help"


def _human_bytes(value: int | float) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    amount = float(value)
    index = 0
    while amount >= 1024.0 and index < len(units) - 1:
        amount /= 1024.0
        index += 1
    precision = 0 if index == 0 else 1
    return f"{amount:.{precision}f} {units[index]}"


def _format_counter(counter: Counter[int] | Counter[str], *, limit: int = 4) -> str:
    parts: list[str] = []
    for key, count in counter.most_common(limit):
        parts.append(f"{key}x{count}")
    return ", ".join(parts) if parts else "none"


def _aggregate_by_route(entries: Iterable[RequestLogEntry]) -> list[AggregateBucket]:
    buckets: dict[str, AggregateBucket] = {}
    for entry in entries:
        label = f"{entry.method} {entry.route or entry.path}"
        bucket = buckets.get(label)
        if bucket is None:
            bucket = AggregateBucket(label=label)
            buckets[label] = bucket
        bucket.add(entry)
    return list(buckets.values())


def _aggregate_by_client(entries: Iterable[RequestLogEntry]) -> list[AggregateBucket]:
    buckets: dict[str, AggregateBucket] = {}
    for entry in entries:
        label = entry.client_ip or "unknown"
        bucket = buckets.get(label)
        if bucket is None:
            bucket = AggregateBucket(label=label)
            buckets[label] = bucket
        bucket.add(entry)
    return list(buckets.values())


def build_report(entries: Iterable[RequestLogEntry], *, include_health: bool = False) -> dict[str, object]:
    filtered: list[RequestLogEntry] = []
    for entry in entries:
        if not include_health and _is_diagnostic_route(entry):
            continue
        filtered.append(entry)

    totals = AggregateBucket(label="totals")
    response_types: Counter[str] = Counter()
    for entry in filtered:
        totals.add(entry)
        response_types.update([entry.resp_type or "unknown"])

    routes = sorted(_aggregate_by_route(filtered), key=lambda bucket: (-bucket.resp_bytes, -bucket.count, bucket.label))
    clients = sorted(_aggregate_by_client(filtered), key=lambda bucket: (-bucket.resp_bytes, -bucket.count, bucket.label))
    return {
        "totals": totals,
        "routes": routes,
        "clients": clients,
        "response_types": response_types,
        "entries": filtered,
    }


def _read_input_lines(args: argparse.Namespace) -> list[str]:
    if args.input:
        if args.input == "-":
            return [line.rstrip("\n") for line in sys.stdin]
        path = Path(args.input)
        return path.read_text(encoding="utf-8", errors="ignore").splitlines()

    command = [
        "journalctl",
        "-u",
        args.unit,
        "--since",
        args.since,
        "--no-pager",
        "-o",
        "cat",
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        stderr = (completed.stderr or "").strip() or "journalctl failed"
        raise RuntimeError(
            f"{stderr}. Try running this script with sudo or pass --input with a saved log file."
        )
    return completed.stdout.splitlines()


def _render_bucket_lines(buckets: Sequence[AggregateBucket], *, limit: int, show_sample_path: bool = False) -> list[str]:
    lines: list[str] = []
    if not buckets:
        return ["  none"]
    for index, bucket in enumerate(buckets[:limit], start=1):
        avg_duration = f"{bucket.avg_duration_ms:.1f} ms" if bucket.avg_duration_ms is not None else "n/a"
        avg_resp = _human_bytes(bucket.avg_resp_bytes)
        sample_suffix = f" | sample {bucket.sample_path}" if show_sample_path and bucket.sample_path else ""
        lines.append(
            f"  {index}. {bucket.label} | out {_human_bytes(bucket.resp_bytes)} | in {_human_bytes(bucket.req_bytes)} | "
            f"{bucket.count} req | avg {avg_resp} | avg {avg_duration} | statuses {_format_counter(bucket.status_counts)}{sample_suffix}"
        )
    return lines


def _render_response_types(counter: Counter[str], *, limit: int) -> list[str]:
    lines: list[str] = []
    if not counter:
        return ["  none"]
    for index, (content_type, count) in enumerate(counter.most_common(limit), start=1):
        lines.append(f"  {index}. {content_type} | {count} responses")
    return lines


def diagnose_log_window(lines: Sequence[str]) -> list[str]:
    parsed = 0
    legacy = 0
    httpish = 0
    for line in lines:
        if _HTTP_LOG_PATTERN.search(line):
            parsed += 1
            continue
        if _LEGACY_HTTP_LOG_PATTERN.search(line):
            legacy += 1
            httpish += 1
            continue
        if "HTTP " in line and "/api/" in line:
            httpish += 1

    hints: list[str] = []
    if parsed > 0:
        return hints
    if legacy > 0:
        hints.append(
            f"Found {legacy} legacy HTTP log line(s). The service is probably still running the old request logger, so deploy/restart the backend before using this report."
        )
    elif httpish > 0:
        hints.append(
            f"Found {httpish} HTTP-like line(s), but none matched the new bandwidth format. Inspect the raw journal output to confirm the service log format."
        )
    else:
        hints.append(
            "No API request log lines were found in journald for that window. Either traffic was truly zero, LOG_LEVEL is above INFO, or requests are not reaching the Flask app."
        )
    hints.append(
        'Inspect raw logs with: journalctl -u peppr-api.service --since "15 minutes ago" --no-pager -o cat | tail -n 50'
    )
    return hints


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Summarize PepPro backend request bandwidth from journald logs."
    )
    parser.add_argument(
        "--since",
        default="15 minutes ago",
        help='journalctl window, for example "15 minutes ago" or "1 hour ago"',
    )
    parser.add_argument(
        "--unit",
        default="peppr-api.service",
        help="systemd unit to read from journald",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=10,
        help="number of rows to show in each top list",
    )
    parser.add_argument(
        "--input",
        help="read logs from a file instead of journalctl; use - to read from stdin",
    )
    parser.add_argument(
        "--include-health",
        action="store_true",
        help="include /api/health and /api/help traffic in the totals",
    )
    args = parser.parse_args(argv)

    try:
        lines = _read_input_lines(args)
    except Exception as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    entries = [entry for line in lines if (entry := parse_http_access_line(line)) is not None]
    report = build_report(entries, include_health=args.include_health)
    totals = report["totals"]
    assert isinstance(totals, AggregateBucket)
    routes = report["routes"]
    clients = report["clients"]
    response_types = report["response_types"]
    assert isinstance(routes, list)
    assert isinstance(clients, list)
    assert isinstance(response_types, Counter)

    avg_response = totals.avg_resp_bytes if totals.count > 0 else 0.0
    print(
        f"PepPro bandwidth summary | window {args.since} | requests {totals.count} | "
        f"ingress {_human_bytes(totals.req_bytes)} | egress {_human_bytes(totals.resp_bytes)} | "
        f"avg response {_human_bytes(avg_response)}"
    )
    if not args.include_health:
        print("Excluded /api/health and /api/help. Pass --include-health to include diagnostics traffic.")

    print("\nTop routes by egress")
    for line in _render_bucket_lines(routes, limit=max(1, args.limit), show_sample_path=True):
        print(line)

    print("\nTop clients by egress")
    for line in _render_bucket_lines(clients, limit=max(1, args.limit)):
        print(line)

    print("\nTop response types")
    for line in _render_response_types(response_types, limit=max(1, args.limit)):
        print(line)

    if totals.count == 0:
        hints = diagnose_log_window(lines)
        if hints:
            print("\nDiagnostics")
            for hint in hints:
                print(f"  - {hint}")
        print("\nNo matching request log entries were found in that window.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
