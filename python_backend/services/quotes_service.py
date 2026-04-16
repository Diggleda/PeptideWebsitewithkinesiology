from __future__ import annotations

import json
import logging
import os
import random
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

import requests

from . import get_config
from ..utils import http_client

logger = logging.getLogger(__name__)

_CACHE_FILE = "daily-quote.json"
_FEED_CACHE_FILE = "quotes-feed.json"


class QuoteServiceError(RuntimeError):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _cache_path() -> Path:
    config = get_config()
    return config.data_dir / _CACHE_FILE


def _feed_cache_path() -> Path:
    config = get_config()
    return config.data_dir / _FEED_CACHE_FILE


def _normalize_quote(raw: Dict) -> Optional[Dict]:
    text = (raw.get("text") or "").strip()
    if not text:
        return None
    author = (raw.get("author") or "").strip()
    quote_id = raw.get("id") or f"{text}::{author}"
    return {"id": quote_id, "text": text, "author": author or None}


def _normalize_quotes(raw_quotes: object) -> List[Dict]:
    quotes: List[Dict] = []
    if isinstance(raw_quotes, list):
        for item in raw_quotes:
            normalized = _normalize_quote(item or {})
            if normalized:
                quotes.append(normalized)

    if not quotes:
        quotes.append({"id": "fallback", "text": "Excellence is an attitude.", "author": "PepPro"})
    return quotes


def _fetch_quotes() -> List[Dict]:
    config = get_config()
    source_url = config.quotes.get("source_url")
    if not source_url:
        raise QuoteServiceError("Quotes source is not configured", status=503)

    headers = {}
    secret = config.quotes.get("secret") or config.integrations.get("google_sheets_secret")
    if secret:
        headers["Authorization"] = f"Bearer {secret}"

    try:
        response = http_client.get(source_url, headers=headers, timeout=10)
        response.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover - network errors
        logger.error("Failed to fetch quotes", exc_info=True)
        raise QuoteServiceError("Failed to fetch quote feed", status=502) from exc

    try:
        payload = response.json()
    except ValueError:  # pragma: no cover - json errors
        logger.error("Quotes endpoint returned invalid JSON")
        raise QuoteServiceError("Invalid quote feed", status=502)

    raw_quotes = payload.get("quotes") if isinstance(payload, dict) else payload
    return _normalize_quotes(raw_quotes)


def _load_cache() -> Optional[Dict]:
    path = _cache_path()
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:  # pragma: no cover - cache corruption
        return None


def _load_feed_cache() -> Optional[Dict]:
    path = _feed_cache_path()
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:  # pragma: no cover - cache corruption
        return None


def _store_cache(entry: Dict) -> None:
    path = _cache_path()
    try:
        path.write_text(json.dumps(entry))
    except Exception:  # pragma: no cover - disk errors
        logger.warning("Failed to persist daily quote cache", exc_info=True)


def _store_feed_cache(quotes: List[Dict]) -> None:
    path = _feed_cache_path()
    payload = {
        "fetchedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "quotes": quotes,
    }
    try:
        path.write_text(json.dumps(payload))
    except Exception:  # pragma: no cover - disk errors
        logger.warning("Failed to persist quotes feed cache", exc_info=True)


def _parse_iso_utc(value: object) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        normalized = text[:-1] + "+00:00" if text.endswith("Z") else text
        parsed = datetime.fromisoformat(normalized)
    except Exception:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _feed_cache_max_age_seconds() -> int:
    raw = str(os.environ.get("QUOTES_FEED_CACHE_MAX_AGE_SECONDS", "86400")).strip()
    try:
        seconds = int(raw)
    except Exception:
        seconds = 86400
    return max(300, min(seconds, 7 * 86400))


def _cached_quotes(*, allow_stale: bool) -> Optional[List[Dict]]:
    entry = _load_feed_cache()
    if not isinstance(entry, dict):
        return None

    quotes = _normalize_quotes(entry.get("quotes"))
    if allow_stale:
        return quotes

    fetched_at = _parse_iso_utc(entry.get("fetchedAt"))
    if fetched_at is None:
        return None
    age_seconds = (datetime.now(timezone.utc) - fetched_at).total_seconds()
    if age_seconds > _feed_cache_max_age_seconds():
        return None
    return quotes


def _fetch_and_store_quotes() -> List[Dict]:
    quotes = _fetch_quotes()
    _store_feed_cache(quotes)
    return quotes


def _pick_quote(quotes: List[Dict], avoid_id: Optional[str]) -> Dict:
    candidates = [quote for quote in quotes if quote.get("id") != avoid_id] or quotes
    return random.choice(candidates)


def get_daily_quote() -> Dict:
    cache = _load_cache()
    today = date.today().isoformat()

    if isinstance(cache, dict) and cache.get("date") == today:
        cached_text = cache.get("text")
        if isinstance(cached_text, str) and cached_text.strip():
            return {
                "text": cached_text.strip(),
                "author": cache.get("author"),
            }

    quotes = _cached_quotes(allow_stale=True)
    try:
        if not quotes:
            quotes = _fetch_and_store_quotes()
    except Exception:
        # When the quote feed is down, serve last known cached quote if available.
        if isinstance(cache, dict):
            cached_text = cache.get("text")
            if isinstance(cached_text, str) and cached_text.strip():
                return {
                    "text": cached_text.strip(),
                    "author": cache.get("author"),
                    "stale": True,
                }
        # Final fallback that never fails the UI.
        return {"text": "Excellence is an attitude.", "author": "PepPro", "stale": True}

    yesterday_id = cache.get("id") if cache and cache.get("date") != today else None
    selection = _pick_quote(quotes, yesterday_id)
    # Store both id + resolved content so we can serve it if the feed is down later.
    _store_cache(
        {
            "date": today,
            "id": selection.get("id"),
            "text": selection.get("text"),
            "author": selection.get("author"),
        }
    )
    return {"text": selection.get("text"), "author": selection.get("author")}


def list_quotes() -> Dict:
    fresh_cache = _cached_quotes(allow_stale=False)
    if fresh_cache:
        return {"quotes": fresh_cache, "cached": True}

    try:
        quotes = _fetch_and_store_quotes()
        return {"quotes": quotes}
    except Exception:
        stale_cache = _cached_quotes(allow_stale=True)
        if stale_cache:
            return {"quotes": stale_cache, "stale": True}
        # Avoid hard failure when the feed is down.
        return {"quotes": [], "stale": True}


def prime_daily_quote_cache() -> Dict:
    cache = _load_cache()
    today = date.today().isoformat()
    if isinstance(cache, dict) and cache.get("date") == today:
        cached_text = cache.get("text")
        if isinstance(cached_text, str) and cached_text.strip():
            quote = {"text": cached_text.strip(), "author": cache.get("author")}
            logger.info("[quotes] daily quote cache primed", extra={"stale": False, "cached": True})
            return quote

    quotes = _cached_quotes(allow_stale=False)
    if not quotes:
        try:
            quotes = _fetch_and_store_quotes()
        except Exception:
            quotes = _cached_quotes(allow_stale=True)
    if not quotes:
        quote = get_daily_quote()
        logger.info("[quotes] daily quote cache primed", extra={"stale": bool(quote.get("stale"))})
        return quote

    yesterday_id = cache.get("id") if isinstance(cache, dict) and cache.get("date") != today else None
    selection = _pick_quote(quotes, yesterday_id)
    _store_cache(
        {
            "date": today,
            "id": selection.get("id"),
            "text": selection.get("text"),
            "author": selection.get("author"),
        }
    )
    quote = {"text": selection.get("text"), "author": selection.get("author")}
    logger.info("[quotes] daily quote cache primed", extra={"stale": bool(quote.get("stale"))})
    return quote
