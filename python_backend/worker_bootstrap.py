from __future__ import annotations

import threading
from typing import Optional

from .config import AppConfig, load_config
from .database import init_database
from .logging_config import configure_logging
from .services import configure_services
from .storage import init_storage

_LOCK = threading.Lock()
_BOOTSTRAPPED: bool = False
_CONFIG: Optional[AppConfig] = None


def bootstrap() -> AppConfig:
    """
    Initialize config/services/db for non-HTTP processes (RQ workers, scripts).
    Safe to call multiple times.
    """
    global _BOOTSTRAPPED, _CONFIG
    if _BOOTSTRAPPED and _CONFIG is not None:
        return _CONFIG

    with _LOCK:
        if _BOOTSTRAPPED and _CONFIG is not None:
            return _CONFIG

        config = load_config()
        configure_logging(config)
        configure_services(config)
        init_database(config)
        init_storage(config)

        _CONFIG = config
        _BOOTSTRAPPED = True
        return config

