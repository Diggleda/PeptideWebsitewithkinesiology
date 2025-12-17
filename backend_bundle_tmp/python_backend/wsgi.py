from __future__ import annotations

import os
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from python_backend import create_app  # type: ignore  # noqa: E402

app = create_app()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=app.config.get("PORT", 3001), debug=app.config.get("DEBUG", False))
