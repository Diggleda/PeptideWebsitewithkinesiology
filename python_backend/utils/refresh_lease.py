from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from typing import Optional


def acquire_lease(path: Path, *, lease_seconds: float) -> Optional[str]:
    path.parent.mkdir(parents=True, exist_ok=True)

    token = uuid.uuid4().hex
    payload = {
        "token": token,
        "pid": os.getpid(),
        "expiresAt": time.time() + max(1.0, float(lease_seconds)),
    }
    encoded = json.dumps(payload, separators=(",", ":"))

    while True:
        try:
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            if _read_expires_at(path) > time.time():
                return None
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError:
                return None
            continue
        except OSError:
            return None

        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(encoded)
        except Exception:
            try:
                path.unlink()
            except OSError:
                pass
            return None
        return token


def release_lease(path: Path, token: Optional[str]) -> None:
    if not token:
        return
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(payload, dict) or str(payload.get("token") or "") != token:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _read_expires_at(path: Path) -> float:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return 0.0
    if not isinstance(payload, dict):
        return 0.0
    try:
        return float(payload.get("expiresAt") or 0.0)
    except Exception:
        return 0.0
