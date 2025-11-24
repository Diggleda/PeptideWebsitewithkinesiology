from __future__ import annotations

from typing import Optional

from ..config import AppConfig

_APP_CONFIG: Optional[AppConfig] = None


def configure_services(config: AppConfig) -> None:
    global _APP_CONFIG
    _APP_CONFIG = config


def get_config() -> AppConfig:
    if _APP_CONFIG is None:
        raise RuntimeError("Service configuration has not been initialised")
    return _APP_CONFIG
