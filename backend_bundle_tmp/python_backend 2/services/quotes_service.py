from __future__ import annotations

import json
import logging
import random
from datetime import date
from pathlib import Path
from typing import Dict, List, Optional

import requests

from . import get_config
from ..utils import http_client

logger = logging.getLogger(__name__)

_CACHE_FILE = "daily-quote.json"


class QuoteServiceError(RuntimeError):
    def __init__(self, message: str, status: int = 500):
        super().__init__(message)
        self.status = status


def _cache_path() -> Path:
    config = get_config()
    return config.data_dir / _CACHE_FILE


def _normalize_quote(raw: Dict) -> Optional[Dict]:
    text = (raw.get("text") or "").strip()
    if not text:
        return None
    author = (raw.get("author") or "").strip()
    quote_id = raw.get("id") or f"{text}::{author}"
    return {"id": quote_id, "text": text, "author": author or None}


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
    quotes: List[Dict] = []
    if isinstance(raw_quotes, list):
        for item in raw_quotes:
            normalized = _normalize_quote(item or {})
            if normalized:
                quotes.append(normalized)

    if not quotes:
        quotes.append({"id": "fallback", "text": "Excellence is an attitude.", "author": "PepPro"})

    return quotes


def _load_cache() -> Optional[Dict]:
    path = _cache_path()
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


def _pick_quote(quotes: List[Dict], avoid_id: Optional[str]) -> Dict:
    candidates = [quote for quote in quotes if quote.get("id") != avoid_id] or quotes
    return random.choice(candidates)


def get_daily_quote() -> Dict:
    cache = _load_cache()
    today = date.today().isoformat()

    try:
        quotes = _fetch_quotes()
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

    if cache and cache.get("date") == today:
        cached_id = cache.get("id")
        found = next((q for q in quotes if str(q.get("id")) == str(cached_id)), None)
        if found:
            return {"text": found.get("text"), "author": found.get("author")}

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
    try:
        quotes = _fetch_quotes()
        return {"quotes": quotes}
    except Exception:
        # Avoid hard failure when the feed is down.
        return {"quotes": [], "stale": True}
