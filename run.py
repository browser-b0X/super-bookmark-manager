#!/usr/bin/env python3.12
"""
Main runner: serve the local dashboard; live work requires an explicit action.

Usage:
    python run.py              # same as --serve-only; no Telegram/provider work
    python run.py --fetch-only # fetch + metadata + categorize, don't serve
    python run.py --serve-only # initialize selected DB + serve; no fetch, enrichment or categorization
    python run.py --no-fetch   # metadata + categorize + serve (skip Telegram fetch)

Set SAVED_POSTS_DB_PATH to an absolute temporary SQLite path for isolated checks.
Startup never terminates another service; an occupied port causes startup to fail.

Windows: py -3.12 run.py --serve-only
Build the frontend first: cd frontend, then npm run build. The launcher never
installs dependencies or rebuilds. Serve-only needs Flask, not Telethon/OpenAI;
it initializes the selected database but does not fetch or reclassify records.
Settings offers an explicit bounded Telegram refresh using an existing session.
--fetch-only retains the legacy explicit fetch/metadata/categorization workflow.
"""

import argparse
import asyncio
import sys
import webbrowser
import threading
from pathlib import Path

import config
import storage


def do_fetch():
    try:
        from fetcher import fetch_saved_messages
    except ModuleNotFoundError as exc:
        if exc.name != "telethon":
            raise
        raise SystemExit(
            "Telegram fetching requires the optional dependency 'telethon'.\n"
            f'Install it for this Python: "{sys.executable}" -m pip install telethon\n'
            "Or use --serve-only to serve the built app without Telegram."
        ) from None
    print("\n── Fetching from Telegram Saved Messages ──")
    try:
        new_count, total = asyncio.run(fetch_saved_messages())
        print(f"   {new_count} new posts stored ({total} total in Saved Messages)")
        return new_count
    except RuntimeError as e:
        print(f"\n   ERROR: {e}")
        sys.exit(1)


def do_metadata():
    from metadata_fetcher import fetch_missing_metadata

    print("\n── Fetching link titles and thumbnails ──")
    count = fetch_missing_metadata()
    if count == 0:
        print("   Nothing new to fetch")
    return count


def do_categorize():
    from categorizer import categorize_unprocessed

    print("\n── Categorizing with local LLM ──")
    try:
        count = categorize_unprocessed()
        if count == 0:
            print("   Nothing new to categorize")
        return count
    except ConnectionError as e:
        print(f"\n   ERROR: {e}")
        print("   Start your llama-server first, then re-run with --no-fetch to just categorize.")
        return 0


def do_serve():
    if not (Path(__file__).resolve().parent / "frontend" / "dist" / "index.html").is_file():
        raise SystemExit(
            "Built frontend is missing. In the project's frontend directory, "
            "run npm run build, then retry --serve-only."
        )
    from app import run_dashboard

    print(f"\n── Dashboard ready at http://{config.DASHBOARD_HOST}:{config.DASHBOARD_PORT} ──")
    # Open browser after a short delay so Flask starts first
    def _open():
        import time
        time.sleep(1.5)
        webbrowser.open(f"http://{config.DASHBOARD_HOST}:{config.DASHBOARD_PORT}")
    threading.Thread(target=_open, daemon=True).start()
    run_dashboard()


def main():
    parser = argparse.ArgumentParser(
        description="Super Bookmark Manager. Default: serve only; no automatic Telegram/provider work.",
        epilog="Serve a prebuilt app: py -3.12 run.py --serve-only (no Telegram/provider work). "
               "Build first in frontend: npm run build. SAVED_POSTS_DB_PATH overrides the SQLite file.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--fetch-only", action="store_true", help="Telegram fetch + metadata + categorization; do not serve")
    mode.add_argument("--serve-only", action="store_true", help="Initialize the selected database and serve without fetching, enrichment or categorization")
    mode.add_argument("--no-fetch", action="store_true", help="Skip Telegram fetch, just metadata + categorize + serve")
    args = parser.parse_args()

    storage.init_db()

    if args.fetch_only:
        do_fetch()
        do_metadata()
        do_categorize()
        return

    if args.serve_only or not args.no_fetch:
        do_serve()
        return

    # --no-fetch is an explicit legacy metadata/categorization action.
    do_metadata()
    do_categorize()
    do_serve()


if __name__ == "__main__":
    main()
