from __future__ import annotations

import json
from pathlib import Path

from python_backend.services import sales_prospect_quote_pdf_service as quote_pdf_service


def main() -> int:
    bridge_script = quote_pdf_service._bridge_script_path()  # noqa: SLF001
    node_binary = quote_pdf_service._find_node_binary()  # noqa: SLF001
    playwright_browsers_path = quote_pdf_service._find_playwright_browsers_path()  # noqa: SLF001
    chromium_binary = quote_pdf_service._find_chromium_binary()  # noqa: SLF001
    text_fallback_enabled = quote_pdf_service._allow_text_fallback()  # noqa: SLF001

    payload = {
        "bridgeScriptPath": str(bridge_script),
        "bridgeScriptExists": bridge_script.exists(),
        "nodeBinary": node_binary,
        "playwrightBrowsersPath": playwright_browsers_path,
        "chromiumBinary": chromium_binary,
        "textFallbackEnabled": text_fallback_enabled,
        "nodeBridgeReady": bool(bridge_script.exists() and node_binary),
        "systemBrowserReady": bool(chromium_binary),
        "rendererAvailable": bool((bridge_script.exists() and node_binary) or chromium_binary or text_fallback_enabled),
        "cwd": str(Path.cwd()),
    }
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0 if payload["rendererAvailable"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
