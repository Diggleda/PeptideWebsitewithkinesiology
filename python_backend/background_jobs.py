from __future__ import annotations

import signal
import threading
import time

from .logging_config import configure_logging
from .services import quotes_service
from .worker_bootstrap import bootstrap
from .services.patient_links_sweep_service import start_patient_links_sweep
from .services.presence_sweep_service import start_presence_sweep
from .services.product_document_sync_service import start_product_document_sync
from .services.shipstation_status_sync_service import start_shipstation_status_sync
from .services.ups_status_sync_service import start_ups_status_sync

_STOP_EVENT = threading.Event()


def _install_signal_handlers() -> None:
    def _handle_signal(_signum, _frame) -> None:
        _STOP_EVENT.set()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)


def main() -> int:
    config = bootstrap()
    configure_logging(config)
    _install_signal_handlers()

    try:
        quotes_service.prime_daily_quote_cache()
    except Exception:
        pass

    start_product_document_sync(force=True)
    start_shipstation_status_sync(force=True)
    start_ups_status_sync(force=True)
    start_presence_sweep(force=True)
    start_patient_links_sweep(force=True)

    while not _STOP_EVENT.wait(timeout=60.0):
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
