from __future__ import annotations

import logging
from typing import Optional

from ..config import AppConfig
from . import mysql_client, mysql_schema

_CONFIGURED = False
logger = logging.getLogger(__name__)


def init_database(config: AppConfig) -> None:
  global _CONFIGURED
  if _CONFIGURED:
    return

  if config.mysql.get("enabled"):
        mysql_client.configure(config)
        try:
            mysql_schema.ensure_schema()
        except Exception:
            # Do not block the app from starting if MySQL is unavailable.
            logger.exception("MySQL init failed; continuing with MySQL disabled")
            config.mysql["enabled"] = False

  _CONFIGURED = True
