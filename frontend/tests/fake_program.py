"""A stand-in program (the fake video helper) that this system can run.

On Linux and macOS a Python script with a #! line runs as a program. Windows runs only real
executables, so there the script rides in pip's own launcher (distlib's t64.exe, the same one pip
uses for its commands): launcher + "#!python" + a zip with __main__.py. Nothing is downloaded.
"""
import io
import sys
import zipfile
from pathlib import Path


def launcher():
    """pip's console launcher, or None when this Python has no pip."""
    try:
        import pip._vendor.distlib as distlib
    except ImportError:
        return None
    path = Path(distlib.__file__).parent / "t64.exe"
    return path.read_bytes() if path.is_file() else None


def program_bytes(script: str) -> bytes:
    """The bytes of a program running `script` (its own #! line, if any, is replaced)."""
    body = script.split("\n", 1)[1] if script.startswith("#!") else script
    if sys.platform != "win32":
        return ("#!" + sys.executable + "\n" + body).encode()
    stub = launcher()
    if stub is None:
        raise RuntimeError("pip's launcher (distlib t64.exe) is needed to make a Windows stand-in program")
    python = sys.executable if " " not in sys.executable else f'"{sys.executable}"'
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("__main__.py", body)
    return stub + b"#!" + python.encode() + b"\n" + archive.getvalue()
