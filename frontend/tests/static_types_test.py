"""The app's own files keep their types even when the system's type table is wrong.

On Windows, Python reads file types from the registry, and some PCs map .js and
.css to text/plain there; a browser refuses a module script served that way and
the app opens as a blank page. This test pollutes the table the same way before
the app is imported. Run: python -B frontend/tests/static_types_test.py
"""
import mimetypes
import os
from pathlib import Path
import sys
import tempfile
import unittest

WORKSPACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WORKSPACE))
sys.dont_write_bytecode = True

mimetypes.init()
for extension in (".js", ".css", ".svg", ".woff2"):
    mimetypes.add_type("text/plain", extension)     # what a polluted registry does

SCRATCH = tempfile.TemporaryDirectory(prefix="static-types-")
os.environ["SAVED_POSTS_DB_PATH"] = os.path.join(SCRATCH.name, "synthetic.sqlite")
os.environ["SBM_AI_CONFIG_FILE"] = os.path.join(SCRATCH.name, "ai.json")
os.environ["SBM_ARCHIVE_DIR"] = os.path.join(SCRATCH.name, "archive")
os.environ["SBM_THUMB_CACHE_DIR"] = os.path.join(SCRATCH.name, "thumbs")
import app  # noqa: E402


class StaticTypes(unittest.TestCase):
    def test_types_are_pinned_whatever_the_system_says(self):
        for name, wanted in (("index.js", "text/javascript"), ("site.css", "text/css"), ("logo.svg", "image/svg+xml"),
                             ("font.woff2", "font/woff2"), ("page.html", "text/html")):
            self.assertEqual(mimetypes.guess_type(name)[0], wanted, name)

    @unittest.skipUnless((WORKSPACE / "frontend" / "dist" / "assets").is_dir(), "frontend not built")
    def test_built_assets_are_served_with_their_types(self):
        client = app.app.test_client()
        assets = sorted(os.listdir(WORKSPACE / "frontend" / "dist" / "assets"))
        for suffix, wanted in ((".js", "text/javascript"), (".css", "text/css")):
            name = next(item for item in assets if item.endswith(suffix))
            self.assertEqual(client.get("/assets/" + name).mimetype, wanted, name)


if __name__ == "__main__":
    unittest.main()
