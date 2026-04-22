from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Iterable

from python_backend.config import load_config
from python_backend.services import configure_services
from python_backend.services import email_service

DEFAULT_RECIPIENT = "petergibbons7@icloud.com"
STATUSES = ("shipped", "out_for_delivery", "delivered")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Send PepPro shipping lifecycle test emails through the backend mailer.",
    )
    parser.add_argument(
        "--recipient",
        default=DEFAULT_RECIPIENT,
        help=f"Recipient email address. Defaults to {DEFAULT_RECIPIENT}.",
    )
    parser.add_argument(
        "--status",
        choices=STATUSES,
        default="shipped",
        help="Shipping lifecycle status to test.",
    )
    parser.add_argument(
        "--all-statuses",
        action="store_true",
        help="Send one test email for shipped, out_for_delivery, and delivered.",
    )
    parser.add_argument(
        "--env-file",
        default="",
        help="Optional backend env file path, for example /etc/peppr-api.env.",
    )
    parser.add_argument(
        "--order-number",
        default="TEST-EMAIL",
        help="Order number label shown in the test email.",
    )
    parser.add_argument(
        "--tracking-number",
        default="1ZTESTEMAIL000000",
        help="Tracking number label shown in the test email.",
    )
    parser.add_argument(
        "--carrier",
        default="ups",
        help="Carrier code used for the tracking link.",
    )
    parser.add_argument(
        "--smtp-only",
        action="store_true",
        help="Ignore SENDGRID_API_KEY/SENDGRID_API_TOKEN for this test and force the SMTP path.",
    )
    return parser


def _configure(env_file: str, *, smtp_only: bool = False) -> None:
    if env_file:
        candidate = Path(env_file).expanduser()
        os.environ["DOTENV_CONFIG_PATH"] = str(candidate)
        if not candidate.exists():
            raise FileNotFoundError(f"Env file does not exist: {candidate}")
    config = load_config()
    if smtp_only:
        os.environ.pop("SENDGRID_API_KEY", None)
        os.environ.pop("SENDGRID_API_TOKEN", None)
    configure_services(config)


def _provider_summary() -> dict[str, object]:
    smtp = {
        "host": os.environ.get("SMTP_HOST") or os.environ.get("EMAIL_HOST") or None,
        "port": os.environ.get("SMTP_PORT") or os.environ.get("EMAIL_PORT") or None,
        "ssl": os.environ.get("SMTP_SSL") or os.environ.get("EMAIL_SSL") or None,
        "starttls": os.environ.get("SMTP_STARTTLS") or os.environ.get("EMAIL_STARTTLS") or None,
        "auth": os.environ.get("SMTP_AUTH") or os.environ.get("EMAIL_AUTH") or None,
        "hasUser": bool(os.environ.get("SMTP_USER") or os.environ.get("EMAIL_USER")),
        "hasPass": bool(os.environ.get("SMTP_PASS") or os.environ.get("EMAIL_PASS")),
    }
    return {
        "nodeEnv": os.environ.get("NODE_ENV") or None,
        "mailFrom": os.environ.get("MAIL_FROM") or "PepPro <support@peppro.net>",
        "hasSendGridKey": bool(os.environ.get("SENDGRID_API_KEY") or os.environ.get("SENDGRID_API_TOKEN")),
        "smtp": smtp,
    }


def _statuses(args: argparse.Namespace) -> Iterable[str]:
    return STATUSES if args.all_statuses else (args.status,)


def main() -> int:
    args = _build_parser().parse_args()
    _configure(args.env_file, smtp_only=args.smtp_only)

    sent: list[str] = []
    for status in _statuses(args):
        email_service.send_order_shipping_status_email(
            args.recipient,
            status=status,
            customer_name="PepPro Test",
            order_number=args.order_number,
            tracking_number=args.tracking_number,
            carrier_code=args.carrier,
            delivery_label="Test delivery window",
        )
        sent.append(status)

    print(
        json.dumps(
            {
                "ok": True,
                "recipient": args.recipient,
                "sentStatuses": sent,
                "provider": _provider_summary(),
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
