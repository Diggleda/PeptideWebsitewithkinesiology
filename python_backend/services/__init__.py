from __future__ import annotations

from typing import Optional

from ..config import AppConfig

_APP_CONFIG: Optional[AppConfig] = None


def configure_services(config: AppConfig) -> None:
    global _APP_CONFIG
    _APP_CONFIG = config


def get_config() -> AppConfig:
    """
    Return the active AppConfig.

    Normally populated by `configure_services()` in `python_backend.create_app()`.
    In some hosting environments the Flask app context may exist even if this
    module-level global was not initialised; fall back to `current_app` in that case.
    """
    global _APP_CONFIG
    if _APP_CONFIG is not None:
        return _APP_CONFIG
    try:
        from flask import current_app  # type: ignore

        config = current_app.config.get("APP_CONFIG")  # type: ignore[attr-defined]
        if isinstance(config, AppConfig):
            _APP_CONFIG = config
            return config
    except Exception:
        pass
    raise RuntimeError("Service configuration has not been initialised")
