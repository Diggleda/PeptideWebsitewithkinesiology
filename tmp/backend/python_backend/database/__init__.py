from __future__ import annotations

from typing import Optional

from ..config import AppConfig
from . import mysql_client, mysql_schema

_CONFIGURED = False


def init_database(config: AppConfig) -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return

    if config.mysql.get("enabled"):
        mysql_client.configure(config)
        mysql_schema.ensure_schema()

    _CONFIGURED = True
