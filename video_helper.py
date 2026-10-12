"""The optional video helper: yt-dlp, fetched on request, for TikTok videos.

yt-dlp itself is public domain, but its ready-made Windows program bundles
GPLv3 parts, so it is not shipped with the app. When the owner chooses "Get
the video helper" in Settings, the app downloads the program from yt-dlp's
official GitHub release, checks it against that release's SHA2-256SUMS list,
keeps it in the data folder, and runs it only to fetch the video of a TikTok
link being saved: never with cookies, a config file or a shell.
"""

import hashlib
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone

import safe_http

# Packaged builds point this at <data folder>/helpers.
HELPER_DIR = os.environ.get("SBM_HELPER_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "video_helper_store")
RELEASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/"
ASSETS = {"win32": "yt-dlp.exe", "darwin": "yt-dlp_macos"}
ASSET = ASSETS.get(sys.platform, "yt-dlp_linux")
DOWNLOAD_LIMIT = 80 * 1024 * 1024
SUMS_LIMIT = 64 * 1024
DOWNLOAD_BUDGET = 300.0
VERSION_TIMEOUT = 30.0
UPDATE_EVERY = 7 * 24 * 3600
ERROR_CODES = safe_http.ERROR_CODES | {"checksum_mismatch", "not_listed", "not_runnable", "helper_missing",
                                       "helper_failed", "helper_timeout"}
_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; SuperBookmarkManager/0.3; +video helper)",
            "Accept": "application/octet-stream,*/*;q=0.5"}
_VERSION = re.compile(r"[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?")

_lock = threading.Lock()
_job = {"busy": False, "error": "", "action": ""}


class HelperError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_CODES else "internal_error"
        super().__init__(self.code)


def program_path():
    return os.path.join(HELPER_DIR, ASSET)


def _state_path():
    return os.path.join(HELPER_DIR, "helper.json")


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _read_state():
    try:
        with open(_state_path(), encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(data):
    os.makedirs(HELPER_DIR, exist_ok=True)
    temporary = _state_path() + ".tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(data, handle)
    os.replace(temporary, _state_path())


def installed():
    path = program_path()
    return not os.path.islink(path) and os.path.isfile(path)


def status() -> dict:
    """What Settings shows: installed or not, version, last update check, a running download."""
    state = _read_state() if installed() else {}
    with _lock:
        job = dict(_job)
    result = {"installed": installed(), "busy": job["busy"], "action": job["action"], "error": job["error"]}
    for name in ("version", "checkedAt", "installedAt"):
        if isinstance(state.get(name), str):
            result[name] = state[name][:40]
    result["checksum"] = state.get("sha256") is not None if result["installed"] else False
    # A newer release seen by the weekly check; nothing new is downloaded or run until the owner chooses Update.
    result["updateAvailable"] = bool(result["installed"] and state.get("availableSha256")
                                     and state.get("availableSha256") != state.get("sha256"))
    return result


def _expected_sha256(sums):
    """The checksum listed for ASSET in a GNU-style SHA2-256SUMS file."""
    for line in sums.decode("utf-8", "replace").splitlines():
        match = re.fullmatch(r"([0-9a-fA-F]{64})\s+\*?(\S+)", line.strip())
        if match and match.group(2) == ASSET:
            return match.group(1).lower()
    raise HelperError("not_listed")


def _hidden():
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)} if sys.platform == "win32" else {}


def _stop_tree(process):
    """Stop the helper and anything it started. The Windows helper is a one-file
    program: killing it leaves its unpacked child running (and writing)."""
    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=10,
                           stdin=subprocess.DEVNULL, **_hidden())
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        process.kill()
        process.communicate(timeout=5)
    except (OSError, subprocess.SubprocessError, ValueError):
        pass


def _version(path):
    try:
        result = subprocess.run([path, "--version"], capture_output=True, timeout=VERSION_TIMEOUT, stdin=subprocess.DEVNULL,
                                cwd=HELPER_DIR, **_hidden())
    except (OSError, subprocess.SubprocessError):
        raise HelperError("not_runnable") from None
    match = _VERSION.search(result.stdout.decode("ascii", "replace")[:200])
    if result.returncode != 0 or not match:
        raise HelperError("not_runnable")
    return match.group(0)


def install():
    """Download (or replace) the helper and check it. Raises HelperError."""
    deadline = time.monotonic() + DOWNLOAD_BUDGET
    for attempt in (0, 1):
        try:
            sums = safe_http.get(RELEASE + "SHA2-256SUMS", deadline=deadline, limit=SUMS_LIMIT, headers=_HEADERS).body
            expected = _expected_sha256(sums)
            program = safe_http.get(RELEASE + ASSET, deadline=deadline, limit=DOWNLOAD_LIMIT, headers=_HEADERS).body
        except safe_http.SafeHTTPError as exc:
            raise HelperError(exc.code) from None
        if hashlib.sha256(program).hexdigest() == expected:
            break
        # A new release may have landed between the two downloads: one more try, then give up.
        if attempt:
            raise HelperError("checksum_mismatch")
    os.makedirs(HELPER_DIR, exist_ok=True)
    if os.path.islink(HELPER_DIR) or os.path.islink(program_path()):
        raise HelperError("internal_error")
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=HELPER_DIR, prefix="download.", suffix=".tmp", delete=False) as handle:
            temporary = handle.name
            handle.write(program)
        if sys.platform != "win32":
            os.chmod(temporary, 0o755)
        version = _version(temporary)
        for attempt in range(5):
            try:
                os.replace(temporary, program_path())
                temporary = None
                break
            except PermissionError:
                if attempt == 4:
                    raise
                time.sleep(0.3)          # Windows: the old helper is still running
    except OSError:
        raise HelperError("internal_error") from None
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass
    now = _now()
    _write_state({"version": version, "sha256": expected, "installedAt": now, "checkedAt": now, "asset": ASSET})
    return status()


def check() -> dict:
    """Ask the release whether its checksum list names a different program. Downloads only
    that small list: nothing new is fetched or run (owner, 2026-10-09: updates wait for a click)."""
    if not installed():
        return status()
    try:
        sums = safe_http.get(RELEASE + "SHA2-256SUMS", deadline=time.monotonic() + 30, limit=SUMS_LIMIT, headers=_HEADERS).body
        latest = _expected_sha256(sums)
    except safe_http.SafeHTTPError as exc:
        raise HelperError(exc.code) from None
    state = _read_state()
    state["checkedAt"] = _now()
    state["availableSha256"] = latest
    _write_state(state)
    return status()


def remove() -> bool:
    removed = False
    for path in (program_path(), _state_path()):
        try:
            os.unlink(path)
            removed = True
        except OSError:
            pass
    return removed


def _run_job(action):
    try:
        check() if action == "check" else install()
        error = ""
    except HelperError as exc:
        error = exc.code
    except Exception:  # noqa: BLE001 - reported to Settings as a fixed word, never a traceback
        error = "internal_error"
    with _lock:
        _job.update(busy=False, error=error, action=action)


def start(action="install") -> dict:
    """Install or update in the background; Settings polls status()."""
    with _lock:
        if not _job["busy"]:
            _job.update(busy=True, error="", action=action)
            threading.Thread(target=_run_job, args=(action,), name="video-helper", daemon=True).start()
    return status()


def update_if_due():
    """Called when a video post is saved: once a week, look (in the background) whether a newer
    helper exists. It is only reported; Settings offers Update and nothing changes until then."""
    if not installed():
        return
    checked = _read_state().get("checkedAt", "")
    try:
        last = datetime.fromisoformat(checked.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        last = 0
    if time.time() - last >= UPDATE_EVERY:
        start("check")


def wait_idle(timeout=30.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        with _lock:
            if not _job["busy"]:
                return True
        time.sleep(0.05)
    return False


def fetch_video(url, limit, timeout):
    """The MP4 of a TikTok video as bytes, fetched by the helper. Raises HelperError.

    `url` must already be a checked TikTok address; it is passed after "--" so
    it can never be read as an option.
    """
    if not installed():
        raise HelperError("helper_missing")
    # ignore_cleanup_errors: on Windows a virus scan (or a stopped helper's child)
    # can still hold video.mp4; a leftover temporary folder must not fail the copy.
    with tempfile.TemporaryDirectory(prefix="video.", ignore_cleanup_errors=True) as work:
        megabytes = max(1, limit // (1024 * 1024))
        # The site's own extractor only: yt-dlp's generic one would fetch whatever
        # address a post links to, including ones on the owner's home network.
        command = [program_path(), "--ignore-config", "--no-cookies", "--no-cache-dir", "--no-playlist", "--no-mtime",
                   "--no-part", "--no-progress", "--quiet", "--no-warnings", "--socket-timeout", "15",
                   "--use-extractors", "default,-generic", "--max-filesize", f"{megabytes}M",
                   "-f", "b[ext=mp4][vcodec^=h264]/b[ext=mp4][vcodec^=avc]/b[ext=mp4]",
                   "-o", os.path.join(work, "video.%(ext)s"), "--", url]
        try:
            process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                       cwd=work, start_new_session=sys.platform != "win32", **_hidden())
        except (OSError, ValueError, subprocess.SubprocessError):
            raise HelperError("helper_failed") from None
        try:
            process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            _stop_tree(process)
            raise HelperError("helper_timeout") from None
        except (OSError, subprocess.SubprocessError):
            _stop_tree(process)
            raise HelperError("helper_failed") from None
        path = os.path.join(work, "video.mp4")
        if process.returncode != 0 or os.path.islink(path) or not os.path.isfile(path):
            # yt-dlp exits 0 and writes nothing when --max-filesize stops it.
            raise HelperError("too_large" if process.returncode == 0 else "helper_failed")
        if os.path.getsize(path) > limit:
            raise HelperError("too_large")
        with open(path, "rb") as handle:
            data = handle.read(limit + 1)
        if len(data) > limit or data[4:8] != b"ftyp":
            raise HelperError("helper_failed")
        return data
