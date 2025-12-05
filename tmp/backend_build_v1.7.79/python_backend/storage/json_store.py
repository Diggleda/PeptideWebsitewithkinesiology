from __future__ import annotations

import base64
import json
import logging
import os
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable, Generic, Optional, TypeVar

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

logger = logging.getLogger(__name__)

T = TypeVar("T")


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

    def read(self) -> T:
        self._ensure_dir()
        if not self.file_path.exists():
            return self.default_factory()
        raw = self.file_path.read_text(encoding="utf-8")
        if not raw:
            return self.default_factory()

        key = self._get_key()
        if key:
            try:
                envelope = json.loads(raw)
                if (
                    isinstance(envelope, dict)
                    and envelope.get("v") == 1
                    and "iv" in envelope
                    and "payload" in envelope
                    and "tag" in envelope
                ):
                    decrypted = self._decrypt(envelope, key)
                    return json.loads(decrypted)
            except Exception as exc:  # pragma: no cover - logged path
                logger.error("Failed to decrypt %s: %s", self.file_name, exc, exc_info=True)

        return json.loads(raw)

    def write(self, data: T) -> None:
        self._ensure_dir()
        key = self._get_key()
        if key:
            serialized = json.dumps(data, ensure_ascii=False)
            envelope = self._encrypt(serialized, key)
            payload = json.dumps(envelope, indent=2)
        else:
            payload = json.dumps(data, indent=2, ensure_ascii=False)
        self.file_path.write_text(payload, encoding="utf-8")

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
