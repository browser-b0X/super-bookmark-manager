"""Launch handoff: a new build replaces an older running copy instead of reopening it.

Synthetic only: a fake 'running copy' on a loopback port and a temporary data folder.
"""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packaging"))
sys.path.insert(0, str(ROOT))
import standalone_entry as entry  # noqa: E402

TOKEN = "a" * 64


def fake_copy(build, quit_ok=True):
    calls = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path == "/api/runtime" and self.headers.get("X-SBM-Instance") == TOKEN:
                status = {"app": "SuperBookmarkManager", "instance": TOKEN}
                if build is not None:
                    status["build"] = build
                return self._send(200, status)
            self._send(403, {})

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
            calls.append((self.path, self.headers.get("X-SBM-Instance"), body))
            self._send(200 if quit_ok else 500, {"ok": quit_ok})

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, calls


class Handoff(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp(prefix="handoff-"))
        self.opened, self.notes = [], []
        self.patches = [patch.object(entry, "_open_browser", self.opened.append),
                        patch.object(entry, "_notify", self.notes.append)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def run_against(self, server):
        port = server.server_address[1]
        (self.data / "runtime.json").write_text(json.dumps({"port": port, "token": TOKEN}))
        try:
            return entry._reopen(self.data), f"http://127.0.0.1:{port}"
        finally:
            server.shutdown()
            server.server_close()

    def test_same_build_is_reopened(self):
        server, calls = fake_copy(entry.BUILD)
        result, origin = self.run_against(server)
        self.assertEqual((result, self.opened, calls), (0, [origin], []))

    def test_older_build_is_asked_to_quit(self):
        server, calls = fake_copy("1700000000-123")
        result, _ = self.run_against(server)
        self.assertEqual(result, entry.REPLACED)
        self.assertEqual(calls, [("/api/runtime/quit", TOKEN, {"confirm": True})])
        self.assertEqual(self.opened, [])

    def test_copies_from_before_build_ids_are_replaced_too(self):
        server, calls = fake_copy(None)
        result, _ = self.run_against(server)
        self.assertEqual((result, len(calls)), (entry.REPLACED, 1))

    def test_a_copy_that_refuses_to_quit_is_reported(self):
        server, _ = fake_copy("old", quit_ok=False)
        result, _ = self.run_against(server)
        self.assertEqual(result, 1)
        self.assertTrue(self.notes and "older copy" in self.notes[0])

    def test_status_reports_this_build(self):
        self.assertRegex(entry.BUILD, r"^\d+-\d+$")


if __name__ == "__main__":
    unittest.main(verbosity=2)
