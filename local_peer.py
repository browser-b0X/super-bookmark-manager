"""Which Windows user is at the other end of a connection?

The installed app listens on 127.0.0.1, and every Windows user on this PC can reach that address. So for each request
it asks Windows which program holds the other end of the connection, and answers only programs of the user who started
the app. Another user's browser or program gets nothing, and has its own copy with its own data on its own port.
Programs of the same user are trusted, as by any desktop app: they can read the app's data folder anyway.

A port is also free for anyone to take while its owner's program is off. So before a key or link text goes to a server on
this PC, ai_providers asks who is listening there, and sends nothing to another signed-in person's program.

The connection check is used by packaging/standalone_entry.py, not by a source run. Windows only. Nothing is stored, and
no call here needs a right the user doesn't have: Windows lists who holds a port for anyone, and answers about their own
programs only.
"""
import ctypes
from ctypes import wintypes
from functools import lru_cache
import os
import socket

_AF_INET = 2
_AF_INET6 = 23
_TCP_TABLE_OWNER_PID_LISTENER = 3
_TCP_TABLE_OWNER_PID_ALL = 5
_ERROR_INSUFFICIENT_BUFFER = 122
_LOOPBACK_6 = bytes(15) + b"\x01"
_WTS_ANY_SESSION = 0xFFFFFFFE
_WTS_TYPE_PROCESS_INFO_LEVEL_1 = 1
_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
_TOKEN_QUERY = 0x0008
_TOKEN_USER = 1

_iphlpapi = ctypes.WinDLL("iphlpapi", use_last_error=True)
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
_wtsapi32 = ctypes.WinDLL("wtsapi32", use_last_error=True)
_iphlpapi.GetExtendedTcpTable.argtypes = (ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), wintypes.BOOL, wintypes.ULONG,
                                          ctypes.c_int, wintypes.ULONG)
_iphlpapi.GetExtendedTcpTable.restype = wintypes.DWORD
_kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
_kernel32.OpenProcess.restype = wintypes.HANDLE
_kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
_advapi32.OpenProcessToken.argtypes = (wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE))
_advapi32.OpenProcessToken.restype = wintypes.BOOL
_advapi32.GetTokenInformation.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                          ctypes.POINTER(wintypes.DWORD))
_advapi32.GetTokenInformation.restype = wintypes.BOOL
_advapi32.GetLengthSid.argtypes = (ctypes.c_void_p,)
_advapi32.GetLengthSid.restype = wintypes.DWORD
_wtsapi32.WTSEnumerateProcessesExW.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD), wintypes.DWORD,
                                               ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(wintypes.DWORD))
_wtsapi32.WTSEnumerateProcessesExW.restype = wintypes.BOOL
_wtsapi32.WTSFreeMemoryExW.argtypes = (ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
_wtsapi32.WTSFreeMemoryExW.restype = wintypes.BOOL


class _Row(ctypes.Structure):
    """MIB_TCPROW_OWNER_PID: one connection. Addresses and ports are in network order."""
    _fields_ = [("state", wintypes.DWORD), ("local_address", wintypes.DWORD), ("local_port", wintypes.DWORD),
                ("remote_address", wintypes.DWORD), ("remote_port", wintypes.DWORD), ("pid", wintypes.DWORD)]


class _Row6(ctypes.Structure):
    """MIB_TCP6ROW_OWNER_PID: the same over IPv6."""
    _fields_ = [("local_address", ctypes.c_ubyte * 16), ("local_scope", wintypes.DWORD), ("local_port", wintypes.DWORD),
                ("remote_address", ctypes.c_ubyte * 16), ("remote_scope", wintypes.DWORD), ("remote_port", wintypes.DWORD),
                ("state", wintypes.DWORD), ("pid", wintypes.DWORD)]


class _ProcessInfo(ctypes.Structure):
    """WTS_PROCESS_INFO_EXW: one process, level 1."""
    _fields_ = [("session", wintypes.DWORD), ("pid", wintypes.DWORD), ("name", wintypes.LPWSTR), ("user", ctypes.c_void_p),
                ("threads", wintypes.DWORD), ("handles", wintypes.DWORD), ("pagefile", wintypes.DWORD),
                ("peak_pagefile", wintypes.DWORD), ("working_set", wintypes.DWORD), ("peak_working_set", wintypes.DWORD),
                ("user_time", ctypes.c_longlong), ("kernel_time", ctypes.c_longlong)]


def _table(row, family, kind):
    """A list of this PC's TCP connections or listening ports, as Windows gives it."""
    size = wintypes.DWORD(0)
    _iphlpapi.GetExtendedTcpTable(None, ctypes.byref(size), False, family, kind, 0)
    for _ in range(4):                  # the list can grow between asking its size and reading it
        buffer = ctypes.create_string_buffer(size.value + 1024)
        size = wintypes.DWORD(len(buffer))
        status = _iphlpapi.GetExtendedTcpTable(buffer, ctypes.byref(size), False, family, kind, 0)
        if status == 0:
            count = int.from_bytes(buffer.raw[:4], "little")
            return (row * count).from_buffer(buffer, 4)
        if status != _ERROR_INSUFFICIENT_BUFFER:
            break
    raise OSError("Windows didn't list this PC's TCP ports.")


def peer_pid(address, port, server_port):
    """The process holding the client's end of a connection to 127.0.0.1:server_port, or None when Windows lists none."""
    local = int.from_bytes(socket.inet_aton(address), "little")
    server = int.from_bytes(socket.inet_aton("127.0.0.1"), "little")
    local_port, remote_port = socket.htons(port), socket.htons(server_port)
    for row in _table(_Row, _AF_INET, _TCP_TABLE_OWNER_PID_ALL):
        # Only the low 16 bits of a port field are defined.
        if ((row.local_port & 0xFFFF, row.remote_port & 0xFFFF, row.local_address, row.remote_address)
                == (local_port, remote_port, local, server)):
            return row.pid
    return None


def user_of(pid):
    """The Windows user a process runs as, as the bytes of its SID, or None when Windows won't say (another user's)."""
    process = _kernel32.OpenProcess(_PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not process:
        return None
    token = wintypes.HANDLE()
    try:
        if not _advapi32.OpenProcessToken(process, _TOKEN_QUERY, ctypes.byref(token)):
            return None
        size = wintypes.DWORD(0)
        _advapi32.GetTokenInformation(token, _TOKEN_USER, None, 0, ctypes.byref(size))
        buffer = ctypes.create_string_buffer(size.value)
        if not size.value or not _advapi32.GetTokenInformation(token, _TOKEN_USER, buffer, size, ctypes.byref(size)):
            return None
        sid = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_void_p)).contents.value      # TOKEN_USER starts with its SID
        return ctypes.string_at(sid, _advapi32.GetLengthSid(sid))
    finally:
        if token:
            _kernel32.CloseHandle(token)
        _kernel32.CloseHandle(process)


@lru_cache(maxsize=1)
def own_user():
    return user_of(os.getpid())


def listeners(port):
    """The processes listening on this port where a program on this PC can reach them: on loopback or every address, over
    IPv4 and IPv6 (one program can hold ::1 while another holds 127.0.0.1, and "localhost" can mean either)."""
    wanted = socket.htons(port)
    held = {row.pid for row in _table(_Row, _AF_INET, _TCP_TABLE_OWNER_PID_LISTENER)
            if row.local_port & 0xFFFF == wanted and (row.local_address == 0 or row.local_address & 0xFF == 127)}
    return held | {row.pid for row in _table(_Row6, _AF_INET6, _TCP_TABLE_OWNER_PID_LISTENER)
                   if row.local_port & 0xFFFF == wanted and bytes(row.local_address) in (bytes(16), _LOOPBACK_6)}


def _sessions():
    """Every process's session. Windows tells anyone that, though it names the user of their own processes only."""
    level, buffer, count = wintypes.DWORD(1), ctypes.c_void_p(), wintypes.DWORD(0)
    if not _wtsapi32.WTSEnumerateProcessesExW(None, ctypes.byref(level), _WTS_ANY_SESSION, ctypes.byref(buffer), ctypes.byref(count)):
        return {}
    try:
        return {item.pid: item.session for item in (_ProcessInfo * count.value).from_address(buffer.value)}
    finally:
        _wtsapi32.WTSFreeMemoryExW(_WTS_TYPE_PROCESS_INFO_LEVEL_1, buffer, count)


def someone_else_listens(port) -> bool:
    """Would a connection to this port reach a program of another person signed in to this PC?

    A program of this user wouldn't count. Nor would one in this user's own session (theirs, started as administrator,
    which Windows won't look into) or in session 0: that is a service, which only an administrator can install. Another
    session is another person's, and so is whatever Windows can't place."""
    mine = own_user()
    try:
        strangers = {pid for pid in listeners(port) if not mine or user_of(pid) != mine}
    except OSError:
        return True
    if not strangers:
        return False
    sessions = _sessions()
    here = sessions.get(os.getpid())
    return here is None or any(sessions.get(pid) not in (0, here) for pid in strangers)


def same_user(address, port, server_port) -> bool:
    """Is the other end of this connection a program of the user running the app? No, when Windows can't say."""
    mine = own_user()
    try:
        pid = peer_pid(address, int(port), int(server_port))
    except (TypeError, ValueError, OverflowError, OSError):
        return False
    return bool(mine) and pid is not None and user_of(pid) == mine
