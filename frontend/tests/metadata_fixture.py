"""Synthetic HTTP only. Not imported by production.

ControlledHTTP patches socket.getaddrinfo and safe_http._connect, leaving URL,
DNS-answer, redirect, size, deadline and parser checks real. Routes map paths to
(status, headers, bytes) or handler callables. Use with install_guard(root) in a
standalone test process; never install these patches in an owner service.
"""
import contextlib
import os
import socket
import socketserver
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

PUBLIC_IP = "93.184.216.34"
BASE_URL = "http://metadata.fixture.test"
JPEG = b"\xff\xd8\xff\xe0" + b"synthetic-image" * 100
_ALLOWED_SOCKETS = set()
_GUARD_ROOTS = []
GUARD_FAILURES = []


def _normal(path):
    # Read-only uploaded-copy connections use SQLite file: URIs. Validate their
    # decoded local path against the same fixture roots, never allow arbitrary URIs.
    if isinstance(path, str) and path.startswith("file:"):
        from urllib.parse import urlsplit, unquote
        parts = urlsplit(path)
        if parts.netloc:
            return "forbidden-uri"
        path = unquote(parts.path)
        if os.name == "nt" and len(path) > 2 and path[0] == "/" and path[2] == ":":
            path = path[1:]
    return os.path.normcase(os.path.abspath(os.fsdecode(path))).replace("\\", "/").lower()


class PlainTLSSocket:
    """Test-only TLS adapter; cryptography itself is not a local HTTP claim."""
    def __init__(self, sock):
        self.sock = sock

    def do_handshake(self):
        pass

    def __getattr__(self, name):
        return getattr(self.sock, name)


def install_guard(root):
    """Deny personal paths, real DNS, non-owned sockets, subprocesses/providers."""
    _GUARD_ROOTS.append(_normal(root) + "/")
    if len(_GUARD_ROOTS) > 1:
        return

    def audit(event, args):
        reason = None
        if event in ("socket.connect", "socket.bind"):
            if args[0] not in _ALLOWED_SOCKETS:
                reason = "non-owned socket"
        elif event in ("socket.getaddrinfo", "socket.gethostbyaddr", "socket.gethostbyname", "socket.sendto", "subprocess.Popen"):
            reason = "external DNS/network/process"
        elif event == "sqlite3.connect":
            if not any(_normal(args[0]).startswith(root) for root in _GUARD_ROOTS):
                reason = "nonfixture SQLite"
        elif event in ("open", "os.listdir", "os.scandir") and not isinstance(args[0], int):
            path = _normal(args[0])
            name = path.rsplit("/", 1)[-1]
            sensitive = (name.startswith(".env") or ".session" in name
                         or ".db" in name or ".sqlite" in name
                         or "/thumb_cache" in path or "/mozilla/firefox" in path
                         or "/user data/" in path or name == "cookies")
            if sensitive and not any(path.startswith(root) for root in _GUARD_ROOTS):
                reason = "personal data path"
        elif event == "import" and args[0].split(".")[0] in ("telethon", "fetcher", "categorizer"):
            reason = "provider import"
        if reason:
            GUARD_FAILURES.append(reason)
            raise RuntimeError("Metadata isolation: " + reason)

    sys.addaudithook(audit)


class ControlledHTTP:
    def __init__(self):
        self.routes = {}
        self.requests = []
        self.connections = []
        self.dns_calls = []
        self.dns = {host: [PUBLIC_IP] for host in (
            "metadata.fixture.test", "cdn.fixture.test", "rebind.fixture.test",
            "www.instagram.com", "www.youtube.com", "i.ytimg.com")}
        self.stop = threading.Event()

    def __enter__(self):
        import safe_http
        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def do_GET(self):
                owner.requests.append((self.path, dict(self.headers)))
                route = owner.routes.get(self.path, (200, {"Content-Type": "text/html"}, b""))
                try:
                    if callable(route):
                        route(self)
                        return
                    status, headers, body = route
                    self.send_response(status)
                    for name, value in headers.items():
                        self.send_header(name, str(value))
                    if "Content-Length" not in headers and "Transfer-Encoding" not in headers:
                        self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                except (OSError, ValueError):
                    pass

        class OwnedServer(ThreadingHTTPServer):
            def server_bind(self):
                socketserver.TCPServer.server_bind(self)
                self.server_name = "synthetic-fixture"
                self.server_port = self.server_address[1]

        self.server = OwnedServer(("127.0.0.1", 0), Handler, bind_and_activate=False)
        self.server.daemon_threads = True
        _ALLOWED_SOCKETS.add(self.server.socket)
        try:
            self.server.server_bind()
            self.server.server_activate()
        finally:
            _ALLOWED_SOCKETS.discard(self.server.socket)
        self.address = self.server.server_address
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

        def resolve(host, port, *args, **kwargs):
            self.dns_calls.append((host, port))
            values = self.dns.get(host)
            if callable(values):
                values = values()
            if values is None:
                raise socket.gaierror("synthetic unknown host")
            return [(socket.AF_INET6 if ":" in ip else socket.AF_INET,
                     socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (ip, port)) for ip in values]

        def connect(address, port, timeout):
            self.connections.append((address, port, timeout))
            if address != PUBLIC_IP:
                raise AssertionError("Only validated public fixture IP may reach fixture server")
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(timeout)
            _ALLOWED_SOCKETS.add(sock)
            try:
                sock.connect(self.address)
            except BaseException:
                sock.close()
                raise
            finally:
                _ALLOWED_SOCKETS.discard(sock)
            return sock

        self.stack = contextlib.ExitStack()
        self.stack.enter_context(patch.object(socket, "getaddrinfo", resolve))
        self.stack.enter_context(patch.object(safe_http, "_connect", connect))
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.stack.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def html(self, path, body):
        self.routes[path] = (200, {"Content-Type": "text/html; charset=utf-8"}, body.encode("utf-8"))
