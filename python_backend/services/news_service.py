from __future__ import annotations

import logging
from dataclasses import dataclass
from html import unescape
from typing import List, Optional
from urllib.parse import urljoin

import requests

try:
    from bs4 import BeautifulSoup  # type: ignore
except ImportError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

logger = logging.getLogger(__name__)

BASE_URL = "https://www.nature.com"
PEPTIDE_NEWS_PATH = "/subjects/peptides"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36"
)


@dataclass
class NewsItem:
    title: str
    url: str
    summary: Optional[str]
    image_url: Optional[str] = None
    date: Optional[str] = None


def fetch_peptide_news(limit: int = 8) -> List[NewsItem]:
    """Fetch peptide related headlines from Nature and return cleaned entries."""
    html = _fetch_page_html()
    if not html:
        return []

    items = _parse_news(html)

    # Sort by date (most recent first), treating items without dates as oldest
    items = _sort_by_date(items)

    if limit > 0:
        items = items[:limit]
    return items


def _fetch_page_html() -> Optional[str]:
    endpoints = [
        urljoin(BASE_URL, PEPTIDE_NEWS_PATH),
        f"https://r.jina.ai/{urljoin(BASE_URL, PEPTIDE_NEWS_PATH)}",
    ]

    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    for endpoint in endpoints:
        try:
            response = requests.get(endpoint, headers=headers, timeout=10)
            if response.status_code >= 400:
                logger.warning("Peptide news request failed: %s %s", endpoint, response.status_code)
                continue
            response.encoding = response.encoding or "utf-8"
            return response.text
        except requests.RequestException as exc:
            logger.warning("Peptide news request error for %s: %s", endpoint, exc)
            continue
    return None


def _parse_news(html: str) -> List[NewsItem]:
    if BeautifulSoup is None:
        logger.warning("BeautifulSoup is not installed; cannot parse peptide news response.")
        return []

    soup = BeautifulSoup(html, "html.parser")
    items: List[NewsItem] = []
    seen_urls = set()

    article_candidates = soup.select("article") or []
    for article in article_candidates:
        title_link = article.select_one(".c-card__title a, h3 a, h2 a")
        if not title_link:
            continue
        raw_href = title_link.get("href")
        raw_title = title_link.get_text(strip=True)
        if not raw_href or not raw_title:
            continue
        absolute_url = urljoin(BASE_URL, raw_href)
        if absolute_url in seen_urls:
            continue

        summary_text = None
        summary_node = article.select_one(".c-card__summary, .c-card__standfirst, p")
        if summary_node:
            summary_text = _clean_text(summary_node.get_text(" ", strip=True))

        image_url = _extract_image_url(article)

        date_text = None
        # Try multiple selectors for date
        date_selectors = [
            "time[datetime]",
            "time",
            ".c-card__date",
            ".c-meta__item time",
            "[datetime]",
            ".c-card__meta time",
            ".c-article-identifiers time",
        ]

        for selector in date_selectors:
            date_node = article.select_one(selector)
            if date_node:
                # Try to get datetime attribute first (more reliable), fallback to text
                date_text = date_node.get("datetime") or _clean_text(date_node.get_text(strip=True))
                if date_text:
                    break

        items.append(
            NewsItem(
                title=_clean_text(raw_title),
                url=absolute_url,
                summary=summary_text,
                image_url=image_url,
                date=date_text,
            )
        )
        seen_urls.add(absolute_url)

    if not items:
        # Fallback: grab anchors inside main content linking to articles
        for link in soup.select("a[href*='/articles/']"):
            raw_href = link.get("href")
            text = link.get_text(strip=True)
            if not raw_href or not text:
                continue
            absolute_url = urljoin(BASE_URL, raw_href)
            if absolute_url in seen_urls:
                continue
            items.append(
                NewsItem(
                    title=_clean_text(text),
                    url=absolute_url,
                    summary=None,
                    image_url=None,
                )
            )
            seen_urls.add(absolute_url)

    return items


def _sort_by_date(items: List[NewsItem]) -> List[NewsItem]:
    """Sort news items by date (most recent first)."""
    from datetime import datetime

    def parse_date_key(item: NewsItem):
        """Parse date string and return a sortable value."""
        if not item.date:
            # Items without dates go to the end
            logger.debug(f"No date for item: {item.title[:50]}")
            return datetime.min

        date_str = item.date.strip()
        logger.debug(f"Parsing date '{date_str}' for item: {item.title[:50]}")

        # Handle ISO 8601 format with 'Z' suffix
        if date_str.endswith('Z'):
            date_str = date_str[:-1]

        # Try common date formats (including ISO 8601)
        date_formats = [
            "%Y-%m-%dT%H:%M:%S",  # "2025-01-01T10:30:00"
            "%Y-%m-%d",  # "2025-01-01"
            "%d %B %Y",  # "01 January 2025"
            "%d %b %Y",  # "01 Jan 2025"
            "%B %d, %Y",  # "January 01, 2025"
            "%b %d, %Y",  # "Jan 01, 2025"
            "%d/%m/%Y",  # "01/01/2025"
            "%m/%d/%Y",  # "01/01/2025"
        ]

        for date_format in date_formats:
            try:
                parsed = datetime.strptime(date_str, date_format)
                logger.debug(f"Successfully parsed '{date_str}' as {parsed} using format {date_format}")
                return parsed
            except ValueError:
                continue

        # If no format matches, try to extract year at least
        import re
        year_match = re.search(r'\b(20\d{2})\b', date_str)
        if year_match:
            try:
                parsed = datetime(int(year_match.group(1)), 1, 1)
                logger.debug(f"Extracted year from '{date_str}': {parsed}")
                return parsed
            except ValueError:
                pass

        # If all parsing fails, put at the end
        logger.warning(f"Failed to parse date '{date_str}' for item: {item.title[:50]}")
        return datetime.min

    sorted_items = sorted(items, key=parse_date_key, reverse=True)
    logger.info(f"Sorted {len(sorted_items)} items by date")
    return sorted_items


def _clean_text(value: str) -> str:
    cleaned = unescape(value or "").strip()
    return " ".join(cleaned.split())


def _extract_image_url(article) -> Optional[str]:
    image_node = article.select_one("img")
    if not image_node:
        return None

    candidates = []
    for attr in ("data-src", "data-srcset", "srcset", "src"):
        raw = image_node.get(attr)
        if raw:
            candidates.append(raw.strip())

    for candidate in candidates:
        if not candidate:
            continue
        url = candidate.split()[0]
        normalized = _normalize_image_url(url)
        if normalized:
            return normalized

    return None


def _normalize_image_url(url: str) -> Optional[str]:
    if not url:
        return None

    value = url.strip()
    if not value or value.startswith("data:"):
        return None

    if value.startswith("//"):
        value = f"https:{value}"
    elif value.startswith("/"):
        value = urljoin(BASE_URL, value)

    return value
