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


TELEGRAM_SESSION_FILE = os.environ.get("SBM_TELEGRAM_SESSION_FILE") or str(Path(__file__).parent / "session.session")

# ── AI providers ──────────────────────────────────────────────────────────────
# Keys are entered in Settings > AI & previews and stored in the user profile
# (see ai_providers.py). GROQ_API_KEY / GEMINI_API_KEY / MISTRAL_API_KEY and
# LLM_BASE_URL (a local OpenAI-compatible server) still work in source mode.

# ── Storage ────────────────────────────────────────────────────────────────────
DB_PATH = os.environ.get("SAVED_POSTS_DB_PATH", str(Path(__file__).parent / "saved_posts.db"))

# ── Dashboard ──────────────────────────────────────────────────────────────────
DASHBOARD_HOST = "127.0.0.1"
DASHBOARD_PORT = 5001

# ── Fetch limits ───────────────────────────────────────────────────────────────
# Max messages to pull per run. Telegram Saved Messages has no hard limit,
# but we cap it to keep each run fast. Set to 0 for unlimited.
MAX_MESSAGES_PER_RUN = int(os.environ.get("MAX_MESSAGES", "200"))
