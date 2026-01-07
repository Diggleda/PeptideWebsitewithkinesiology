from __future__ import annotations

import faulthandler
import os
import signal
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = BASE_DIR.parent

if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from python_backend import create_app  # type: ignore  # noqa: E402

app = create_app()

try:
    # Allow dumping all thread stack traces on demand (helps debug "hung" VPS backends).
    # Usage (on VPS): `sudo kill -USR1 <gunicorn_worker_pid>` then check service logs.
    faulthandler.register(signal.SIGUSR1, all_threads=True)
except Exception:
    pass


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=app.config.get("PORT", 3001), debug=app.config.get("DEBUG", False))
