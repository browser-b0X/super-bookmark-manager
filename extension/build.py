"""Pack the browser extension: one zip for Chrome, Edge and Brave (load it unpacked, or unzip it),
and one for Firefox, to be signed as an unlisted add-on (Firefox installs only signed .xpi files).

Run: python extension/build.py   ->   dist-extension/SuperBookmarks-extension-chrome.zip and -firefox.zip
The version comes from packaging/release_paths.py, like the app's.
"""
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "packaging"))
from release_paths import VERSION  # noqa: E402

FILES = ["background.js", "verify.js", "queue.js", "readers.js", "marks.js", "media.js", "handover.js", "options.html", "options.css",
         "options.js", "kept.html", "kept.js", "snapshot.js", "snapshot.html", "snapshot-page.js",
         "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png"]
FIREFOX_ID = "superbookmarks@browser-b0x"
# Mozilla takes a version number for an add-on only once, whatever became of the file. The owner's first upload of this
# release was the build its review flagged (2026-10), so the Firefox file carries a build number after the app's version
# ("0.4.0.1"): raise it for every later file that goes to Mozilla under the same app version.
FIREFOX_BUILD = 1


def manifests():
    chrome = json.loads((HERE / "manifest.json").read_text(encoding="utf-8"))
    chrome["version"] = VERSION
    firefox = json.loads(json.dumps(chrome))
    firefox["version"] = f"{VERSION}.{FIREFOX_BUILD}"
    # Firefox runs the same script as an event page, and needs an id to sign the add-on.
    firefox["background"] = {"scripts": ["verify.js", "queue.js", "background.js"]}
    # data_collection_permissions needs Firefox 140 (Firefox for Android 142); older versions only warn about it.
    firefox["browser_specific_settings"] = {"gecko": {"id": FIREFOX_ID, "strict_min_version": "140.0",
                                                      "data_collection_permissions": {"required": ["none"]}}}
    firefox["browser_specific_settings"]["gecko_android"] = {"strict_min_version": "142.0"}
    return chrome, firefox


def pack(name, manifest, out):
    target = out / f"SuperBookmarks-extension-{name}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest, indent=2) + "\n")
        for file in FILES:
            bundle.write(HERE / file, file)
    return target


def main():
    out = ROOT / "dist-extension"
    out.mkdir(exist_ok=True)
    chrome, firefox = manifests()
    for target in (pack("chrome", chrome, out), pack("firefox", firefox, out)):
        print(f"{target} ({target.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
