"""
Configuration for the Super Bookmark Manager.

Telegram API credentials:
  Get yours at https://my.telegram.org
  1. Log in with your phone number
  2. Go to "API development tools"
  3. Create an app → copy api_id (int) and api_hash (string)
"""

import os
from pathlib import Path

# ── Telegram ───────────────────────────────────────────────────────────────────
# Resolve at access time so Settings saves take effect without a restart.
# Ordinary module attributes still override __getattr__ for existing test patches.
def __getattr__(name):
    if name in ("TELEGRAM_API_ID", "TELEGRAM_API_HASH"):
        from telegram_config import resolve_credentials
        credentials = resolve_credentials()
        return credentials[0 if name == "TELEGRAM_API_ID" else 1]
    raise AttributeError(name)


TELEGRAM_SESSION_FILE = str(Path(__file__).parent / "session.session")

# ── Local LLM (OpenAI-compatible) ─────────────────────────────────────────────
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:8080/v1")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "not-needed")  # most local servers don't need one
LLM_MODEL = os.environ.get("LLM_MODEL", "local-model")

# ── LiteLLM categorizer proxy (Groq -> Gemini -> Mistral -> local failover) ──
# Started via ./litellm/start_proxy.sh — see litellm/config.yaml + .env.example
LITELLM_PROXY_URL = os.environ.get("LITELLM_PROXY_URL", "http://127.0.0.1:4000")
LITELLM_PROXY_KEY = os.environ.get("LITELLM_PROXY_KEY", "sk-local-dashboard-proxy")

# ── Storage ────────────────────────────────────────────────────────────────────
DB_PATH = os.environ.get("SAVED_POSTS_DB_PATH", str(Path(__file__).parent / "saved_posts.db"))

# ── Dashboard ──────────────────────────────────────────────────────────────────
DASHBOARD_HOST = "127.0.0.1"
DASHBOARD_PORT = 5001

# ── Fetch limits ───────────────────────────────────────────────────────────────
# Max messages to pull per run. Telegram Saved Messages has no hard limit,
# but we cap it to keep each run fast. Set to 0 for unlimited.
MAX_MESSAGES_PER_RUN = int(os.environ.get("MAX_MESSAGES", "200"))
