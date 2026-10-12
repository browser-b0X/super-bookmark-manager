"""Run with pythonw.exe: independently query the test process's console."""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
k=ctypes.WinDLL('kernel32',use_last_error=True)
k.GetConsoleWindow.restype=wintypes.HWND
k.AttachConsole.argtypes=[wintypes.DWORD]
k.AttachConsole.restype=wintypes.BOOL
initial=bool(k.GetConsoleWindow())
assert not initial
ctypes.set_last_error(0)
attached=bool(k.AttachConsole(int(sys.argv[1])))
error=ctypes.get_last_error()
if attached:k.FreeConsole()
Path(sys.argv[2]).write_text(json.dumps({'probe_initial_console':initial,'target_console_attached':attached,'winerror':error}))
