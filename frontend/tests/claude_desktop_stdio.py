"""The Claude Desktop extension's server (claude-desktop/server/index.js, v0.4.0 phase 5) driven over stdio the way
Claude Desktop runs it, by a scripted client, against the real app served on 127.0.0.1 with a synthetic library:
the handshake, its tools, reads and writes through the app, refusals as tool errors, and the token never sent to
anything but the app that made it. Also the .mcpb bundle claude-desktop/build.py makes. Nothing is installed into
Claude Desktop.

Run: python -B frontend/tests/claude_desktop_stdio.py   (needs Node 18 or newer on PATH)
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import queue
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "packaging"))
FIXTURE = Path(tempfile.mkdtemp(prefix="claude-desktop-stdio-"))
os.environ["SUPER_BOOKMARK_MANAGER_DATA_DIR"] = str(FIXTURE / "data")
os.environ["SAVED_POSTS_DB_PATH"] = str(FIXTURE / "library.sqlite")
os.environ["SBM_ARCHIVE_DIR"] = str(FIXTURE / "archive")
os.environ["SBM_SAVED_COPIES"] = "off"
import storage  # noqa: E402
import app as dashboard  # noqa: E402
import claude_desktop  # noqa: E402
from werkzeug.serving import make_server  # noqa: E402

NODE = shutil.which("node")
SERVER = ROOT / "claude-desktop" / "server" / "index.js"
TOOLS = {"search_links", "list_shelves", "list_unfiled", "get_link", "file_links", "suggest_shelf"}
AT = "2026-10-20T10:00:00.000Z"
APP_PAGE = {"Sec-Fetch-Site": "same-origin"}


def post(name, title, shelf=None, created=AT):
    return {"id": f"id-{name}", "url": f"https://{name}.example.invalid/page", "source": "browser", "platform": "web",
            "domain": f"{name}.example.invalid", "status": "inbox", "createdAt": created, "updatedAt": created,
            "metadataStatus": "partial", "categories": [shelf] if shelf else [], "categoryMode": "manual", "tags": [],
            "projectIds": [], "title": title}


class Stdio:
    """The extension's server as Claude Desktop starts it: node, its settings in the environment, one JSON-RPC
    message per line on stdin and stdout."""

    def __init__(self, token, app):
        self.proc = subprocess.Popen([NODE, str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     env={**os.environ, "SBM_TOKEN": token, "SBM_APP": app}, text=True, encoding="utf-8")
        self.lines = queue.Queue()
        threading.Thread(target=lambda: [self.lines.put(line) for line in self.proc.stdout], daemon=True).start()
        self.next = 0

    def send(self, message):
        self.proc.stdin.write((message if isinstance(message, str) else json.dumps(message)) + "\n")
        self.proc.stdin.flush()

    def answer(self, timeout=30):
        return json.loads(self.lines.get(timeout=timeout))

    def request(self, method, params=None):
        self.next += 1
        self.send({"jsonrpc": "2.0", "id": self.next, "method": method, **({"params": params} if params is not None else {})})
        reply = self.answer()
        assert reply.get("id") == self.next, reply
        return reply

    def tool(self, name, arguments=None):
        """A tool's answer: (is it an error, its text)."""
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})["result"]
        return bool(result.get("isError")), result["content"][0]["text"]

    def close(self):
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self.proc.stdout.close()
        self.proc.stderr.close()


class Impostor(BaseHTTPRequestHandler):
    """Another program on a port: it answers the hello (made up, or passed on from the real app) and notes every
    request, to show the token never reaches it."""
    seen = []
    relay = ""
    redirect = False

    def do_GET(self):
        Impostor.seen.append((self.path, self.headers.get("X-SBM-Claude")))
        if self.path.startswith("/api/mcp/hello") and Impostor.redirect:
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/catch")
            self.end_headers()
            return
        if self.path.startswith("/api/mcp/hello") and Impostor.relay:
            with urllib.request.urlopen(Impostor.relay + self.path, timeout=5) as answer:
                body = answer.read()
        else:
            body = json.dumps({"ok": True, "proof": "0" * 64}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    do_POST = do_GET

    def log_message(self, *args):
        pass


def free_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@unittest.skipUnless(NODE, "Node isn't on PATH")
class ClaudeDesktopStdio(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        storage.init_db()
        logging.getLogger("werkzeug").setLevel(logging.ERROR)
        cls.http = make_server("127.0.0.1", 0, dashboard.app, threaded=True)
        cls.app = f"http://127.0.0.1:{cls.http.server_port}"
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.client = dashboard.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()

    def setUp(self):
        storage.config.DB_PATH = str(FIXTURE / f"{self._testMethodName}.sqlite")
        storage.init_db()
        claude_desktop._path().unlink(missing_ok=True)
        claude_desktop._presence.clear()
        storage.save_library({"posts": [post("bread", "Slow bread: a sourdough schedule", "food-drink", "2026-10-21T10:00:00.000Z"),
                                        post("rye", "Rye crackers from leftover starter", created="2026-10-22T10:00:00.000Z")],
                              "deletedUrls": []})
        self.token = self.client.post("/api/claude-desktop/token", json={}, headers=APP_PAGE).json["token"]
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.close()

    def start(self, token=None, app=None):
        server = Stdio(self.token if token is None else token, self.app if app is None else app)
        self.servers.append(server)
        return server

    def test_handshake_and_its_tools(self):
        server = self.start()
        hello = server.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}})["result"]
        self.assertEqual((hello["protocolVersion"], hello["serverInfo"]["name"]), ("2025-06-18", "superbookmarks"))
        self.assertIn("tools", hello["capabilities"])
        self.assertIn("suggest a new shelf instead of inventing one", hello["instructions"])
        server.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual(server.request("ping")["result"], {}, "a notification gets no answer: the next answer is the ping's")
        tools = server.request("tools/list")["result"]["tools"]
        self.assertEqual({tool["name"] for tool in tools}, TOOLS)
        self.assertTrue(all(tool["inputSchema"]["type"] == "object" and tool["description"] for tool in tools))
        hints = {tool["name"]: tool["annotations"] for tool in tools}
        self.assertTrue(all(hints[name]["readOnlyHint"] for name in ("search_links", "list_shelves", "list_unfiled", "get_link")))
        self.assertEqual(hints["file_links"], {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False})
        self.assertFalse(hints["suggest_shelf"]["readOnlyHint"] or hints["suggest_shelf"]["destructiveHint"])
        self.assertTrue(all(hint["openWorldHint"] is False for hint in hints.values()), "nothing past the app on this computer")
        older = self.start().request("initialize", {"protocolVersion": "2099-01-01"})["result"]
        self.assertEqual(older["protocolVersion"], "2025-06-18", "an unknown version gets the newest it speaks")

    def test_reads_and_writes_go_through_the_app(self):
        server = self.start()
        error, text = server.tool("search_links", {"query": "sourdough"})
        self.assertFalse(error, text)
        self.assertEqual([link["id"] for link in json.loads(text)["links"]], ["id-bread"])
        shelves = {s["name"]: s["links"] for s in json.loads(server.tool("list_shelves")[1])["shelves"]}
        self.assertEqual(shelves["food-drink"], 1)
        self.assertEqual([link["id"] for link in json.loads(server.tool("list_unfiled")[1])["links"]], ["id-rye"])
        self.assertEqual(json.loads(server.tool("get_link", {"id": "id-rye"})[1])["link"]["title"], "Rye crackers from leftover starter")
        error, text = server.tool("file_links", {"ids": ["id-rye"], "shelf": "Food Drink", "tags": ["starter"]})
        self.assertFalse(error, text)
        self.assertEqual(json.loads(text)["filed"], 1)
        rye = next(p for p in storage.get_library(0)["posts"] if p["id"] == "id-rye")
        self.assertEqual((rye["categories"], rye["tags"]), (["food-drink"], ["starter"]))
        error, text = server.tool("suggest_shelf", {"name": "Sourdough", "description": "Starters", "ids": ["id-rye", "id-bread"]})
        self.assertFalse(error, text)
        settings = self.client.get("/api/claude-desktop", headers=APP_PAGE).json
        self.assertEqual(settings["changes"][0]["summary"], "Filed 1 link on food-drink")
        self.assertEqual([(s["name"], s["count"]) for s in settings["suggestions"]], [("sourdough", 2)])
        self.assertNotIn("sourdough", storage.get_library(0)["categories"], "made only by the owner")

    def test_refusals_come_back_as_tool_errors(self):
        server = self.start()
        error, text = server.tool("file_links", {"ids": ["id-rye"], "shelf": "nope"})
        self.assertTrue(error)
        self.assertIn("no shelf called", text)
        self.assertEqual(server.tool("delete_everything"), (True, "No tool called delete_everything."))
        claude_desktop.report_pending("tab-1", ["https://rye.example.invalid/page"])
        error, text = server.tool("file_links", {"ids": ["id-rye"], "shelf": "food-drink"})
        self.assertTrue(error)
        self.assertIn("hasn't saved its changes", text)
        self.assertEqual(next(p for p in storage.get_library(0)["posts"] if p["id"] == "id-rye")["categories"], [])

    def test_the_token_never_goes_to_anything_but_the_app(self):
        port = free_port()
        impostor = ThreadingHTTPServer(("127.0.0.1", port), Impostor)
        threading.Thread(target=impostor.serve_forever, daemon=True).start()
        try:
            # A made-up proof, the real app's own answer passed on, and a redirect elsewhere.
            for relay, redirect, words in (("", False, "Something other than SuperBookmarks answers"),
                                           (self.app, False, "Something other than SuperBookmarks answers"), ("", True, "isn't running")):
                with self.subTest(relay=relay or "made up", redirect=redirect):
                    Impostor.seen, Impostor.relay, Impostor.redirect = [], relay, redirect
                    error, text = self.start(app=f"http://127.0.0.1:{port}").tool("search_links", {"query": "bread"})
                    self.assertTrue(error)
                    self.assertIn(words, text)
                    self.assertEqual([path.split("?")[0] for path, _ in Impostor.seen], ["/api/mcp/hello"])
                    self.assertTrue(all(token is None for _, token in Impostor.seen), "the token never left")
        finally:
            impostor.shutdown()
            impostor.server_close()

    def test_no_app_a_wrong_address_or_an_old_token(self):
        cases = [
            ({"app": f"http://127.0.0.1:{free_port()}"}, "isn't running"),
            ({"app": "http://example.com:5001"}, "must be http://127.0.0.1"),
            ({"app": "http://localhost:5001"}, "must be http://127.0.0.1"),
            ({"token": ""}, "No token yet"),
        ]
        for settings, words in cases:
            with self.subTest(**settings):
                error, text = self.start(**settings).tool("list_shelves")
                self.assertTrue(error)
                self.assertIn(words, text)
        self.client.post("/api/claude-desktop/token", json={}, headers=APP_PAGE)        # a newer token: this one is old
        self.assertIn("doesn't know this token any more", self.start().tool("list_shelves")[1])
        self.client.delete("/api/claude-desktop/token", headers=APP_PAGE)
        self.assertIn("doesn't know this token any more", self.start().tool("list_shelves")[1])

    def test_protocol_errors(self):
        server = self.start()
        self.assertEqual(server.request("resources/list")["error"]["code"], -32601)
        server.send("{not json")
        self.assertEqual(server.answer()["error"]["code"], -32700)
        server.send({"id": 99, "method": "ping"})
        self.assertEqual(server.answer(), {"jsonrpc": "2.0", "id": 99, "error": {"code": -32600, "message": "Invalid request"}})

    def test_the_bundle(self):
        from release_paths import VERSION
        out = subprocess.run([sys.executable, str(ROOT / "claude-desktop" / "build.py")], capture_output=True, text=True, timeout=60)
        self.assertEqual(out.returncode, 0, out.stderr)
        with zipfile.ZipFile(ROOT / "dist-claude-desktop" / "SuperBookmarks.mcpb") as bundle:
            self.assertEqual(sorted(bundle.namelist()), ["icon.png", "manifest.json", "server/index.js"])
            manifest = json.loads(bundle.read("manifest.json"))
            self.assertEqual(bundle.read("server/index.js"), SERVER.read_bytes())
            self.assertEqual(bundle.read("icon.png")[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual((manifest["manifest_version"], manifest["version"], manifest["server"]["type"]), ("0.3", VERSION, "node"))
        config = manifest["server"]["mcp_config"]
        self.assertEqual((manifest["server"]["entry_point"], config["command"], config["args"]), ("server/index.js", "node", ["${__dirname}/server/index.js"]))
        self.assertEqual(config["env"], {"SBM_TOKEN": "${user_config.token}", "SBM_APP": "${user_config.app_address}"})
        self.assertEqual((manifest["user_config"]["token"]["sensitive"], manifest["user_config"]["token"]["required"]), (True, True))
        self.assertEqual({tool["name"] for tool in manifest["tools"]}, TOOLS)
        # The bundled server reports the bundle's version.
        with tempfile.TemporaryDirectory() as unpacked:
            zipfile.ZipFile(ROOT / "dist-claude-desktop" / "SuperBookmarks.mcpb").extractall(unpacked)
            proc = subprocess.run([NODE, str(Path(unpacked) / "server" / "index.js")], input=json.dumps(
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}) + "\n",
                capture_output=True, text=True, timeout=30, env={**os.environ, "SBM_TOKEN": "", "SBM_APP": ""})
            self.assertEqual(json.loads(proc.stdout.splitlines()[0])["result"]["serverInfo"]["version"], VERSION)


if __name__ == "__main__":
    unittest.main(verbosity=1)
