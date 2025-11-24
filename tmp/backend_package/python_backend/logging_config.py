import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover
    from .config import AppConfig


def configure_logging(config: "AppConfig") -> None:
    """
    Configure Python logging with a simple, production-friendly format.
    """
    logging.basicConfig(
        level=getattr(logging, config.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
        force=True,
    )
