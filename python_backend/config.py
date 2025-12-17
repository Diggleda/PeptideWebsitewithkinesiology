from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - optional dependency
    load_dotenv = None

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    env_path = os.environ.get("DOTENV_CONFIG_PATH")
    if env_path:
        candidate = Path(env_path).expanduser()
    else:
        candidate = BASE_DIR / ".env"
    if load_dotenv:
        load_dotenv(candidate)


def _to_int(value: Optional[str], fallback: int) -> int:
    try:
        if value is None or value == "":
            return fallback
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _to_float(value: Optional[str], fallback: float) -> float:
    try:
        if value is None or value == "":
            return fallback
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _parse_list(raw: Optional[str]) -> List[str]:
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]


def _resolve_path(value: Optional[str], fallback: str) -> Path:
    candidate = Path(value or fallback)
    if candidate.is_absolute():
        return candidate
    return BASE_DIR / candidate


def _to_bool(value: Optional[str], fallback: bool = False) -> bool:
    if value is None:
        return fallback
    text = str(value).strip().lower()
    if text == "":
        return fallback
    return text in ("1", "true", "yes", "on")


@dataclass
class AppConfig:
    node_env: str
    port: int
    jwt_secret: str
    data_dir: Path
    cors_allow_list: List[str]
    body_limit: str
    backend_build: str
    log_level: str
    woo_commerce: Dict[str, Any]
    ship_engine: Dict[str, Any]
    stripe: Dict[str, Any]
    referral: Dict[str, Any]
    encryption: Dict[str, Any]
    ship_station: Dict[str, Any]
    mysql: Dict[str, Any]
    integrations: Dict[str, Any]
    quotes: Dict[str, Any]
    frontend_base_url: str
    flask_settings: Dict[str, Any] = field(default_factory=dict)

    @property
    def is_production(self) -> bool:
        return self.node_env.lower() == "production"


def load_config() -> AppConfig:
    _load_dotenv()

    node_env = os.environ.get("NODE_ENV", "development")
    cors_allow_list = _parse_list(os.environ.get("CORS_ALLOW_ORIGINS") or "*")
    if cors_allow_list == ["*"]:
        cors_allow_list = ["*"]

    # helper to safely strip whitespace
    def _s(val: Optional[str]) -> str:
        return (val or "").strip()

    config = AppConfig(
        node_env=node_env,
        port=_to_int(os.environ.get("PORT"), 3001),
        jwt_secret=os.environ.get("JWT_SECRET", "your-secret-key-change-in-production"),
        data_dir=_resolve_path(os.environ.get("DATA_DIR"), "server-data"),
        cors_allow_list=cors_allow_list,
        body_limit=os.environ.get("BODY_LIMIT", "1mb"),
        backend_build=os.environ.get("BACKEND_BUILD", "v1.9.13"),
        log_level=os.environ.get("LOG_LEVEL", "info" if node_env == "production" else "debug"),
        woo_commerce={
            "store_url": _s(os.environ.get("WC_STORE_URL")),
            "consumer_key": _s(os.environ.get("WC_CONSUMER_KEY")),
            "consumer_secret": _s(os.environ.get("WC_CONSUMER_SECRET")),
            "webhook_secret": _s(os.environ.get("WC_WEBHOOK_SECRET")),
            "api_version": _s(os.environ.get("WC_API_VERSION") or "wc/v3"),
            "auto_submit_orders": os.environ.get("WC_AUTO_SUBMIT_ORDERS", "").lower() == "true",
        },
        ship_engine={
            "api_key": os.environ.get("SHIPENGINE_API_KEY", ""),
            "account_id": os.environ.get("SHIPENGINE_ACCOUNT_ID", ""),
            "default_carrier_id": os.environ.get("SHIPENGINE_CARRIER_ID", ""),
            "default_service_code": os.environ.get("SHIPENGINE_SERVICE_CODE", ""),
            "ship_from_name": os.environ.get("SHIPENGINE_SHIP_FROM_NAME", ""),
            "ship_from_address1": os.environ.get("SHIPENGINE_SHIP_FROM_ADDRESS1", ""),
            "ship_from_address2": os.environ.get("SHIPENGINE_SHIP_FROM_ADDRESS2", ""),
            "ship_from_city": os.environ.get("SHIPENGINE_SHIP_FROM_CITY", ""),
            "ship_from_state": os.environ.get("SHIPENGINE_SHIP_FROM_STATE", ""),
            "ship_from_postal_code": os.environ.get("SHIPENGINE_SHIP_FROM_POSTAL", ""),
            "ship_from_country": os.environ.get("SHIPENGINE_SHIP_FROM_COUNTRY", "US"),
            "auto_create_labels": os.environ.get("SHIPENGINE_AUTO_CREATE_LABELS", "").lower() == "true",
        },
        stripe={
            "onsite_enabled": (os.environ.get("STRIPE_ONSITE_ENABLED") or os.environ.get("VITE_STRIPE_ONSITE_ENABLED") or "").lower() == "true",
            # Frontend uses VITE_STRIPE_MODE; allow sharing one mode across services.
            "mode": _s(os.environ.get("STRIPE_MODE") or os.environ.get("VITE_STRIPE_MODE") or "test"),
            "secret_key_live": _s(os.environ.get("STRIPE_SECRET_KEY")),
            "secret_key_test": _s(os.environ.get("STRIPE_SECRET_TEST_KEY")),
            "secret_key": "",  # resolved below
            "webhook_secret": _s(os.environ.get("STRIPE_WEBHOOK_SECRET")),
            # Browser publishable keys (pk_*) — safe to expose.
            "publishable_key_live": _s(
                os.environ.get("VITE_STRIPE_PUBLISHABLE_KEY")
                or os.environ.get("STRIPE_PUBLISHABLE_KEY")
                or os.environ.get("STRIPE_PUBLISHABLE_KEY_LIVE")
                or ""
            ),
            "publishable_key_test": _s(
                os.environ.get("VITE_STRIPE_PUBLISHABLE_TEST_KEY")
                or os.environ.get("STRIPE_PUBLISHABLE_TEST_KEY")
                or os.environ.get("STRIPE_PUBLISHABLE_KEY_TEST")
                or ""
            ),
            "publishable_key": "",
        },
        referral={
            "fixed_credit_amount": _to_float(os.environ.get("REFERRAL_FIRST_ORDER_CREDIT"), 250.0),
            "commission_rate": _to_float(os.environ.get("REFERRAL_COMMISSION_RATE"), 0.05),
        },
        encryption={
            "key": os.environ.get("DATA_ENCRYPTION_KEY", ""),
            "algorithm": os.environ.get("DATA_ENCRYPTION_ALGO", "aes-256-gcm"),
        },
        ship_station={
            "api_token": _s(os.environ.get("SHIPSTATION_API_TOKEN")),
            "api_key": _s(os.environ.get("SHIPSTATION_API_KEY")),
            "api_secret": _s(os.environ.get("SHIPSTATION_API_SECRET")),
            "carrier_code": _s(os.environ.get("SHIPSTATION_CARRIER_CODE")),
            "service_code": _s(os.environ.get("SHIPSTATION_SERVICE_CODE")),
            "package_code": _s(os.environ.get("SHIPSTATION_PACKAGE_CODE") or "package"),
            "ship_from": {
                "name": _s(os.environ.get("SHIPSTATION_SHIP_FROM_NAME")),
                "company": _s(os.environ.get("SHIPSTATION_SHIP_FROM_COMPANY")),
                "address_line1": _s(os.environ.get("SHIPSTATION_SHIP_FROM_ADDRESS1")),
                "address_line2": _s(os.environ.get("SHIPSTATION_SHIP_FROM_ADDRESS2")),
                "city": _s(os.environ.get("SHIPSTATION_SHIP_FROM_CITY")),
                "state": _s(os.environ.get("SHIPSTATION_SHIP_FROM_STATE")),
                "postal_code": _s(os.environ.get("SHIPSTATION_SHIP_FROM_POSTAL")),
                "country_code": _s(os.environ.get("SHIPSTATION_SHIP_FROM_COUNTRY") or "US"),
                "phone": _s(os.environ.get("SHIPSTATION_SHIP_FROM_PHONE")),
            },
        },
        mysql={
            "enabled": os.environ.get("MYSQL_ENABLED", "").lower() == "true",
            "host": os.environ.get("MYSQL_HOST", "127.0.0.1"),
            "port": _to_int(os.environ.get("MYSQL_PORT"), 3306),
            "user": os.environ.get("MYSQL_USER", ""),
            "password": os.environ.get("MYSQL_PASSWORD", ""),
            "database": os.environ.get("MYSQL_DATABASE", ""),
            "connection_limit": _to_int(os.environ.get("MYSQL_POOL_SIZE"), 8),
            "ssl": os.environ.get("MYSQL_SSL", "").lower() == "true",
            "timezone": os.environ.get("MYSQL_TIMEZONE", "Z"),
            "connect_timeout": _to_int(os.environ.get("MYSQL_CONNECT_TIMEOUT_SECONDS"), 5),
            "read_timeout": _to_int(os.environ.get("MYSQL_READ_TIMEOUT_SECONDS"), 15),
            "write_timeout": _to_int(os.environ.get("MYSQL_WRITE_TIMEOUT_SECONDS"), 15),
        },
        integrations={
            "google_sheets_secret": os.environ.get("GOOGLE_SHEETS_WEBHOOK_SECRET", ""),
        },
        quotes={
            "source_url": _s(
                os.environ.get("QUOTES_SOURCE_URL")
                or "https://port.peppro.net/api/integrations/google-sheets/quotes/quotes.php"
            ),
            "secret": _s(
                os.environ.get("QUOTES_WEBHOOK_SECRET")
                or os.environ.get("GOOGLE_SHEETS_WEBHOOK_SECRET")
                or ""
            ),
        },
        frontend_base_url=_s(
            os.environ.get("FRONTEND_BASE_URL")
            or os.environ.get("APP_BASE_URL")
            or "http://localhost:3000"
        ),
        flask_settings={
            "JSON_SORT_KEYS": False,
        },
    )

    config.data_dir.mkdir(parents=True, exist_ok=True)

    # Resolve Stripe secret key based on mode (defaults to test).
    stripe_mode = (config.stripe.get("mode") or "test").strip().lower()
    if stripe_mode == "live":
        config.stripe["secret_key"] = config.stripe.get("secret_key_live") or ""
    else:
        config.stripe["secret_key"] = config.stripe.get("secret_key_test") or config.stripe.get("secret_key_live") or ""

    # Resolve Stripe publishable key based on mode (defaults to test).
    if stripe_mode == "live":
        config.stripe["publishable_key"] = config.stripe.get("publishable_key_live") or ""
    else:
        config.stripe["publishable_key"] = config.stripe.get("publishable_key_test") or config.stripe.get("publishable_key_live") or ""

    return config


_CONFIG_CACHE: Optional[AppConfig] = None


def get_config() -> AppConfig:
    """
    Provide a shared accessor so legacy modules that import from python_backend.config
    keep working even though most services hydrate their config via configure_services().
    """
    global _CONFIG_CACHE
    if _CONFIG_CACHE is None:
        _CONFIG_CACHE = load_config()
    return _CONFIG_CACHE
