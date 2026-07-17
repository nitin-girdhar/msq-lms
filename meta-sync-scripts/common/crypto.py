"""AES-256-GCM decryption for secrets at rest.

Python port of services/meta-conversion-api/src/lib/crypto.ts. Must stay in
sync with that file's ciphertext format:

    enc:v1:<iv_b64>:<authTag_b64>:<ciphertext_b64>

Values without the "enc:v1:" prefix are legacy/dev plaintext and are
returned as-is, matching the Node implementation.
"""

import base64
from typing import Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import config

ENC_PREFIX = "enc:v1:"


def _get_key() -> Optional[bytes]:
    raw = config.META_ENCRYPTION_KEY
    if not raw:
        return None
    key = bytes.fromhex(raw) if len(raw) == 64 else base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError("META_ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64)")
    return key


def decrypt_secret(value: Optional[str]) -> str:
    if not value:
        return ""
    if not value.startswith(ENC_PREFIX):
        return value  # legacy plaintext

    key = _get_key()
    if key is None:
        raise RuntimeError("Encrypted secret present but META_ENCRYPTION_KEY is not configured")

    parts = value[len(ENC_PREFIX):].split(":")
    if len(parts) != 3:
        raise RuntimeError("Malformed encrypted secret")
    iv_b64, tag_b64, ct_b64 = parts

    iv = base64.b64decode(iv_b64)
    tag = base64.b64decode(tag_b64)
    ciphertext = base64.b64decode(ct_b64)

    # Node's crypto keeps the GCM auth tag separate from the ciphertext;
    # cryptography's AESGCM expects them concatenated (ciphertext || tag).
    aesgcm = AESGCM(key)
    plaintext = aesgcm.decrypt(iv, ciphertext + tag, None)
    return plaintext.decode("utf-8")
