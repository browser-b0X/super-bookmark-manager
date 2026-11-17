"""Pack the Claude Desktop extension: dist-claude-desktop/SuperBookmarks.mcpb (a zip Claude Desktop installs with a
double-click: manifest.json, the Node server and the icon). The version comes from packaging/release_paths.py, like
the app's. Nothing is installed anywhere by this script.

Run: python claude-desktop/build.py
"""
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "packaging"))
from release_paths import VERSION  # noqa: E402

ICON = ROOT / "extension" / "icons" / "icon-128.png"


def manifest():
    data = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    data["version"] = VERSION
    return data


def main():
    out = ROOT / "dist-claude-desktop"
    out.mkdir(exist_ok=True)
    target = out / "SuperBookmarks.mcpb"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest(), indent=2) + "\n")
        bundle.write(HERE / "server" / "index.js", "server/index.js")
        bundle.write(ICON, "icon.png")
    print(f"{target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
