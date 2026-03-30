from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import glob
import hashlib
import html
import json
import logging
import mimetypes
import os
import select
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

from ..config import BASE_DIR
from .invoice_service import _build_simple_text_pdf

logger = logging.getLogger(__name__)

_PDF_BRIDGE_TIMEOUT_SECONDS = max(5.0, min(float(os.environ.get("QUOTE_PDF_BRIDGE_TIMEOUT_SECONDS", "45").strip() or 45), 180.0))
_BROWSER_PDF_TIMEOUT_SECONDS = max(10.0, min(float(os.environ.get("QUOTE_PDF_BROWSER_TIMEOUT_SECONDS", "90").strip() or 90), 180.0))
_NODE_WORKER_REQUEST_TIMEOUT_SECONDS = max(5.0, min(float(os.environ.get("QUOTE_PDF_NODE_WORKER_TIMEOUT_SECONDS", "90").strip() or 90), 180.0))
_REMOTE_IMAGE_FETCH_TIMEOUT_SECONDS = 3.5
_NODE_BRIDGE_RETRY_COOLDOWN_SECONDS = 45
_QUOTE_PDF_RENDER_CACHE_TTL_SECONDS = 300
_QUOTE_PDF_RENDER_CACHE_LIMIT = 32
_QUOTE_PDF_DISK_CACHE_LIMIT = 64
_IMAGE_FETCH_ACCEPT_HEADER = "image/png,image/jpeg,image/webp,image/gif,image/*,*/*;q=0.8"
_MAX_IMAGE_CANDIDATES_PER_ITEM = 4
_MAX_CONCURRENT_IMAGE_RESOLVERS = 6
_SUPPORTED_IMAGE_CONTENT_TYPES = {
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/svg+xml",
    "image/webp",
}
_IMAGE_SOURCE_KEYS = (
    "src",
    "url",
    "href",
    "source",
    "image",
    "imageUrl",
    "image_url",
    "thumbnail",
    "thumb",
    "full",
    "fullUrl",
    "full_url",
    "original",
    "originalUrl",
    "original_url",
)
_STATIC_ASSET_DATA_URL_CACHE: Dict[str, Optional[str]] = {}
_SKU_PRODUCT_IMAGE_CACHE: Dict[str, Optional[str]] = {}
_IMAGE_DATA_URL_CACHE: Dict[str, Optional[str]] = {}
_QUOTE_PDF_RENDER_CACHE: Dict[str, Dict[str, Any]] = {}
_CACHED_WOO_SKU_IMAGE_MAP: Optional[Dict[str, str]] = None
_NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = 0.0
_NODE_WORKER_PROCESS: Optional[subprocess.Popen] = None
_NODE_WORKER_LOCK = threading.Lock()
_STATIC_ASSET_SEARCH_DIRS = (
    "public",
    "build",
    "build_debug",
    "build_main_tmp",
    "build_staging_tmp",
)


def _service_error(message: str, status: int) -> Exception:
    try:
        from ..utils.http import service_error as http_service_error

        return http_service_error(message, status)
    except Exception:
        error = ValueError(message)
        setattr(error, "status", status)
        return error


def _bridge_script_path() -> Path:
    return BASE_DIR / "server" / "scripts" / "generateProspectQuotePdfCli.js"


def _worker_script_path() -> Path:
    return BASE_DIR / "server" / "scripts" / "generateProspectQuotePdfWorker.js"


def _iter_existing_paths(patterns: List[str]) -> List[str]:
    results: List[str] = []
    for pattern in patterns:
        expanded = os.path.expanduser(pattern)
        if any(char in expanded for char in "*?[]"):
            matches = sorted(glob.glob(expanded), reverse=True)
        else:
            matches = [expanded]
        for match in matches:
            if match and os.path.exists(match):
                results.append(match)
    return results


def _find_node_binary() -> Optional[str]:
    candidates = [
        os.environ.get("QUOTE_PDF_NODE_BINARY"),
        os.environ.get("NODE_BINARY"),
        shutil.which("node"),
        shutil.which("nodejs"),
        *_iter_existing_paths(
            [
                "~/.nvm/versions/node/*/bin/node",
                "~/.local/bin/node",
                "/opt/cpanel/ea-nodejs*/bin/node",
                "/usr/local/bin/node",
                "/usr/bin/node",
            ]
        ),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _find_playwright_browsers_path() -> Optional[str]:
    env_value = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if env_value and os.path.isdir(env_value):
        return env_value

    candidates = _iter_existing_paths(
        [
            str(BASE_DIR / ".playwright-browsers"),
            "~/.cache/ms-playwright",
            "~/Library/Caches/ms-playwright",
            "/root/.cache/ms-playwright",
            "/home/*/.cache/ms-playwright",
            "/Users/*/Library/Caches/ms-playwright",
        ]
    )
    for candidate in candidates:
        try:
            if os.path.isdir(candidate) and any(Path(candidate).iterdir()):
                return candidate
        except Exception:
            continue
    return None


def _iter_playwright_browser_executables() -> List[str]:
    browsers_path = _find_playwright_browsers_path()
    if not browsers_path:
        return []

    return _iter_existing_paths(
        [
            os.path.join(browsers_path, "chromium-*", "chrome-linux64", "chrome"),
            os.path.join(browsers_path, "chromium-*", "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
            os.path.join(browsers_path, "chromium_headless_shell-*", "chrome-headless-shell-linux64", "chrome-headless-shell"),
            os.path.join(browsers_path, "chromium_headless_shell-*", "chrome-headless-shell-mac", "chrome-headless-shell"),
        ]
    )


def _build_node_renderer_env(node_binary: str) -> Dict[str, str]:
    env = os.environ.copy()
    node_dir = str(Path(node_binary).resolve().parent)
    path_parts = [part for part in env.get("PATH", "").split(os.pathsep) if part]
    if node_dir not in path_parts:
        env["PATH"] = os.pathsep.join([node_dir, *path_parts])
    browsers_path = _find_playwright_browsers_path()
    if browsers_path and not env.get("PLAYWRIGHT_BROWSERS_PATH"):
        env["PLAYWRIGHT_BROWSERS_PATH"] = browsers_path
    return env


def _shutdown_node_worker_process() -> None:
    global _NODE_WORKER_PROCESS

    process = _NODE_WORKER_PROCESS
    _NODE_WORKER_PROCESS = None
    if process is None:
        return
    try:
        if process.stdin and not process.stdin.closed:
            process.stdin.close()
    except Exception:
        pass
    try:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=1.5)
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


def _ensure_node_worker_process() -> Optional[subprocess.Popen]:
    global _NODE_WORKER_PROCESS

    if _NODE_WORKER_PROCESS is not None and _NODE_WORKER_PROCESS.poll() is None:
        return _NODE_WORKER_PROCESS

    _shutdown_node_worker_process()
    script_path = _worker_script_path()
    node_binary = _find_node_binary()
    if not script_path.exists() or not node_binary:
        return None

    try:
        _NODE_WORKER_PROCESS = subprocess.Popen(
            [node_binary, str(script_path)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=str(BASE_DIR),
            env=_build_node_renderer_env(node_binary),
            bufsize=1,
        )
    except Exception:
        logger.exception("Quote PDF node worker failed to start")
        _NODE_WORKER_PROCESS = None
        return None

    return _NODE_WORKER_PROCESS


def _allow_text_fallback() -> bool:
    return str(os.environ.get("QUOTE_PDF_ALLOW_TEXT_FALLBACK") or "").strip().lower() in ("1", "true", "yes", "on")


def _build_quote_render_cache_key(quote: Dict) -> str:
    payload = quote.get("quotePayloadJson") if isinstance(quote.get("quotePayloadJson"), dict) else {}
    signature_payload = {
        "id": quote.get("id"),
        "revisionNumber": quote.get("revisionNumber"),
        "status": quote.get("status"),
        "title": quote.get("title"),
        "currency": quote.get("currency"),
        "subtotal": quote.get("subtotal"),
        "updatedAt": quote.get("updatedAt"),
        "exportedAt": quote.get("exportedAt"),
        "quotePayloadJson": payload,
    }
    serialized = json.dumps(signature_payload, sort_keys=True, ensure_ascii=False, default=str, separators=(",", ":"))
    return hashlib.sha1(serialized.encode("utf-8")).hexdigest()


def _quote_pdf_disk_cache_dir() -> Path:
    return BASE_DIR / "server-data" / "quote-pdf-cache"


def _quote_pdf_disk_cache_path(cache_key: str) -> Path:
    return _quote_pdf_disk_cache_dir() / f"{cache_key}.json"


def _prune_quote_pdf_disk_cache(directory: Path) -> None:
    try:
        cache_files = sorted(
            (entry for entry in directory.iterdir() if entry.is_file() and entry.suffix.lower() == ".json"),
            key=lambda entry: entry.stat().st_mtime,
            reverse=True,
        )
    except Exception:
        return

    for stale_file in cache_files[_QUOTE_PDF_DISK_CACHE_LIMIT :]:
        try:
            stale_file.unlink()
        except Exception:
            continue


def _get_cached_rendered_quote_pdf_from_disk(cache_key: str, ttl_seconds: int) -> Optional[Dict]:
    if ttl_seconds <= 0:
        return None

    cache_path = _quote_pdf_disk_cache_path(cache_key)
    try:
        stat = cache_path.stat()
    except Exception:
        return None

    if (time.time() - stat.st_mtime) > ttl_seconds:
        try:
            cache_path.unlink()
        except Exception:
            pass
        return None

    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
        filename = payload.get("filename")
        pdf_base64 = payload.get("pdfBase64")
        if not isinstance(filename, str) or not filename.strip() or not isinstance(pdf_base64, str) or not pdf_base64.strip():
            raise ValueError("invalid quote pdf disk cache payload")
        return {
            "pdf": base64.b64decode(pdf_base64),
            "filename": filename,
        }
    except Exception:
        try:
            cache_path.unlink()
        except Exception:
            pass
        return None


def _store_rendered_quote_pdf_to_disk(cache_key: str, rendered: Dict) -> None:
    pdf = rendered.get("pdf")
    filename = rendered.get("filename")
    if not isinstance(pdf, (bytes, bytearray)) or not isinstance(filename, str) or not filename.strip():
        return

    directory = _quote_pdf_disk_cache_dir()
    try:
        directory.mkdir(parents=True, exist_ok=True)
        temp_path = directory / f"{cache_key}.tmp"
        cache_path = _quote_pdf_disk_cache_path(cache_key)
        payload = {
            "filename": filename,
            "pdfBase64": base64.b64encode(bytes(pdf)).decode("ascii"),
        }
        temp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        temp_path.replace(cache_path)
        _prune_quote_pdf_disk_cache(directory)
    except Exception:
        logger.exception("Quote PDF disk cache store failed", extra={"cache_key": cache_key})


def _get_cached_rendered_quote_pdf(cache_key: str) -> Optional[Dict]:
    ttl_seconds = max(0, int(float(os.environ.get("QUOTE_PDF_RENDER_CACHE_TTL_SECONDS") or _QUOTE_PDF_RENDER_CACHE_TTL_SECONDS)))
    if ttl_seconds <= 0:
        _QUOTE_PDF_RENDER_CACHE.pop(cache_key, None)
        return None
    entry = _QUOTE_PDF_RENDER_CACHE.get(cache_key)
    if isinstance(entry, dict):
        expires_at = float(entry.get("expiresAt") or 0.0)
        if expires_at <= time.monotonic():
            _QUOTE_PDF_RENDER_CACHE.pop(cache_key, None)
        else:
            pdf = entry.get("pdf")
            filename = entry.get("filename")
            if not isinstance(pdf, (bytes, bytearray)) or not isinstance(filename, str) or not filename.strip():
                _QUOTE_PDF_RENDER_CACHE.pop(cache_key, None)
            else:
                return {
                    "pdf": bytes(pdf),
                    "filename": filename,
                }

    disk_cached = _get_cached_rendered_quote_pdf_from_disk(cache_key, ttl_seconds)
    if disk_cached is None:
        return None
    _store_rendered_quote_pdf(cache_key, disk_cached)
    logger.info("Quote PDF cache hit", extra={"cache_key": cache_key, "cache_layer": "disk"})
    return {
        "pdf": bytes(disk_cached["pdf"]),
        "filename": disk_cached["filename"],
    }


def _store_rendered_quote_pdf(cache_key: str, rendered: Dict) -> None:
    ttl_seconds = max(0, int(float(os.environ.get("QUOTE_PDF_RENDER_CACHE_TTL_SECONDS") or _QUOTE_PDF_RENDER_CACHE_TTL_SECONDS)))
    if ttl_seconds <= 0:
        return
    pdf = rendered.get("pdf")
    filename = rendered.get("filename")
    if not isinstance(pdf, (bytes, bytearray)) or not isinstance(filename, str) or not filename.strip():
        return

    while len(_QUOTE_PDF_RENDER_CACHE) >= _QUOTE_PDF_RENDER_CACHE_LIMIT:
        oldest_key = next(iter(_QUOTE_PDF_RENDER_CACHE), None)
        if oldest_key is None:
            break
        _QUOTE_PDF_RENDER_CACHE.pop(oldest_key, None)

    _QUOTE_PDF_RENDER_CACHE.pop(cache_key, None)
    _QUOTE_PDF_RENDER_CACHE[cache_key] = {
        "pdf": bytes(pdf),
        "filename": filename,
        "expiresAt": time.monotonic() + ttl_seconds,
    }
    _store_rendered_quote_pdf_to_disk(cache_key, rendered)


def _find_static_asset_path(preferred_relative_paths: List[str], match_tokens: List[str]) -> Optional[Path]:
    for relative_path in preferred_relative_paths:
        asset_path = BASE_DIR / relative_path
        if asset_path.exists():
            return asset_path

    lowered_tokens = [str(token or "").strip().lower() for token in match_tokens if str(token or "").strip()]
    if not lowered_tokens:
        return None

    for directory_name in _STATIC_ASSET_SEARCH_DIRS:
        directory_path = BASE_DIR / directory_name
        if not directory_path.is_dir():
            continue
        try:
            for entry in sorted(directory_path.iterdir()):
                lowered_name = entry.name.lower()
                if (
                    entry.is_file()
                    and entry.suffix.lower() in {".png", ".svg", ".webp", ".jpg", ".jpeg", ".gif"}
                    and all(token in lowered_name for token in lowered_tokens)
                ):
                    return entry
        except Exception:
            continue
    return None


def _load_static_data_url(
    cache_key: str,
    preferred_relative_paths: List[str],
    match_tokens: List[str],
    default_mime_type: str,
) -> Optional[str]:
    if cache_key in _STATIC_ASSET_DATA_URL_CACHE:
        return _STATIC_ASSET_DATA_URL_CACHE[cache_key]

    asset_path = _find_static_asset_path(preferred_relative_paths, match_tokens)
    if not asset_path:
        _STATIC_ASSET_DATA_URL_CACHE[cache_key] = None
        return None

    try:
        encoded = base64.b64encode(asset_path.read_bytes()).decode("ascii")
        content_type = mimetypes.guess_type(str(asset_path))[0] or default_mime_type
        data_url = f"data:{content_type};base64,{encoded}"
    except Exception:
        data_url = None

    _STATIC_ASSET_DATA_URL_CACHE[cache_key] = data_url
    return data_url


def _get_logo_data_url() -> Optional[str]:
    return _load_static_data_url(
        "logo",
        ["public/PepPro_fulllogo.png", "public/Peppro_fulllogo.png"],
        ["pep", "fulllogo"],
        "image/png",
    )


def _get_fallback_icon_data_url() -> Optional[str]:
    return _load_static_data_url(
        "icon",
        ["public/PepPro_icon.png", "public/Peppro_icon.png"],
        ["pep", "icon"],
        "image/png",
    )


def _escape_html(value: object) -> str:
    return html.escape(str(value or ""), quote=True)


def _extract_image_source(value: object, visited: Optional[set[int]] = None) -> Optional[str]:
    if isinstance(value, str):
        text = value.strip()
        return text or None
    if not isinstance(value, (dict, list, tuple)):
        return None

    visited = visited or set()
    marker = id(value)
    if marker in visited:
        return None
    visited.add(marker)

    if isinstance(value, (list, tuple)):
        for entry in value:
            source = _extract_image_source(entry, visited)
            if source:
                return source
        return None

    for key in _IMAGE_SOURCE_KEYS:
        if key not in value:
            continue
        source = _extract_image_source(value.get(key), visited)
        if source:
            return source
    return None


def _normalize_image_url(value: object) -> Optional[str]:
    text = _extract_image_source(value)
    if not text:
        return None
    if text.startswith("data:image/"):
        return text
    try:
        parsed = urlparse(text)
        if parsed.scheme not in ("http", "https"):
            return None
        return parsed.geturl()
    except Exception:
        return None


def _append_image_candidate(candidates: List[str], value: object) -> None:
    normalized = _normalize_image_url(value)
    if not normalized:
        return
    if normalized not in candidates:
        candidates.append(normalized)
    try:
        proxied_source = parse_qs(urlparse(normalized).query).get("src", [None])[0]
        decoded = _normalize_image_url(proxied_source)
        if decoded and decoded not in candidates:
            candidates.append(decoded)
    except Exception:
        return


def _get_cached_woo_sku_image_map() -> Dict[str, str]:
    global _CACHED_WOO_SKU_IMAGE_MAP

    if _CACHED_WOO_SKU_IMAGE_MAP is not None:
        return _CACHED_WOO_SKU_IMAGE_MAP

    image_map: Dict[str, str] = {}
    cache_dir = BASE_DIR / "server-data" / "woo-proxy-cache"

    try:
        if not cache_dir.is_dir():
            _CACHED_WOO_SKU_IMAGE_MAP = image_map
            return image_map

        for file_path in sorted(cache_dir.iterdir()):
            if not file_path.is_file() or file_path.suffix.lower() != ".json":
                continue
            try:
                raw = json.loads(file_path.read_text(encoding="utf-8"))
            except Exception:
                continue
            records = raw.get("data") if isinstance(raw, dict) else None
            if not isinstance(records, list):
                continue
            for record in records:
                if not isinstance(record, dict):
                    continue
                sku = str(record.get("sku") or "").strip()
                if not sku or sku in image_map:
                    continue
                image_source = _extract_image_source(record.get("image")) or _extract_image_source(record.get("images"))
                normalized_source = _normalize_image_url(image_source)
                if normalized_source:
                    image_map[sku] = normalized_source
    except Exception:
        _CACHED_WOO_SKU_IMAGE_MAP = image_map
        return image_map

    _CACHED_WOO_SKU_IMAGE_MAP = image_map
    return image_map


def _infer_image_content_type(content_type: object, source_url: object) -> Optional[str]:
    normalized = str(content_type or "").strip().lower()
    if normalized.startswith("image/"):
        image_type = normalized.split(";", 1)[0]
        return image_type if image_type in _SUPPORTED_IMAGE_CONTENT_TYPES else None

    normalized_url = _normalize_image_url(source_url)
    if not normalized_url or normalized_url.startswith("data:image/"):
        return None
    guessed, _ = mimetypes.guess_type(normalized_url)
    if guessed in _SUPPORTED_IMAGE_CONTENT_TYPES:
        return guessed
    return None


def _fetch_image_as_data_url(source_url: object) -> Optional[str]:
    normalized = _normalize_image_url(source_url)
    if not normalized:
        return None
    if normalized.startswith("data:image/"):
        return normalized
    if normalized in _IMAGE_DATA_URL_CACHE:
        return _IMAGE_DATA_URL_CACHE[normalized]
    try:
        request = Request(
            normalized,
            headers={"Accept": _IMAGE_FETCH_ACCEPT_HEADER},
        )
        with urlopen(request, timeout=_REMOTE_IMAGE_FETCH_TIMEOUT_SECONDS) as response:
            content = response.read()
            content_type = _infer_image_content_type(response.headers.get("Content-Type"), normalized)
    except (HTTPError, URLError, ValueError, OSError):
        _IMAGE_DATA_URL_CACHE[normalized] = None
        return None
    if not content_type or not content:
        _IMAGE_DATA_URL_CACHE[normalized] = None
        return None
    data_url = f"data:{content_type};base64,{base64.b64encode(bytes(content)).decode('ascii')}"
    _IMAGE_DATA_URL_CACHE[normalized] = data_url
    return data_url


def _collect_quote_item_image_candidates(item: Dict[str, Any]) -> List[str]:
    candidates: List[str] = []
    _append_image_candidate(candidates, item.get("imageUrl"))
    _append_image_candidate(candidates, item.get("image"))
    _append_image_candidate(candidates, item.get("image_url"))
    _append_image_candidate(candidates, item.get("thumbnail"))
    _append_image_candidate(candidates, item.get("thumb"))

    sku = _safe_text(item.get("sku"))
    if not sku:
        return candidates

    _append_image_candidate(candidates, _get_cached_woo_sku_image_map().get(sku))
    if candidates:
        return candidates

    if sku not in _SKU_PRODUCT_IMAGE_CACHE:
        try:
            from ..integrations.woo_commerce import find_product_by_sku

            product = find_product_by_sku(sku)
        except Exception:
            product = None
        if isinstance(product, dict):
            _SKU_PRODUCT_IMAGE_CACHE[sku] = _extract_image_source(product.get("image")) or _extract_image_source(
                product.get("images")
            )
        else:
            _SKU_PRODUCT_IMAGE_CACHE[sku] = None

    _append_image_candidate(candidates, _SKU_PRODUCT_IMAGE_CACHE.get(sku))
    return candidates


def _resolve_quote_item_image_data_url(item: Dict[str, Any]) -> Optional[str]:
    for candidate in _collect_quote_item_image_candidates(item)[:_MAX_IMAGE_CANDIDATES_PER_ITEM]:
        data_url = _fetch_image_as_data_url(candidate)
        if data_url:
            return data_url
    return None


def _resolve_quote_item_image_data_urls(items: List[Any]) -> List[Optional[str]]:
    resolved_images: List[Optional[str]] = [None] * len(items)
    indexed_items = [(index, item) for index, item in enumerate(items) if isinstance(item, dict)]
    if not indexed_items:
        return resolved_images

    if len(indexed_items) == 1:
        index, item = indexed_items[0]
        resolved_images[index] = _resolve_quote_item_image_data_url(item)
        return resolved_images

    max_workers = min(_MAX_CONCURRENT_IMAGE_RESOLVERS, len(indexed_items))
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="quote-image") as executor:
        future_to_index = {
            executor.submit(_resolve_quote_item_image_data_url, item): index for index, item in indexed_items
        }
        for future in as_completed(future_to_index):
            index = future_to_index[future]
            try:
                resolved_images[index] = future.result()
            except Exception:
                logger.exception("Quote PDF image resolver failed", extra={"item_index": index})
    return resolved_images


def _find_chromium_binary() -> Optional[str]:
    candidates = [
        os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH"),
        os.environ.get("CHROMIUM_EXECUTABLE_PATH"),
        os.environ.get("PUPPETEER_EXECUTABLE_PATH"),
        shutil.which("google-chrome-stable"),
        shutil.which("google-chrome"),
        shutil.which("chromium-browser"),
        shutil.which("chromium"),
        *_iter_playwright_browser_executables(),
        *_iter_existing_paths(
            [
                "/usr/bin/google-chrome-stable",
                "/usr/bin/google-chrome",
                "/usr/bin/chromium-browser",
                "/usr/bin/chromium",
                "/opt/google/chrome/chrome",
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            ]
        ),
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _render_quote_html(quote: Dict) -> str:
    payload = quote.get("quotePayloadJson") if isinstance(quote.get("quotePayloadJson"), dict) else {}
    prospect = payload.get("prospect") if isinstance(payload.get("prospect"), dict) else {}
    sales_rep = payload.get("salesRep") if isinstance(payload.get("salesRep"), dict) else {}
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    logo_data_url = _get_logo_data_url()
    fallback_item_image = _get_fallback_icon_data_url()
    title = _safe_text(quote.get("title") or payload.get("title"), "Quote")
    currency = _safe_text(quote.get("currency") or payload.get("currency"), "USD").upper()
    notes = _safe_text(payload.get("notes"))
    subtotal = _format_money(quote.get("subtotal") if quote.get("subtotal") is not None else payload.get("subtotal"), currency)

    resolved_images = _resolve_quote_item_image_data_urls(items)

    row_fragments: List[str] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        quantity = max(1, int(float(item.get("quantity") or 1)))
        unit_price = _format_money(item.get("unitPrice"), currency)
        line_total_value = item.get("lineTotal")
        if line_total_value is None:
            line_total_value = _as_float(item.get("unitPrice")) * quantity
        line_total = _format_money(line_total_value, currency)
        image_src = resolved_images[index] or fallback_item_image
        image_markup = (
            f'<img class="item-thumb" src="{_escape_html(image_src)}" alt="{_escape_html(item.get("name") or "Item")}" />'
            if image_src
            else '<div class="item-thumb item-thumb--empty"></div>'
        )
        note_markup = f'<div class="item-meta">{_escape_html(item.get("note"))}</div>' if _safe_text(item.get("note")) else ""
        row_fragments.append(
            f"""
      <tr>
        <td class="col-index">{index + 1}</td>
        <td>
          <div class="item-cell">
            <div class="item-thumb-shell">
              {image_markup}
            </div>
            <div class="item-copy">
              <div class="item-name">{_escape_html(item.get("name") or "Item")}</div>
              {note_markup}
            </div>
          </div>
        </td>
        <td class="numeric">{quantity}</td>
        <td class="numeric">{_escape_html(unit_price)}</td>
        <td class="numeric">{_escape_html(line_total)}</td>
      </tr>
            """.strip()
        )
    rows = "\n".join(row_fragments) or '<tr><td colspan="5">No items</td></tr>'
    notes_markup = (
        f"""
      <div class="notes">
        <div class="meta-label">Notes</div>
        <p>{_escape_html(notes)}</p>
      </div>
        """.strip()
        if notes
        else ""
    )

    return f"""<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>{_escape_html(title)}</title>
    <style>
      @page {{
        size: Letter;
        margin: 18px;
      }}
      :root {{
        color-scheme: light;
        --ink: #0f172a;
        --muted: #475569;
        --line: #dbe2ea;
        --accent: #0f4c81;
        --accent-soft: #eff6ff;
      }}
      * {{ box-sizing: border-box; }}
      body {{
        margin: 0;
        font-family: "Helvetica Neue", Arial, sans-serif;
        color: var(--ink);
        background: #fff;
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }}
      .page {{
        padding: 28px 24px 36px;
      }}
      .hero {{
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        padding-bottom: 18px;
        border-bottom: 2px solid var(--accent);
      }}
      .hero-brand {{
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
      }}
      .brand-logo {{
        display: block;
        width: 190px;
        max-width: 100%;
        height: auto;
      }}
      .brand {{
        font-size: 28px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--accent);
      }}
      .title {{
        margin: 8px 0 0;
        font-size: 24px;
        font-weight: 700;
      }}
      .subtle {{
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }}
      .meta-grid {{
        margin-top: 20px;
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }}
      .meta-card {{
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 16px;
        background: #fff;
      }}
      .meta-label {{
        margin-bottom: 8px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }}
      .meta-value {{
        font-size: 14px;
        line-height: 1.6;
      }}
      table {{
        width: 100%;
        border-collapse: collapse;
        margin-top: 18px;
        font-size: 13px;
      }}
      thead th {{
        text-align: left;
        padding: 10px 12px;
        background: var(--accent-soft);
        color: var(--accent);
        border-bottom: 1px solid var(--line);
        font-size: 11px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }}
      tbody td {{
        padding: 12px;
        border-bottom: 1px solid var(--line);
        vertical-align: top;
      }}
      .col-index {{
        width: 32px;
        color: var(--muted);
      }}
      .numeric {{
        text-align: right;
        white-space: nowrap;
      }}
      .item-name {{
        font-weight: 700;
        font-size: 13px;
      }}
      .item-cell {{
        display: flex;
        align-items: flex-start;
        gap: 12px;
      }}
      .item-thumb-shell {{
        width: 44px;
        min-width: 44px;
        height: 44px;
        border-radius: 8px;
        overflow: hidden;
        border: 1px solid var(--line);
        background: #f8fafc;
      }}
      .item-thumb {{
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
        object-position: center;
      }}
      .item-thumb--empty {{
        background: #f8fafc;
      }}
      .item-copy {{
        min-width: 0;
      }}
      .item-meta {{
        margin-top: 4px;
        color: var(--muted);
        font-size: 11px;
      }}
      .summary-row {{
        display: flex;
        justify-content: flex-end;
        align-items: baseline;
        gap: 0.45rem;
        margin-top: 22px;
        margin-left: auto;
        width: 260px;
        text-align: right;
        color: var(--accent);
        font-weight: 800;
        font-size: 16px;
      }}
      .notes {{
        margin-top: 18px;
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 16px;
      }}
      .notes p {{
        margin: 0;
        white-space: pre-wrap;
        line-height: 1.6;
      }}
      .footer {{
        margin-top: 30px;
        padding-top: 12px;
        border-top: 1px solid var(--line);
        color: var(--muted);
        font-size: 11px;
        line-height: 1.6;
      }}
    </style>
  </head>
  <body>
    <div class="page">
      <div class="hero">
        <div class="hero-brand">
          {f'<img class="brand-logo" src="{_escape_html(logo_data_url)}" alt="PepPro" />' if logo_data_url else '<div class="brand">PepPro</div>'}
          <div class="title">{_escape_html(title)}</div>
          <div class="subtle">Revision R{max(1, int(float(quote.get("revisionNumber") or 1)))}</div>
        </div>
      </div>

      <div class="meta-grid">
        <div class="meta-card">
          <div class="meta-label">Prospect</div>
          <div class="meta-value">
            <div>{_escape_html(prospect.get("contactName") or prospect.get("name") or "Prospect")}</div>
            {f'<div>{_escape_html(prospect.get("contactEmail"))}</div>' if _safe_text(prospect.get("contactEmail")) else ''}
            {f'<div>{_escape_html(prospect.get("contactPhone"))}</div>' if _safe_text(prospect.get("contactPhone")) else ''}
          </div>
        </div>
        <div class="meta-card">
          <div class="meta-label">Sales Rep</div>
          <div class="meta-value">
            <div>{_escape_html(sales_rep.get("name") or "PepPro")}</div>
            {f'<div>{_escape_html(sales_rep.get("email"))}</div>' if _safe_text(sales_rep.get("email")) else ''}
          </div>
        </div>
      </div>

      {notes_markup}

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th class="numeric">Qty</th>
            <th class="numeric">Unit</th>
            <th class="numeric">Line Total</th>
          </tr>
        </thead>
        <tbody>
          {rows}
        </tbody>
      </table>

      <div class="summary-row">
        <span>Subtotal:</span>
        <span>{_escape_html(subtotal)}</span>
      </div>

      <div class="footer">
        This quote is a sales summary generated by PepPro. Shipping, tax, and payment terms are excluded from this revision.
      </div>
    </div>
  </body>
</html>"""


def _run_system_browser_renderer(quote: Dict) -> Optional[Dict]:
    started_at = time.monotonic()
    browser_binary = _find_chromium_binary()
    if not browser_binary:
        logger.error("Quote PDF browser renderer unavailable", extra={"browser_binary": None})
        return None

    try:
        html_content = _render_quote_html(quote)
    except Exception:
        logger.exception("Quote PDF browser renderer failed to render HTML")
        return None

    with tempfile.TemporaryDirectory(prefix="peppro-quote-pdf-") as temp_dir:
        temp_path = Path(temp_dir)
        html_path = temp_path / "quote.html"
        pdf_path = temp_path / "quote.pdf"
        html_path.write_text(html_content, encoding="utf-8")

        command = [
            browser_binary,
            "--headless",
            "--disable-gpu",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--allow-file-access-from-files",
            "--print-to-pdf-no-header",
            f"--print-to-pdf={pdf_path}",
            html_path.resolve().as_uri(),
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                cwd=str(BASE_DIR),
                timeout=_BROWSER_PDF_TIMEOUT_SECONDS,
                check=False,
            )
        except Exception:
            logger.exception("Quote PDF browser renderer failed to execute", extra={"browser_binary": browser_binary})
            return None

        if completed.returncode != 0 or not pdf_path.exists():
            logger.error(
                "Quote PDF browser renderer exited non-zero",
                extra={
                    "browser_binary": browser_binary,
                    "returncode": completed.returncode,
                    "stderr": (completed.stderr or "")[:1000],
                    "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
                },
            )
            return None

        try:
            pdf = pdf_path.read_bytes()
        except Exception:
            logger.exception("Quote PDF browser renderer could not read output PDF", extra={"browser_binary": browser_binary})
            return None

    logger.info(
        "Quote PDF renderer completed",
        extra={
            "renderer": "system_browser",
            "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
            "browser_binary": browser_binary,
        },
    )
    return {
        "pdf": pdf,
        "filename": _build_quote_filename(quote),
    }


def _safe_text(value: object, fallback: str = "") -> str:
    text = str(value or "").strip()
    return text or fallback


def _sanitize_filename(value: object, fallback: str = "Prospect") -> str:
    raw = _safe_text(value, fallback)
    safe = "".join(char if char.isalnum() or char in ("_", "-") else "_" for char in raw)
    safe = safe.strip("_")
    return (safe[:80] or fallback).strip("_") or fallback


def _build_quote_filename(quote: Dict) -> str:
    payload = quote.get("quotePayloadJson") if isinstance(quote.get("quotePayloadJson"), dict) else {}
    prospect = payload.get("prospect") if isinstance(payload.get("prospect"), dict) else {}
    prospect_name = (
        _safe_text(prospect.get("contactName"))
        or _safe_text(prospect.get("name"))
        or _safe_text(prospect.get("identifier"))
        or _safe_text(quote.get("prospectId"))
        or "Prospect"
    )
    try:
        revision = max(1, int(float(quote.get("revisionNumber") or 1)))
    except Exception:
        revision = 1
    return f"PepPro_Quote_{_sanitize_filename(prospect_name)}_{revision}.pdf"


def _as_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _format_money(amount: object, currency: str = "USD") -> str:
    normalized = _safe_text(currency, "USD").upper()
    symbol = "$" if normalized == "USD" else f"{normalized} "
    value = _as_float(amount, 0.0)
    return f"{symbol}{value:,.2f}"


def _format_datetime(value: object) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.strftime("%b %d, %Y %I:%M %p")
    text = _safe_text(value)
    if not text:
        return ""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        return parsed.strftime("%b %d, %Y %I:%M %p")
    except Exception:
        return text


def _build_fallback_quote_pdf(quote: Dict) -> Dict:
    payload = quote.get("quotePayloadJson") if isinstance(quote.get("quotePayloadJson"), dict) else {}
    items = payload.get("items") if isinstance(payload.get("items"), list) else []
    prospect = payload.get("prospect") if isinstance(payload.get("prospect"), dict) else {}
    sales_rep = payload.get("salesRep") if isinstance(payload.get("salesRep"), dict) else {}

    currency = _safe_text(quote.get("currency") or payload.get("currency"), "USD").upper()
    title = _safe_text(quote.get("title") or payload.get("title"), "Quote")
    try:
        revision = max(1, int(float(quote.get("revisionNumber") or 1)))
    except Exception:
        revision = 1
    subtotal = _format_money(quote.get("subtotal") if quote.get("subtotal") is not None else payload.get("subtotal"), currency)
    notes = _safe_text(payload.get("notes"))

    lines: List[str] = [
        "PepPro Quote",
        "",
        title,
        f"Revision R{revision}",
        "",
    ]

    prospect_name = _safe_text(prospect.get("contactName"), "Prospect")
    lines.append(f"Prospect: {prospect_name}")
    prospect_email = _safe_text(prospect.get("contactEmail"))
    if prospect_email:
        lines.append(f"Email: {prospect_email}")
    prospect_phone = _safe_text(prospect.get("contactPhone"))
    if prospect_phone:
        lines.append(f"Phone: {prospect_phone}")

    sales_rep_name = _safe_text(sales_rep.get("name"))
    if sales_rep_name:
        lines.append(f"Sales Rep: {sales_rep_name}")
    sales_rep_email = _safe_text(sales_rep.get("email"))
    if sales_rep_email:
        lines.append(f"Sales Rep Email: {sales_rep_email}")

    updated_at = _format_datetime(quote.get("updatedAt"))
    if updated_at:
        lines.append(f"Updated: {updated_at}")

    if notes:
        lines.append("")
        lines.append("Notes:")
        lines.extend([f"  {line}" for line in notes.splitlines() if line.strip()] or ["  —"])

    lines.append("")
    lines.append("Items:")
    if not items:
        lines.append("  —")
    else:
        for item in items:
            if not isinstance(item, dict):
                continue
            name = _safe_text(item.get("name"), "Item")
            try:
                quantity = max(1, int(float(item.get("quantity") or 1)))
            except Exception:
                quantity = 1
            unit_price = _format_money(item.get("unitPrice"), currency)
            line_total = _format_money(item.get("lineTotal"), currency)
            sku = _safe_text(item.get("sku"))
            sku_part = f" [{sku}]" if sku else ""
            lines.append(f"  {quantity} x {name}{sku_part} @ {unit_price} = {line_total}")
            note = _safe_text(item.get("note"))
            if note:
                lines.append(f"    Note: {note}")

    lines.append("")
    lines.append(f"Subtotal: {subtotal}")

    pdf = _build_simple_text_pdf(lines)
    return {
        "pdf": pdf,
        "filename": _build_quote_filename(quote),
    }


def _run_node_worker_bridge(quote: Dict) -> Optional[Dict]:
    started_at = time.monotonic()
    with _NODE_WORKER_LOCK:
        process = _ensure_node_worker_process()
        if process is None or process.stdin is None or process.stdout is None:
            return None

        request_id = uuid.uuid4().hex
        request_payload = json.dumps({"id": request_id, "quote": quote or {}}, ensure_ascii=False)

        try:
            process.stdin.write(f"{request_payload}\n")
            process.stdin.flush()
        except Exception:
            logger.exception("Quote PDF node worker request failed to write")
            _shutdown_node_worker_process()
            return None

        try:
            ready, _, _ = select.select([process.stdout], [], [], _NODE_WORKER_REQUEST_TIMEOUT_SECONDS)
        except Exception:
            logger.exception("Quote PDF node worker failed while waiting for response")
            _shutdown_node_worker_process()
            return None

        if not ready:
            logger.error(
                "Quote PDF node worker timed out",
                extra={"duration_ms": round((time.monotonic() - started_at) * 1000, 1)},
            )
            _shutdown_node_worker_process()
            return None

        response_line = process.stdout.readline()
        if not response_line:
            stderr_output = ""
            try:
                if process.stderr is not None:
                    stderr_output = (process.stderr.read() or "")[:1000]
            except Exception:
                stderr_output = ""
            logger.error(
                "Quote PDF node worker returned no response",
                extra={
                    "returncode": process.poll(),
                    "stderr": stderr_output,
                    "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
                },
            )
            _shutdown_node_worker_process()
            return None

        try:
            payload = json.loads(response_line)
        except Exception:
            logger.exception("Quote PDF node worker returned invalid JSON")
            _shutdown_node_worker_process()
            return None

        if payload.get("id") != request_id:
            logger.error("Quote PDF node worker returned mismatched response id")
            _shutdown_node_worker_process()
            return None

        if payload.get("error"):
            logger.error(
                "Quote PDF node worker returned render error",
                extra={
                    "stderr": str(payload.get("error"))[:1000],
                    "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
                },
            )
            _shutdown_node_worker_process()
            return None

        pdf_base64 = payload.get("pdfBase64")
        if not isinstance(pdf_base64, str) or not pdf_base64.strip():
            logger.error("Quote PDF node worker returned no pdfBase64 payload")
            _shutdown_node_worker_process()
            return None

        try:
            pdf = base64.b64decode(pdf_base64)
        except Exception:
            logger.exception("Quote PDF node worker returned invalid base64 PDF")
            _shutdown_node_worker_process()
            return None

        filename = _safe_text(payload.get("filename"), _build_quote_filename(quote))
        logger.info(
            "Quote PDF renderer completed",
            extra={
                "renderer": "node_worker",
                "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
            },
        )
        return {
            "pdf": pdf,
            "filename": filename,
        }


def _run_node_bridge(quote: Dict) -> Optional[Dict]:
    global _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC
    started_at = time.monotonic()

    retry_after_seconds = _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC - time.monotonic()
    if retry_after_seconds > 0:
        logger.warning(
            "Quote PDF node bridge temporarily skipped after recent failure",
            extra={"retry_after_seconds": round(retry_after_seconds, 2)},
        )
        return None

    script_path = _bridge_script_path()
    node_binary = _find_node_binary()
    if not script_path.exists() or not node_binary:
        _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + _NODE_BRIDGE_RETRY_COOLDOWN_SECONDS
        logger.error(
            "Quote PDF node bridge unavailable",
            extra={
                "script_path": str(script_path),
                "script_exists": script_path.exists(),
                "node_binary": node_binary,
            },
        )
        return None

    command = [node_binary, str(script_path)]
    env = _build_node_renderer_env(node_binary)

    try:
        completed = subprocess.run(
            command,
            input=json.dumps({"quote": quote or {}}, ensure_ascii=False),
            capture_output=True,
            text=True,
            cwd=str(BASE_DIR),
            env=env,
            timeout=_PDF_BRIDGE_TIMEOUT_SECONDS,
            check=False,
        )
    except Exception:
        _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + _NODE_BRIDGE_RETRY_COOLDOWN_SECONDS
        logger.exception("Quote PDF node bridge failed to execute")
        return None

    if completed.returncode != 0:
        _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + _NODE_BRIDGE_RETRY_COOLDOWN_SECONDS
        logger.error(
            "Quote PDF node bridge exited non-zero",
            extra={
                "returncode": completed.returncode,
                "node_binary": node_binary,
                "playwright_browsers_path": env.get("PLAYWRIGHT_BROWSERS_PATH"),
                "stderr": (completed.stderr or "")[:1000],
                "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
            },
        )
        return None

    try:
        payload = json.loads(completed.stdout or "{}")
    except Exception:
        _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + _NODE_BRIDGE_RETRY_COOLDOWN_SECONDS
        logger.exception("Quote PDF node bridge returned invalid JSON")
        return None

    pdf_base64 = payload.get("pdfBase64")
    if not isinstance(pdf_base64, str) or not pdf_base64.strip():
        _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + _NODE_BRIDGE_RETRY_COOLDOWN_SECONDS
        logger.error("Quote PDF node bridge returned no pdfBase64 payload")
        return None

    try:
        pdf = base64.b64decode(pdf_base64)
    except Exception:
        _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = time.monotonic() + _NODE_BRIDGE_RETRY_COOLDOWN_SECONDS
        logger.exception("Quote PDF node bridge returned invalid base64 PDF")
        return None

    _NODE_BRIDGE_SKIP_UNTIL_MONOTONIC = 0.0
    filename = _safe_text(payload.get("filename"), _build_quote_filename(quote))
    logger.info(
        "Quote PDF renderer completed",
        extra={
            "renderer": "node_bridge",
            "duration_ms": round((time.monotonic() - started_at) * 1000, 1),
            "node_binary": node_binary,
        },
    )
    return {
        "pdf": pdf,
        "filename": filename,
    }


def generate_prospect_quote_pdf(quote: Dict) -> Dict:
    cache_key = _build_quote_render_cache_key(quote)
    cached = _get_cached_rendered_quote_pdf(cache_key)
    if cached is not None:
        logger.info("Quote PDF cache hit", extra={"cache_key": cache_key, "cache_layer": "memory"})
        return cached

    rendered = _run_node_worker_bridge(quote)
    if rendered is not None:
        _store_rendered_quote_pdf(cache_key, rendered)
        return rendered

    rendered = _run_node_bridge(quote)
    if rendered is not None:
        _store_rendered_quote_pdf(cache_key, rendered)
        return rendered
    rendered = _run_system_browser_renderer(quote)
    if rendered is not None:
        _store_rendered_quote_pdf(cache_key, rendered)
        return rendered
    if _allow_text_fallback():
        logger.warning("Falling back to Python quote PDF generator")
        return _build_fallback_quote_pdf(quote)
    raise _service_error("QUOTE_PDF_RENDERER_UNAVAILABLE", 500)
