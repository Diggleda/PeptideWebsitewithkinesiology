from __future__ import annotations

import base64
import json
import logging
import os
import time
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable, Generic, Optional, TypeVar

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

T = TypeVar("T")

try:  # pragma: no cover - platform dependent
    import fcntl  # type: ignore
except Exception:  # pragma: no cover - platform dependent
    fcntl = None  # type: ignore


def _derive_key(secret: str) -> bytes:
    return sha256(secret.encode("utf-8")).digest()


@dataclass
class JsonStore(Generic[T]):
    base_dir: Path
    file_name: str
    default_factory: Callable[[], T]
    encryption_secret: Optional[str] = None
    encryption_algorithm: str = "aes-256-gcm"

    def __post_init__(self) -> None:
        self.file_path = self.base_dir / self.file_name
        self.lock_path = self.base_dir / f"{self.file_name}.lock"

    def _ensure_dir(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _get_key(self) -> Optional[bytes]:
        if not self.encryption_secret:
            return None
        return _derive_key(self.encryption_secret)

    def init(self) -> None:
        self._ensure_dir()
        if not self.file_path.exists():
            self.write(self.default_factory())

    def _acquire_lock(self, shared: bool) -> Any:
        self._ensure_dir()
        lock_file = open(self.lock_path, "a+", encoding="utf-8")
        if fcntl is None:
            return lock_file
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
        except Exception:
            try:
                lock_file.close()
            except Exception:
                pass
            raise
        return lock_file

    def _release_lock(self, lock_file: Any) -> None:
        try:
            if fcntl is not None:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            try:
                lock_file.close()
            except Exception:
                pass

    def _safe_json_loads(self, raw: str) -> tuple[Any, bool]:
        """
        Loads JSON but can recover from files that accidentally contain multiple
        JSON values concatenated together (common when multiple processes write
        without locking).

        Returns (value, had_extra_data).
        """
        decoder = json.JSONDecoder()
        idx = 0
        values: list[Any] = []
        raw_len = len(raw)

        while idx < raw_len:
            while idx < raw_len and raw[idx].isspace():
                idx += 1
            if idx >= raw_len:
                break
            value, end = decoder.raw_decode(raw, idx)
            values.append(value)
            idx = end

        if not values:
            raise json.JSONDecodeError("Empty JSON", raw, 0)

        if len(values) == 1:
            return values[0], False

        combined: Any = values[0]
        for next_value in values[1:]:
            if isinstance(combined, list):
                if isinstance(next_value, list):
                    combined.extend(next_value)
                elif isinstance(next_value, dict):
                    combined.append(next_value)
                else:
                    break
            elif isinstance(combined, dict) and isinstance(next_value, dict):
                combined.update(next_value)
            else:
                break

        return combined, True

    def _write_payload_atomic(self, payload: str) -> None:
        self._ensure_dir()
        lock_file = self._acquire_lock(shared=False)
        try:
            tmp_path = self.file_path.with_suffix(
                self.file_path.suffix + f".tmp.{os.getpid()}.{int(time.time() * 1000)}"
            )
            tmp_path.write_text(payload, encoding="utf-8")
            try:
                with open(tmp_path, "rb") as fp:
                    os.fsync(fp.fileno())
            except Exception:
                pass
            os.replace(tmp_path, self.file_path)
        finally:
            self._release_lock(lock_file)

    def read(self) -> T:
        self._ensure_dir()
        if not self.file_path.exists():
            return self.default_factory()
        lock_file = self._acquire_lock(shared=True)
        try:
            raw = self.file_path.read_text(encoding="utf-8")
        finally:
            self._release_lock(lock_file)
        if not raw:
            return self.default_factory()

        key = self._get_key()
        if key:
            try:
                envelope, had_extra = self._safe_json_loads(raw)
                if (
                    isinstance(envelope, dict)
                    and envelope.get("v") == 1
                    and "iv" in envelope
                    and "payload" in envelope
                    and "tag" in envelope
                ):
                    decrypted = self._decrypt(envelope, key)
                    value, had_extra_decrypted = self._safe_json_loads(decrypted)
                    if had_extra_decrypted:
                        logger.warning(
                            "Recovered %s with extra JSON data after decryption; rewriting canonical file.",
                            self.file_name,
                        )
                        try:
                            self.write(value)  # type: ignore[arg-type]
                        except Exception:
                            logger.warning(
                                "Failed to rewrite recovered %s", self.file_name, exc_info=True
                            )
                    return value
                if had_extra:
                    logger.warning(
                        "Recovered %s with extra JSON data; rewriting canonical file.",
                        self.file_name,
                    )
                    try:
                        self.write(envelope)  # type: ignore[arg-type]
                    except Exception:
                        logger.warning(
                            "Failed to rewrite recovered %s", self.file_name, exc_info=True
                        )
                    return envelope
            except Exception as exc:  # pragma: no cover - logged path
                logger.error("Failed to decrypt %s: %s", self.file_name, exc, exc_info=True)

        try:
            value, had_extra = self._safe_json_loads(raw)
            if had_extra:
                logger.warning(
                    "Recovered %s with extra JSON data; rewriting canonical file.",
                    self.file_name,
                )
                try:
                    self.write(value)  # type: ignore[arg-type]
                except Exception:
                    logger.warning(
                        "Failed to rewrite recovered %s", self.file_name, exc_info=True
                    )
            return value
        except json.JSONDecodeError:
            # If the JSON is completely corrupted, avoid cascading failures.
            logger.warning("JSON store %s is corrupted; serving default", self.file_name, exc_info=True)
            try:
                corrupt_path = self.file_path.with_suffix(
                    self.file_path.suffix + f".corrupt.{int(time.time())}"
                )
                os.replace(self.file_path, corrupt_path)
            except Exception:
                pass
            return self.default_factory()

    def write(self, data: T) -> None:
        self._ensure_dir()
        key = self._get_key()
        if key:
            serialized = json.dumps(data, ensure_ascii=False)
            envelope = self._encrypt(serialized, key)
            payload = json.dumps(envelope, indent=2)
        else:
            payload = json.dumps(data, indent=2, ensure_ascii=False)
        self._write_payload_atomic(payload)

    # Internal helpers -------------------------------------------------

    def _encrypt(self, plaintext: str, key: bytes) -> dict[str, Any]:
        aes = AESGCM(key)
        iv = os.urandom(12)
        ciphertext = aes.encrypt(iv, plaintext.encode("utf-8"), None)
        tag = ciphertext[-16:]
        payload = ciphertext[:-16]
        return {
            "v": 1,
            "alg": self.encryption_algorithm,
            "iv": base64.b64encode(iv).decode("ascii"),
            "tag": base64.b64encode(tag).decode("ascii"),
            "payload": base64.b64encode(payload).decode("ascii"),
        }

    def _decrypt(self, envelope: dict[str, Any], key: bytes) -> str:
        aes = AESGCM(key)
        iv = base64.b64decode(envelope["iv"])
        tag = base64.b64decode(envelope["tag"])
        payload = base64.b64decode(envelope["payload"])
        ciphertext = payload + tag
        plaintext = aes.decrypt(iv, ciphertext, None)
        return plaintext.decode("utf-8")
