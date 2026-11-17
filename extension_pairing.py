"""Pairing the SuperBookmarks browser extension with the app on this computer.

The owner shows a one-time code in Settings (it works once, for 10 minutes) and types it into the
extension's options. The extension gets a token in exchange. The token lets the extension do two
things only: ask whether a page is saved, and (later) add links. Only a hash of each token is kept,
in the data folder beside the other settings, with the same file protection.

The code itself never travels, and the app proves it knows the code first: a program listening on
the address the extension was given gets nothing it could work the code out from, and can't pass
for the app.
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import telegram_config

CODE_LIFETIME = 10 * 60
CODE_ATTEMPTS = 5              # wrong tries before the code stops working
MAX_CONNECTIONS = 10
_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"   # no 0/O, 1/I/L
_lock = threading.Lock()
_code = None                   # {"code", "expires", "attempts", "asked"}: in memory only; a restart clears it
_seen = {}                     # connection id -> last time "last used" was written (at most once a minute)


class PairingError(Exception):
    """`code` is a fixed word: expired, wrong, used_up, too_many."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _path() -> Path:
    return telegram_config.config_path().parent / "extension.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _load() -> list:
    try:
        data = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = data.get("connections") if isinstance(data, dict) else None
    return [c for c in items if isinstance(c, dict) and isinstance(c.get("hash"), str) and isinstance(c.get("id"), str)] if isinstance(items, list) else []


def _save(connections: list) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".extension-", suffix=".tmp", dir=path.parent)
    try:
        telegram_config.protect_file(temporary)
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = None
            stream.write(json.dumps({"connections": connections}, ensure_ascii=True).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if os.path.exists(temporary):
            os.unlink(temporary)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def new_code() -> dict:
    """A fresh pairing code (the previous one stops working)."""
    global _code
    code = "".join(secrets.choice(_ALPHABET) for _ in range(8))
    with _lock:
        _code = {"code": code, "expires": time.time() + CODE_LIFETIME, "attempts": 0}
        return pending_code()


def pending_code():
    """The code shown in Settings, while it still works."""
    if not _code or _code["expires"] <= time.time() or _code["attempts"] >= CODE_ATTEMPTS:
        return None
    return {"code": f"{_code['code'][:4]}-{_code['code'][4:]}", "expiresIn": int(_code["expires"] - time.time())}


def _signed(code, message):
    return hmac.new(code.encode("ascii"), message.encode("ascii"), hashlib.sha256).hexdigest()


def begin(nonce, origin) -> tuple:
    """The first step: this app shows it knows the code, before the extension shows anything. (A challenge for the second
    step, an HMAC keyed by the code of the extension's nonce, the challenge and this app's real address.) Each one
    counts as a try, wrong or right, so the answers can't be collected. Raises PairingError."""
    if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{32}", nonce):
        raise PairingError("wrong")
    with _lock:
        if not _code or _code["expires"] <= time.time():
            raise PairingError("expired")
        if _code["attempts"] >= CODE_ATTEMPTS:
            raise PairingError("used_up")
        _code["attempts"] += 1
        challenge = secrets.token_hex(16)
        _code["asked"] = (nonce, challenge)
        return challenge, _signed(_code["code"], f"app|{nonce}|{challenge}|{origin}")


def pair(nonce, proof, browser, origin) -> tuple:
    """The second step: the extension, sure of this app, shows it has the code, and gets (connection id, token, answer);
    the code is used up. `answer` signs what it gets, so that can't be swapped either. One go per challenge. Raises
    PairingError."""
    global _code
    if (not isinstance(browser, str) or not isinstance(nonce, str) or not isinstance(proof, str)
            or not re.fullmatch(r"[0-9a-f]{64}", proof)):
        raise PairingError("wrong")
    with _lock:
        if not _code or _code["expires"] <= time.time():
            raise PairingError("expired")
        asked, _code["asked"] = _code.get("asked"), None
        code = _code["code"]
        if not asked or asked[0] != nonce or not hmac.compare_digest(proof, _signed(code, f"browser|{nonce}|{asked[1]}|{origin}")):
            raise PairingError("wrong")
        _code = None
        connections = _load()
        if len(connections) >= MAX_CONNECTIONS:
            raise PairingError("too_many")
        token = secrets.token_urlsafe(32)
        name = browser.strip()[:40] or "Browser"
        connection_id = secrets.token_hex(6)
        connections.append({"id": connection_id, "hash": _hash(token), "browser": name, "pairedAt": _now(), "lastUsedAt": _now()})
        _save(connections)
        return connection_id, token, _signed(code, f"token|{nonce}|{asked[1]}|{origin}|{connection_id}|{token}")


def proof(connection_id, nonce, origin):
    """HMAC-SHA256 of the extension's nonce and the address this app really listens on, keyed by the token's
    hash (the extension can work it out; a program squatting on the port can't, and passing on this app's
    answer from its real address doesn't match the address the extension asked). None for an unknown
    connection or a bad nonce."""
    if not isinstance(nonce, str) or not re.fullmatch(r"[0-9a-f]{32,64}", nonce):
        return None
    with _lock:
        connection = next((c for c in _load() if c["id"] == connection_id), None)
    if connection is None:
        return None
    return hmac.new(connection["hash"].encode("ascii"), f"{nonce}|{origin}".encode("ascii"), hashlib.sha256).hexdigest()


def check(token):
    """The connection a token belongs to (its id), or None. Notes when it was last used."""
    if not isinstance(token, str) or not 20 <= len(token) <= 100:
        return None
    digest = _hash(token)
    with _lock:
        connections = _load()
        for connection in connections:
            if hmac.compare_digest(connection["hash"], digest):
                if time.time() - _seen.get(connection["id"], 0) > 60:
                    _seen[connection["id"]] = time.time()
                    connection["lastUsedAt"] = _now()
                    _save(connections)
                return connection["id"]
    return None


def connections() -> list:
    """For Settings: which browsers are connected (never the hashes)."""
    with _lock:                    # a read during a write fails on Windows
        stored = _load()
    return [{"id": c["id"], "browser": c.get("browser", "Browser"), "pairedAt": c.get("pairedAt", ""), "lastUsedAt": c.get("lastUsedAt", "")}
            for c in stored]


def remove(connection_id) -> bool:
    with _lock:
        before = _load()
        after = [c for c in before if c["id"] != connection_id]
        if len(after) == len(before):
            return False
        _save(after)
        return True
