"""PIN-based authentication for TmuxDeck.

Provides PIN hashing/verification, session management, and settings
integration via the store module.
"""

from __future__ import annotations

import hashlib
import os
import secrets
import time
from typing import Any

from . import store

# In-memory session store: token → expiry timestamp
_sessions: dict[str, float] = {}

SESSION_MAX_AGE = 7 * 24 * 60 * 60  # 7 days in seconds


def hash_pin(pin: str) -> str:
    """Hash a PIN with a random salt. Returns ``"salt_hex:hash_hex"``."""
    salt = os.urandom(16)
    h = hashlib.sha256(salt + pin.encode()).hexdigest()
    return f"{salt.hex()}:{h}"


def verify_pin(pin: str, stored: str) -> bool:
    """Verify *pin* against a ``"salt_hex:hash_hex"`` string (timing-safe)."""
    try:
        salt_hex, expected_hex = stored.split(":", 1)
    except ValueError:
        return False
    salt = bytes.fromhex(salt_hex)
    actual_hex = hashlib.sha256(salt + pin.encode()).hexdigest()
    return secrets.compare_digest(actual_hex, expected_hex)


def create_session() -> str:
    """Create a new session token and store it in memory."""
    token = secrets.token_urlsafe(32)
    _sessions[token] = time.time() + SESSION_MAX_AGE
    return token


def validate_session(token: str) -> bool:
    """Return True if *token* exists and hasn't expired."""
    expiry = _sessions.get(token)
    if expiry is None:
        return False
    if time.time() > expiry:
        _sessions.pop(token, None)
        return False
    return True


def destroy_session(token: str) -> None:
    """Remove a session token."""
    _sessions.pop(token, None)


# --- Settings helpers ---


def _get_settings() -> dict[str, Any]:
    return store.get_settings()


def is_pin_set() -> bool:
    return bool(_get_settings().get("pinHash"))


def get_pin_hash() -> str | None:
    return _get_settings().get("pinHash") or None


def set_pin_hash(pin_hash: str) -> None:
    store.update_settings({"pinHash": pin_hash})
