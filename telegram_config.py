"""Local Telegram developer keys, not login/session storage or encryption.

Environment presence wins per key, including empty/invalid environment values.
Writes replace a private temporary file atomically; no credential values are logged.
"""
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import threading

_MAX_BYTES = 4096
_LOCK = threading.RLock()
_KEYS = {"api_id", "api_hash"}


class ConfigError(RuntimeError):
    def __init__(self):
        super().__init__("Telegram configuration is unavailable.")


class ConfigValidationError(ConfigError):
    def __init__(self):
        RuntimeError.__init__(self, "Invalid or incomplete Telegram developer keys.")


def config_path() -> Path:
    public = os.environ.get("SUPER_BOOKMARK_MANAGER_DATA_DIR")
    if public:
        path = Path(public)
        if not path.is_absolute():
            raise ConfigError()
        return path / "config.json"
    root = os.environ.get("LOCALAPPDATA")
    base = Path(root) if root else Path.home() / ".local" / "share"
    if not base.is_absolute():
        raise ConfigError()
    return base / "SavedPostsDashboard" / "config.json"


def _api_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,10}", value):
        return 0
    number = int(value)
    return number if 0 < number <= 2147483647 else 0


def _api_hash(value):
    return value if isinstance(value, str) and re.fullmatch(r"[0-9a-fA-F]{32}", value) else ""


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError()
        result[key] = value
    return result


def _checked_path(path):
    """Reject link/reparse components and anything other than a regular target."""
    target_info = None
    for component in (*reversed(path.parents), path):
        try:
            info = os.lstat(component)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ConfigError()
        if component == path:
            if not stat.S_ISREG(info.st_mode):
                raise ConfigError()
            target_info = info
        elif not stat.S_ISDIR(info.st_mode):
            raise ConfigError()
    return target_info


def _read_stored():
    try:
        path = config_path()
        prior = _checked_path(path)
        if prior is None:
            return {}
        if prior.st_size > _MAX_BYTES:
            raise ConfigError()
        def no_follow(filename, flags):
            return os.open(filename, flags | getattr(os, "O_NOFOLLOW", 0))
        with open(path, "rb", opener=no_follow) as source:
            opened = os.fstat(source.fileno())
            if (not stat.S_ISREG(opened.st_mode)
                    or (opened.st_dev, opened.st_ino) != (prior.st_dev, prior.st_ino)):
                raise ConfigError()
            raw = source.read(_MAX_BYTES + 1)
        if len(raw) > _MAX_BYTES:
            raise ConfigError()
        data = json.loads(raw, object_pairs_hook=_unique_object)
        if not isinstance(data, dict) or set(data) != {"telegram"}:
            raise ConfigError()
        local = data["telegram"]
        if not isinstance(local, dict) or not local or not set(local) <= _KEYS:
            raise ConfigError()
        if "api_id" in local and (type(local["api_id"]) is not int or not 0 < local["api_id"] <= 2147483647):
            raise ConfigError()
        if "api_hash" in local and not _api_hash(local["api_hash"]):
            raise ConfigError()
        return local
    except (OSError, ValueError, RecursionError):
        raise ConfigError() from None


def _effective(local):
    identifier = (_api_id(os.environ["TELEGRAM_API_ID"]) if "TELEGRAM_API_ID" in os.environ
                  else local.get("api_id", 0))
    digest = (_api_hash(os.environ["TELEGRAM_API_HASH"]) if "TELEGRAM_API_HASH" in os.environ
              else local.get("api_hash", ""))
    return identifier, digest


def resolve_credentials() -> tuple[int, str]:
    """Bad local files and malformed environment values cannot break startup."""
    with _LOCK:
        try:
            local = _read_stored()
        except ConfigError:
            local = {}
        return _effective(local)


def status() -> dict[str, bool]:
    with _LOCK:
        readable = True
        try:
            local = _read_stored()
        except ConfigError:
            local, readable = {}, False
        identifier, digest = _effective(local)
        return {"api_id_configured": bool(identifier), "api_hash_configured": bool(digest),
                "config_readable": readable}


def _protect_file(path):
    """Protect the empty temporary file BEFORE any secret bytes are written."""
    if os.name != "nt":
        os.chmod(path, 0o600)
        return
    import ctypes
    from ctypes import wintypes

    adv = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    ptr = ctypes.c_void_p
    adv.OpenProcessToken.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)]
    adv.OpenProcessToken.restype = wintypes.BOOL
    adv.GetTokenInformation.argtypes = [wintypes.HANDLE, wintypes.DWORD, ptr, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    adv.GetTokenInformation.restype = wintypes.BOOL
    adv.ConvertSidToStringSidW.argtypes = [ptr, ctypes.POINTER(wintypes.LPWSTR)]
    adv.ConvertSidToStringSidW.restype = wintypes.BOOL
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ptr), ptr]
    adv.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    adv.GetSecurityDescriptorDacl.argtypes = [ptr, ctypes.POINTER(wintypes.BOOL), ctypes.POINTER(ptr), ctypes.POINTER(wintypes.BOOL)]
    adv.GetSecurityDescriptorDacl.restype = wintypes.BOOL
    adv.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD, ptr, ptr, ptr, ptr]
    adv.SetNamedSecurityInfoW.restype = wintypes.DWORD
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.LocalFree.argtypes = [ptr]
    kernel.LocalFree.restype = ptr

    token, sid_text, descriptor = wintypes.HANDLE(), wintypes.LPWSTR(), ptr()
    try:
        if not adv.OpenProcessToken(kernel.GetCurrentProcess(), 8, ctypes.byref(token)):
            raise ConfigError()
        needed = wintypes.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, ctypes.byref(needed))  # TokenUser
        if not needed.value or needed.value > 65536:
            raise ConfigError()
        buffer = ctypes.create_string_buffer(needed.value)
        if not adv.GetTokenInformation(token, 1, buffer, needed.value, ctypes.byref(needed)):
            raise ConfigError()
        sid = ptr.from_buffer(buffer)  # TOKEN_USER begins with SID_AND_ATTRIBUTES.Sid
        if not adv.ConvertSidToStringSidW(sid, ctypes.byref(sid_text)):
            raise ConfigError()
        # D:P disables inheritance; exactly one full-access ACE, for this user.
        sddl = "D:P(A;;FA;;;" + sid_text.value + ")"
        if not adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(descriptor), None):
            raise ConfigError()
        present, defaulted, dacl = wintypes.BOOL(), wintypes.BOOL(), ptr()
        if not adv.GetSecurityDescriptorDacl(descriptor, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted)):
            raise ConfigError()
        if not present.value or not dacl:
            raise ConfigError()
        # SE_FILE_OBJECT; protected DACL + owner (also current token user).
        if adv.SetNamedSecurityInfoW(str(path), 1, 0x80000005, sid, None, dacl, None):
            raise ConfigError()
    finally:
        if descriptor:
            kernel.LocalFree(descriptor)
        if sid_text:
            kernel.LocalFree(ctypes.cast(sid_text, ptr))
        if token:
            kernel.CloseHandle(token)


def protect_file(path):
    """Public wrapper so the session service reuses the exact config-file ACL."""
    _protect_file(Path(path))


def _write_stored(local):
    path = config_path()
    _checked_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    _checked_path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".telegram-", suffix=".tmp", dir=path.parent)
    try:
        _protect_file(temporary)
        stream = os.fdopen(descriptor, "wb")
        descriptor = None
        with stream:
            stream.write(json.dumps({"telegram": local}, ensure_ascii=True, separators=(",", ":")).encode("utf-8"))
            stream.flush()
            os.fsync(stream.fileno())
        _checked_path(path)
        os.replace(temporary, path)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def save_credentials(api_id: str, api_hash: str) -> dict[str, bool]:
    """Blank fields preserve local values, never copy environment keys to disk."""
    if (not isinstance(api_id, str) or not isinstance(api_hash, str)
            or (api_id != "" and not _api_id(api_id))
            or (api_hash != "" and not _api_hash(api_hash))):
        raise ConfigValidationError()
    with _LOCK:
        local = _read_stored()
        if api_id:
            local["api_id"] = _api_id(api_id)
        if api_hash:
            local["api_hash"] = api_hash
        identifier, digest = _effective(local)
        if not identifier or not digest:
            raise ConfigValidationError()
        try:
            if local:
                _write_stored(local)
        except (OSError, ValueError):
            raise ConfigError() from None
        return status()


def clear_credentials() -> dict[str, bool]:
    """Remove only the local developer-key file; environment and sessions stay intact."""
    with _LOCK:
        try:
            path = config_path()
            if _checked_path(path) is not None:
                path.unlink()
        except OSError:
            raise ConfigError() from None
        return status()
