"""
Built-in AI provider chain: Gemini -> Groq -> OpenRouter -> NVIDIA -> a local server.

Every provider is called through its OpenAI-compatible chat endpoint with plain
urllib, so there is no proxy to start and no extra package to install. A
provider is used only when it has a key (or, for the local server, a URL);
rate limits and outages bench it for a while and the next one answers.

Keys live in ai.json beside the Telegram config in the user's profile
(%LOCALAPPDATA%\\SavedPostsDashboard on Windows), never in the project folder.
The file is written atomically with an owner-only ACL. Keys are never returned
to the browser, logged or included in error messages: the UI only learns
whether a key is set and its last four characters. Environment variables
(GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY) still work and win.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

import telegram_config

_LOCK = threading.RLock()
_MAX_BYTES = 16384

PROVIDERS: dict[str, dict] = {
    "gemini": {
        "label": "Google Gemini", "base": "https://generativelanguage.googleapis.com/v1beta/openai",
        "env": "GEMINI_API_KEY", "model": "gemini-flash-latest", "signup": "https://aistudio.google.com/apikey",
        "note": "Strongest free models. Free tier: roughly 5-15 requests a minute, a few hundred a day.",
        # Thinking can't be switched off on Gemini 3; keep it short so the answer fits.
        "extra": {"reasoning_effort": "low"},
    },
    "groq": {
        "label": "Groq", "base": "https://api.groq.com/openai/v1", "env": "GROQ_API_KEY",
        "model": "openai/gpt-oss-20b", "signup": "https://console.groq.com/keys",
        "note": "Fastest. Free tier: about 30 requests a minute, 1,000 a day.",
        # gpt-oss spends its token budget on hidden reasoning unless told otherwise.
        "extra_for": {"openai/gpt-oss": {"reasoning_effort": "low", "include_reasoning": False}},
    },
    "openrouter": {
        "label": "OpenRouter", "base": "https://openrouter.ai/api/v1", "env": "OPENROUTER_API_KEY",
        "model": "openrouter/free", "signup": "https://openrouter.ai/keys",
        "note": "One key, many free models (the free router picks one). Free: 20 a minute, 50 a day.",
        "extra": {"reasoning": {"effort": "low", "exclude": True}},
    },
    "nvidia": {
        "label": "NVIDIA NIM", "base": "https://integrate.api.nvidia.com/v1", "env": "NVIDIA_API_KEY",
        "model": "google/gemma-4-31b-it", "signup": "https://build.nvidia.com/settings/api-keys",
        "note": "Large free catalog; sign-up needs a phone number, no card. About 40 requests a minute. "
                "NVIDIA retires free models often; a retired one is replaced automatically.",
        # NVIDIA retires free endpoints (HTTP 410 "reached its end of life") with
        # little notice, and /v1/models keeps listing retired ones. These were live
        # in October 2026; when one goes, the next is tried, then the account list.
        "fallbacks": ["nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia/nemotron-3-ultra-550b-a55b",
                      "deepseek-ai/deepseek-v4.1-flash", "mistralai/mistral-large-2-instruct"],
        "extra_for": {
            # Nemotron reasons by default; a JSON tidy-up doesn't need it.
            "nvidia/nemotron": {"chat_template_kwargs": {"enable_thinking": False}},
            "deepseek-ai/deepseek-v4": {"reasoning_effort": "low"},
            "openai/gpt-oss": {"reasoning_effort": "low"},
        },
    },
    "local": {
        "label": "Local server", "base": "http://127.0.0.1:11434/v1", "env": "",
        "model": "", "signup": "https://ollama.com",
        "note": "Ollama, LM Studio or llama.cpp on this computer. Unlimited and private; no key needed.",
    },
}
ORDER = ("gemini", "groq", "openrouter", "nvidia", "local")

# Benches after a failure, in seconds. A rejected key stays benched until the
# owner changes it (cleared on save).
_COOLDOWN = {"rate_limited": 60, "unavailable": 30, "timeout": 30, "bad_response": 15, "key_rejected": 10**9}

_state: dict[str, dict] = {name: {} for name in ORDER}
# A replacement found after the configured model was retired (per session).
_resolved: dict[str, str] = {}
_MAX_MODEL_TRIES = 8  # the configured model, the fallbacks, then a few listed ones
_usage: dict[str, dict] = {}


class NoProvider(RuntimeError):
    """No configured provider could answer."""

    def __init__(self, code: str = "no_provider"):
        super().__init__(code)
        self.code = code


# ── storage ──────────────────────────────────────────────────────────────────

def config_path() -> Path:
    override = os.environ.get("SBM_AI_CONFIG_FILE")
    if override:
        return Path(override)
    return telegram_config.config_path().parent / "ai.json"


def _valid_key(value) -> bool:
    return isinstance(value, str) and 8 <= len(value) <= 256 and re.fullmatch(r"[\x21-\x7e]+", value) is not None


def _valid_model(value) -> bool:
    return isinstance(value, str) and len(value) <= 200 and re.fullmatch(r"[A-Za-z0-9._:/@+-]*", value) is not None


def _valid_local_url(value) -> bool:
    """The local provider may only point at this computer or the home network."""
    if not isinstance(value, str) or len(value) > 300:
        return False
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    host = (parts.hostname or "").lower()
    if parts.scheme not in ("http", "https") or not host or parts.username or parts.password:
        return False
    if host in ("localhost", "127.0.0.1", "::1") or host.endswith(".local"):
        return True
    return re.fullmatch(r"(10|127)\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+", host) is not None


def _read() -> dict:
    try:
        path = config_path()
        info = telegram_config._checked_path(path)
        if info is None:
            return {}
        if info.st_size > _MAX_BYTES:
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, telegram_config.ConfigError):
        return {}
    if not isinstance(data, dict) or not isinstance(data.get("providers"), dict):
        return {}
    clean: dict[str, dict] = {}
    for name, entry in data["providers"].items():
        if name not in PROVIDERS or not isinstance(entry, dict):
            continue
        item: dict = {"enabled": entry.get("enabled") is not False}
        if _valid_key(entry.get("key")):
            item["key"] = entry["key"]
        if _valid_model(entry.get("model")) and entry.get("model"):
            item["model"] = entry["model"]
        if name == "local" and _valid_local_url(entry.get("baseUrl")):
            item["baseUrl"] = entry["baseUrl"]
        clean[name] = item
    return {"providers": clean}


def _write(data: dict) -> None:
    path = config_path()
    telegram_config._checked_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".ai-", suffix=".tmp", dir=path.parent)
    try:
        telegram_config.protect_file(temporary)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise


def _settings(name: str, stored: Optional[dict] = None) -> dict:
    """Effective settings for one provider; environment keys win."""
    stored = (stored if stored is not None else _read()).get("providers", {}).get(name, {})
    spec = PROVIDERS[name]
    env_key = os.environ.get(spec["env"], "") if spec["env"] else ""
    key = env_key if _valid_key(env_key) else stored.get("key", "")
    base = stored.get("baseUrl", spec["base"]) if name == "local" else spec["base"]
    if name == "local" and os.environ.get("LLM_BASE_URL") and _valid_local_url(os.environ["LLM_BASE_URL"]):
        base = os.environ["LLM_BASE_URL"]
    configured = bool(key) if name != "local" else bool(stored) or bool(os.environ.get("LLM_BASE_URL"))
    return {
        "key": key, "keySource": "environment" if env_key and key == env_key else ("settings" if key else ""),
        "base": base.rstrip("/"), "model": stored.get("model") or spec["model"],
        "enabled": stored.get("enabled", True), "configured": configured,
    }


def update(name: str, changes: dict) -> dict:
    """Apply one provider's changes from Settings. Raises ValueError on bad input."""
    if name not in PROVIDERS:
        raise ValueError("Unknown provider.")
    with _LOCK:
        data = _read() or {"providers": {}}
        entry = dict(data["providers"].get(name, {}))
        if changes.get("clearKey"):
            entry.pop("key", None)
        if "key" in changes:
            key = changes["key"]
            if not isinstance(key, str):
                raise ValueError("Key must be text.")
            key = key.strip()
            if key:
                if not _valid_key(key):
                    raise ValueError("That doesn't look like an API key (no spaces, 8–256 characters).")
                entry["key"] = key
        if "model" in changes:
            if not _valid_model(changes["model"]):
                raise ValueError("Model names use letters, numbers and . _ : / @ + -")
            if changes["model"]:
                entry["model"] = changes["model"]
            else:
                entry.pop("model", None)
        if "enabled" in changes:
            if not isinstance(changes["enabled"], bool):
                raise ValueError("enabled must be true or false.")
            entry["enabled"] = changes["enabled"]
        if "baseUrl" in changes:
            if name != "local":
                raise ValueError("Only the local server has an address.")
            if not _valid_local_url(changes["baseUrl"]):
                raise ValueError("Use an http:// address on this computer or your home network.")
            entry["baseUrl"] = changes["baseUrl"].rstrip("/")
        if entry:
            data["providers"][name] = entry
        else:
            data["providers"].pop(name, None)
        _write(data)
        _state[name] = {}
        return status()


# ── status ───────────────────────────────────────────────────────────────────

def _today() -> dict:
    stamp = date.today().isoformat()
    if _usage.get("_day") != stamp:
        _usage.clear()
        _usage["_day"] = stamp
    return _usage


def status() -> dict:
    stored = _read()
    now = time.time()
    usage = _today()
    providers = []
    for name in ORDER:
        spec, s = PROVIDERS[name], _settings(name, stored)
        bench = _state[name]
        until = bench.get("until", 0)
        providers.append({
            "id": name, "label": spec["label"], "note": spec["note"], "signup": spec["signup"],
            "configured": s["configured"], "enabled": s["enabled"], "keySource": s["keySource"],
            "keyHint": ("…" + s["key"][-4:]) if s["key"] else "",
            "model": s["model"], "defaultModel": spec["model"],
            "baseUrl": s["base"] if name == "local" else "",
            "state": ("off" if not s["enabled"] or not s["configured"]
                      else bench.get("reason", "ready") if until > now else "ready"),
            "retryIn": max(0, int(until - now)) if until > now and until < now + 10**8 else 0,
            "today": usage.get(name, {"requests": 0, "failures": 0, "tokens": 0}),
            "detail": _details.get(name, "") if bench.get("until", 0) > now else "",
        })
    ready = [p["id"] for p in providers if p["state"] == "ready"]
    return {"providers": providers, "ready": ready, "available": bool(ready)}


def retry_in() -> int:
    """Seconds until a configured provider is off the bench (0 if one is ready now)."""
    now = time.time()
    stored = _read()
    waits = []
    for name in ORDER:
        s = _settings(name, stored)
        if not s["configured"] or not s["enabled"]:
            continue
        until = _state[name].get("until", 0)
        if until <= now:
            return 0
        if until < now + 10**8:  # a rejected key never comes back by waiting
            waits.append(int(until - now) + 1)
    return min(waits) if waits else 0


def available() -> bool:
    return status()["available"]


# ── calling ──────────────────────────────────────────────────────────────────

def _post(url: str, key: str, payload: dict, timeout: float) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": "SuperBookmarkManager"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read(2_000_000).decode("utf-8"))


def _bench(name: str, reason: str, retry_after: Optional[str] = None) -> None:
    seconds = _COOLDOWN[reason]
    if retry_after and retry_after.isdigit():
        seconds = min(max(int(retry_after), 5), 3600)
    _state[name] = {"until": time.time() + seconds, "reason": reason}


def _count(name: str, ok: bool, tokens: int = 0) -> None:
    entry = _today().setdefault(name, {"requests": 0, "failures": 0, "tokens": 0})
    entry["requests"] += 1
    entry["tokens"] += tokens
    if not ok:
        entry["failures"] += 1


def chat(messages: list[dict], *, max_tokens: int = 1200, json_mode: bool = True,
         only: Optional[str] = None, timeout: float = 60, deadline: Optional[float] = None,
         spread: int = 0) -> tuple[str, str]:
    """Return (text, provider id) from the first provider that answers.

    `deadline` (time.monotonic()) bounds the whole call across providers and
    model retries, so one request can never outlast the browser waiting for it.
    `spread` rotates which configured provider is asked first, so parallel bulk
    requests share the free tiers instead of all queueing on the first one."""
    stored = _read()
    now = time.time()
    tried = False
    last = "no_provider"
    order = list(ORDER)
    if spread:
        live = [n for n in ORDER if n != "local" and _settings(n, stored)["configured"] and _settings(n, stored)["enabled"]]
        if len(live) > 1:
            k = spread % len(live)
            live = live[k:] + live[:k]
            order = live + [n for n in ORDER if n not in live]
    for name in order:
        if only and name != only:
            continue
        s = _settings(name, stored)
        if not s["configured"] or not s["enabled"]:
            continue
        if not only and _state[name].get("until", 0) > now:
            last = _state[name].get("reason", last)
            continue
        model = _resolved.get(name) or s["model"]
        if name == "local" and not model:
            model = _first_local_model(s["base"]) or ""
            if not model:
                _bench(name, "unavailable")
                last = "unavailable"
                continue
        if deadline is not None and deadline - time.monotonic() < 4:
            last = "timeout"
            break
        tried = True
        try:
            body, used = _complete_any(name, s, model, messages, max_tokens, json_mode, timeout, deadline)
            message = body["choices"][0]["message"]
            text = message.get("content")
            if not isinstance(text, str) or not text.strip():
                # A reasoning model that spent the whole budget thinking answers with nothing.
                _note(name, "The model used its whole answer budget on reasoning and returned no text."
                      if message.get("reasoning") or message.get("reasoning_content") else "The model returned an empty answer.")
                raise ValueError("empty")
            usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
            _count(name, True, int(usage.get("total_tokens") or 0))
            _state[name] = {}
            if used != model:
                _resolved[name] = used
            return text, name
        except urllib.error.HTTPError as exc:
            reason = ("rate_limited" if exc.code == 429 else "key_rejected" if exc.code in (401, 403)
                      else "unavailable")
            _note(name, _http_detail(exc, s["key"]))
            _bench(name, reason, exc.headers.get("Retry-After") if exc.headers else None)
            last = reason
        except (TimeoutError, urllib.error.URLError, OSError) as exc:
            reason = "timeout" if "timed out" in str(exc).lower() else "unavailable"
            _bench(name, reason)
            last = reason
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            if str(exc) != "empty":
                _note(name, "The reply wasn't in the expected chat format.")
            _bench(name, "bad_response")
            last = "bad_response"
        _count(name, False)
    raise NoProvider(last if tried or last != "no_provider" else "no_provider")


def _retired(code: int, detail: str) -> bool:
    """The provider says this model is gone or unknown (not a key or quota problem)."""
    if code in (404, 410):
        return True
    return code in (400, 422) and re.search(
        r"model.{0,60}(not (found|exist|available|supported)|deprecat|retired|end of life|no longer)"
        r"|(unknown|invalid|unsupported) model", detail, re.I) is not None


_SKIP = re.compile(r"embed|vision|-vl\b|guard|reward|retriev|rerank|safety|parse|ocr|clip|whisper|tts|asr|"
                   r"pii|detect|translat|coder|math|audio|image|video|nemoguard|content", re.I)
_PREFER = ("llama-4", "mistral-medium", "mistral-large", "qwen3", "gpt-oss", "llama-3.3", "gemma-3", "llama-3.1-70b")


def _discovered(name: str, s: dict) -> list[str]:
    """Chat models the account lists, best guesses first (used only after retirements)."""
    try:
        models = list_models(name, base_override=s["base"])
    except NoProvider:
        return []
    chat_models = [m for m in models if re.search(r"instruct|chat|gpt-oss", m, re.I) and not _SKIP.search(m)]
    rank = lambda m: next((i for i, p in enumerate(_PREFER) if p in m.lower()), len(_PREFER))
    return sorted(chat_models, key=rank)


def _complete_any(name: str, s: dict, model: str, messages: list[dict], max_tokens: int,
                  json_mode: bool, timeout: float, deadline: Optional[float] = None) -> tuple[dict, str]:
    """Ask `model`; if the provider has retired it, walk to a model that still answers."""
    candidates = [model] + [m for m in PROVIDERS[name].get("fallbacks", []) if m != model]
    seen: set[str] = set()
    retired: list[str] = []
    discovered = False
    while candidates and len(seen) < _MAX_MODEL_TRIES:
        current = candidates.pop(0)
        if current in seen:
            continue
        seen.add(current)
        wait = timeout if deadline is None else min(timeout, deadline - time.monotonic())
        if wait < 3:
            raise TimeoutError("timed out: out of time for this request")
        try:
            body = _complete(name, s, current, messages, max_tokens, json_mode, wait)
        except urllib.error.HTTPError as exc:
            if not _retired(exc.code, _http_detail(exc, s["key"])):
                raise
            retired.append(current)
            if not candidates and not discovered and name != "local":
                discovered = True
                candidates = [m for m in _discovered(name, s) if m not in seen]
            if not candidates or len(seen) >= _MAX_MODEL_TRIES:
                exc.sbm_detail = (f"{_http_detail(exc, s['key'])} — tried {', '.join(retired)}; "
                                  "pick a model from the provider's list.")[:300]
                raise
            continue
        if retired:
            _note(name, f"{retired[0]} is no longer offered; using {current} instead.")
        return body, current
    raise NoProvider("unavailable")


def _complete(name: str, s: dict, model: str, messages: list[dict], max_tokens: int,
              json_mode: bool, timeout: float) -> dict:
    payload = {"model": model, "messages": messages, "temperature": 0.2, "max_tokens": max_tokens,
               **_extra(name, model)}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    try:
        return _post(s["base"] + "/chat/completions", s["key"], payload, timeout)
    except urllib.error.HTTPError as exc:
        # Some local servers and models reject response_format: retry once without it.
        if exc.code == 400 and json_mode and not _retired(400, _http_detail(exc, s["key"])):
            payload.pop("response_format", None)
            return _post(s["base"] + "/chat/completions", s["key"], payload, timeout)
        raise


def _extra(name: str, model: str) -> dict:
    """Provider-specific request fields (reasoning limits for thinking models)."""
    spec = PROVIDERS[name]
    extra = dict(spec.get("extra", {}))
    for prefix, fields in spec.get("extra_for", {}).items():
        if model.startswith(prefix):
            extra.update(fields)
    return extra


_details: dict[str, str] = {}


def _note(name: str, detail: str) -> None:
    _details[name] = detail[:300]


def _http_detail(exc: urllib.error.HTTPError, key: str) -> str:
    """The provider's own error message, minus anything that could echo the key.

    The body can be read only once, so the result is kept on the exception."""
    cached = getattr(exc, "sbm_detail", None)
    if cached:
        return cached
    try:
        body = json.loads(exc.read(20000).decode("utf-8", "replace"))
        error = body.get("error") if isinstance(body, dict) else None
        if isinstance(body, list) and body and isinstance(body[0], dict):
            error = body[0].get("error")
        message = error.get("message") if isinstance(error, dict) else error if isinstance(error, str) else ""
        if not message and isinstance(body, dict) and isinstance(body.get("detail"), str):
            message = body["detail"]  # NVIDIA answers with problem+json: {"title", "detail"}
    except (ValueError, OSError, AttributeError, TypeError):
        message = ""
    message = re.sub(r"\s+", " ", str(message or f"HTTP {exc.code}")).strip()
    if key and key in message:
        message = message.replace(key, "…")
    message = re.sub(r"\b(sk|gsk|AIza|nvapi)[-_A-Za-z0-9]{8,}", "…", message)
    exc.sbm_detail = message
    return message


def _first_local_model(base: str) -> Optional[str]:
    try:
        models = list_models("local", base_override=base)
    except NoProvider:
        return None
    return models[0] if models else None


def list_models(name: str, base_override: Optional[str] = None) -> list[str]:
    s = _settings(name)
    base = base_override or s["base"]
    if name != "local" and not s["key"]:
        raise NoProvider("no_key")
    headers = {"User-Agent": "SuperBookmarkManager"}
    if s["key"]:
        headers["Authorization"] = f"Bearer {s['key']}"
    try:
        with urllib.request.urlopen(urllib.request.Request(base + "/models", headers=headers), timeout=10) as response:
            data = json.loads(response.read(2_000_000).decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise NoProvider("key_rejected" if exc.code in (401, 403) else "unavailable") from None
    except (urllib.error.URLError, OSError, ValueError):
        raise NoProvider("unavailable") from None
    items = data.get("data") if isinstance(data, dict) else None
    names = []
    for item in items or []:
        ident = item.get("id") if isinstance(item, dict) else None
        if isinstance(ident, str) and _valid_model(ident):
            names.append(ident.removeprefix("models/"))
    return sorted(set(names))


def test(name: str) -> dict:
    """Send one tiny request to one provider and report what happened."""
    if name not in PROVIDERS:
        raise ValueError("Unknown provider.")
    _state[name] = {}
    _details.pop(name, None)
    _resolved.pop(name, None)
    models: list[str] = []
    try:
        models = list_models(name)
    except NoProvider:
        models = []
    try:
        # Generous budget: thinking models (Gemini 3, gpt-oss) reason before they answer.
        text, _ = chat([{"role": "user", "content": 'Reply with the JSON {"ok": true}'}],
                       max_tokens=600, only=name, timeout=45)
        note = _details.get(name, "") if name in _resolved else ""
        return {"ok": True, "reply": text[:80], "models": models[:200], "model": _resolved.get(name, ""), "note": note}
    except NoProvider as exc:
        messages = {
            "key_rejected": "The provider rejected this key. Check it was copied completely.",
            "rate_limited": "The key works but the provider is rate-limiting right now. Try again in a minute.",
            "timeout": "The provider took too long to answer.",
            "unavailable": "Couldn't reach the provider (or the model name isn't available).",
            "bad_response": "The provider answered with something unreadable.",
            "no_provider": "Add a key (or, for the local server, an address) first.",
        }
        message = messages.get(exc.code, "Test failed.")
        if _details.get(name):
            message += " Provider said: " + _details[name]
        return {"ok": False, "error": exc.code, "message": message, "models": models[:200]}
