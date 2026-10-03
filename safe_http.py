"""Bounded anonymous HTTP for metadata. No proxies, cookies or ambient auth.

DNS answers are all validated; the socket connects to a numeric answer, never
resolving the hostname again. Every redirect goes through the same boundary.
"""
from dataclasses import dataclass
import http.client
import ipaddress
import queue
import re
import socket
import ssl
import threading
import time
import zlib
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

TOTAL_TIMEOUT = 8.0
CONNECT_TIMEOUT = 2.0
DNS_TIMEOUT = 2.0
# An anonymous Instagram post shell measures ~637 KB; below that it is a
# deterministic too_large, not a size guard.
HTML_LIMIT = 1024 * 1024
IMAGE_LIMIT = 4 * 1024 * 1024
MAX_REDIRECTS = 3
ERROR_CODES = frozenset({"invalid_url", "blocked_url", "dns_failure", "timeout",
                         "too_large", "unsupported_encoding", "http_error",
                         "redirect_limit", "network_error", "invalid_image",
                         "busy", "internal_error"})


class SafeHTTPError(Exception):
    def __init__(self, code, status=None):
        self.code = code if code in ERROR_CODES else "internal_error"
        # HTTP status of an http_error, so callers can tell a gone page (404/410)
        # from a temporary server fault (5xx).
        self.status = status if isinstance(status, int) else None
        super().__init__(self.code)


@dataclass(frozen=True)
class Target:
    url: str
    scheme: str
    host: str
    port: int
    authority: str
    path: str


@dataclass(frozen=True)
class Response:
    url: str
    status: int
    headers: dict
    body: bytes


def remaining(deadline):
    value = deadline - time.monotonic()
    if value <= 0:
        raise SafeHTTPError("timeout")
    return value


def _public_ip(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        raise SafeHTTPError("blocked_url") from None
    if (not address.is_global or address.is_multicast or address.is_reserved
            or address.is_loopback or address.is_link_local or address.is_unspecified):
        raise SafeHTTPError("blocked_url")
    if isinstance(address, ipaddress.IPv6Address):
        # Do not let transition addresses tunnel to an unvalidated IPv4 target.
        if address.ipv4_mapped:
            _public_ip(str(address.ipv4_mapped))
        if address.sixtofour or address.teredo:
            raise SafeHTTPError("blocked_url")
    return str(address)


def parse_url(url):
    """Syntax and literal-address checks without any network or filesystem I/O."""
    if (not isinstance(url, str) or not url or len(url) > 4096 or "\\" in url
            or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url)
            or re.search(r"%(?![0-9a-fA-F]{2})", url)):
        raise SafeHTTPError("invalid_url")
    try:
        parts = urlsplit(url)
        if (parts.scheme not in ("http", "https") or not parts.netloc
                or parts.username is not None or parts.password is not None
                or "%" in parts.netloc or not parts.hostname):
            raise ValueError()
        host = parts.hostname.rstrip(".").encode("idna").decode("ascii").lower()
        port = parts.port if parts.port is not None else (443 if parts.scheme == "https" else 80)
        if not 1 <= port <= 65535 or len(host) > 253:
            raise ValueError()
        try:
            ipaddress.ip_address(host)
        except ValueError:
            if (":" in host or "." not in host
                    or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                           for label in host.split("."))):
                raise ValueError()
            if host == "localhost" or host.endswith((".localhost", ".local")) or host == "local":
                raise SafeHTTPError("blocked_url")
        else:
            _public_ip(host)
        authority = f"[{host}]" if ":" in host else host
        if port != (443 if parts.scheme == "https" else 80):
            authority += f":{port}"
        path = quote(parts.path or "/", safe="/%:@!$&'()*+,;=-._~")
        query = quote(parts.query, safe="/%?:@!$&'()*+,;=-._~")
        normalized = urlunsplit((parts.scheme, authority, path, query, ""))
        return Target(normalized, parts.scheme, host, port, authority, path + ("?" + query if query else ""))
    except (ValueError, UnicodeError):
        raise SafeHTTPError("invalid_url") from None


# A stuck system resolver may retain at most three daemon workers and three
# queued jobs. Timed-out callers never spawn replacement workers or grow a pool.
_dns_queue = queue.Queue(maxsize=3)
_dns_lock = threading.Lock()
_dns_started = False


def _dns_worker():
    while True:
        host, port, deadline, event, box = _dns_queue.get()
        try:
            if time.monotonic() < deadline:
                box["answers"] = socket.getaddrinfo(host, port, socket.AF_UNSPEC, socket.SOCK_STREAM, socket.IPPROTO_TCP)
            else:
                box["error"] = "timeout"
        except Exception:
            box["error"] = "dns_failure"
        finally:
            event.set()
            _dns_queue.task_done()


def _resolve(host, port, deadline):
    global _dns_started
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return [_public_ip(str(address))]
    with _dns_lock:
        if not _dns_started:
            for index in range(3):
                threading.Thread(target=_dns_worker, name=f"metadata-dns-{index}", daemon=True).start()
            _dns_started = True
    event, box = threading.Event(), {}
    dns_deadline = min(deadline, time.monotonic() + DNS_TIMEOUT)
    try:
        _dns_queue.put_nowait((host, port, dns_deadline, event, box))
    except queue.Full:
        raise SafeHTTPError("busy") from None
    if not event.wait(remaining(dns_deadline)):
        raise SafeHTTPError("timeout")
    remaining(deadline)
    if "error" in box:
        raise SafeHTTPError(box["error"])
    answers = box.get("answers", [])
    if not answers or len(answers) > 32:
        raise SafeHTTPError("dns_failure")
    addresses = []
    for family, kind, protocol, _, sockaddr in answers:
        if family not in (socket.AF_INET, socket.AF_INET6) or kind != socket.SOCK_STREAM:
            raise SafeHTTPError("blocked_url")
        address = _public_ip(sockaddr[0])
        if "%" in sockaddr[0] or (family == socket.AF_INET6 and len(sockaddr) > 3 and sockaddr[3]):
            raise SafeHTTPError("blocked_url")
        if address not in addresses:
            addresses.append(address)
    return addresses


def validate_url(url, deadline):
    target = parse_url(url)
    addresses = _resolve(target.host, target.port, deadline)
    remaining(deadline)
    return target, addresses


def _connect(address, port, timeout):
    """The only TCP boundary: a numeric address, never a hostname lookup."""
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    try:
        sock.settimeout(timeout)
        sock.connect((address, port, 0, 0) if family == socket.AF_INET6 else (address, port))
        return sock
    except BaseException:
        sock.close()
        raise


class _PinnedConnection(http.client.HTTPConnection):
    def connect(self):
        # get() explicitly supplies the pinned socket; never silently reconnect.
        raise SafeHTTPError("network_error")


def _request(target, address, deadline, limit, headers):
    sock = None
    connection = None
    response = None
    timer = None
    active_socket = []

    def abort():
        for active in active_socket[:]:
            try:
                active.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                active.close()
            except OSError:
                pass

    try:
        sock = _connect(address, target.port, min(CONNECT_TIMEOUT, remaining(deadline)))
        active_socket.append(sock)
        timer = threading.Timer(remaining(deadline), abort)
        timer.daemon = True
        timer.start()
        if target.scheme == "https":
            context = ssl.create_default_context()
            # Attach before handshake so the wall timer can interrupt TLS too.
            sock = context.wrap_socket(sock, server_hostname=target.host, do_handshake_on_connect=False)
            active_socket.append(sock)
            sock.settimeout(min(CONNECT_TIMEOUT, remaining(deadline)))
            sock.do_handshake()
        # Only the TCP connect and TLS handshake are held to CONNECT_TIMEOUT. A
        # slow server may take several seconds to send its first byte; that is
        # what the overall deadline is for.
        sock.settimeout(remaining(deadline))
        connection = _PinnedConnection(target.host, target.port)
        connection.sock = sock
        request_headers = {"Host": target.authority, "User-Agent": "SavedPostsMetadata/1.0",
                           "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity",
                           "Connection": "close"}
        # Only fixed metadata headers, never caller cookies/auth/proxy settings.
        for name in ("User-Agent", "Accept", "Accept-Language"):
            if headers and name in headers:
                request_headers[name] = headers[name]
        connection.request("GET", target.path, headers=request_headers)
        response = connection.getresponse()
        remaining(deadline)
        response_headers = {name.lower(): response.getheader(name) for name in response.headers.keys()}
        encoding = response_headers.get("content-encoding", "identity").lower().strip()
        if encoding not in ("", "identity", "gzip"):
            raise SafeHTTPError("unsupported_encoding")
        length = response_headers.get("content-length")
        if length is not None:
            if not re.fullmatch(r"[0-9]+", length) or len(length) > 12:
                raise SafeHTTPError("too_large")
            if int(length) > limit:
                raise SafeHTTPError("too_large")
        transfer = response_headers.get("transfer-encoding", "").lower().strip()
        if transfer not in ("", "chunked") or (transfer and length is not None):
            raise SafeHTTPError("network_error")
        # Redirect/error bodies are unused; close rather than downloading them.
        if response.status in (301, 302, 303, 307, 308):
            return Response(target.url, response.status, response_headers, b"")
        if not 200 <= response.status < 300:
            raise SafeHTTPError("http_error", response.status)
        body = bytearray()
        wire_size = 0
        decoder = zlib.decompressobj(16 + zlib.MAX_WBITS) if encoding == "gzip" else None
        while not response.isclosed():
            sock.settimeout(remaining(deadline))
            chunk = response.read(min(65536, limit + 1 - wire_size))
            remaining(deadline)
            if not chunk:
                break
            wire_size += len(chunk)
            if wire_size > limit:
                raise SafeHTTPError("too_large")
            # max_length bounds allocation, not just the eventual size check.
            # One extra decoded byte proves overflow; never flush unboundedly.
            if decoder is not None:
                if decoder.eof:
                    raise SafeHTTPError("network_error")
                chunk = decoder.decompress(chunk, limit + 1 - len(body))
            body.extend(chunk)
            if len(body) > limit:
                raise SafeHTTPError("too_large")
            if decoder is not None and decoder.unused_data:
                # Reject trailing garbage or concatenated members, not a chain.
                raise SafeHTTPError("network_error")
        if decoder is not None and not decoder.eof:
            raise SafeHTTPError("network_error")
        if length is not None and wire_size != int(length) and response.status != 204:
            raise SafeHTTPError("network_error")
        return Response(target.url, response.status, response_headers, bytes(body))
    except SafeHTTPError:
        raise
    except (socket.timeout, TimeoutError):
        raise SafeHTTPError("timeout") from None
    except Exception:
        code = "timeout" if time.monotonic() >= deadline else "network_error"
        raise SafeHTTPError(code) from None
    finally:
        if timer:
            timer.cancel()
        if response:
            response.close()
        if connection:
            connection.close()
        for active in active_socket:
            active.close()
        if sock:
            sock.close()


def _request_any(target, addresses, deadline, limit, headers):
    """Try each validated address in turn: a broken IPv6 route must not sink a
    dual-stack site. Only connection-level failures move on to the next one."""
    last = None
    for address in addresses[:4]:
        try:
            return _request(target, address, deadline, limit, headers)
        except SafeHTTPError as exc:
            if exc.code != "network_error" or time.monotonic() >= deadline:
                raise
            last = exc
    raise last or SafeHTTPError("network_error")


def get(url, *, deadline=None, limit=HTML_LIMIT, headers=None):
    deadline = deadline if deadline is not None else time.monotonic() + TOTAL_TIMEOUT
    for hop in range(MAX_REDIRECTS + 1):
        target, addresses = validate_url(url, deadline)
        response = _request_any(target, addresses, deadline, limit, headers)
        remaining(deadline)
        if response.status not in (301, 302, 303, 307, 308):
            return response
        if hop == MAX_REDIRECTS:
            raise SafeHTTPError("redirect_limit")
        location = response.headers.get("location", "")
        if (not location or "\\" in location
                or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in location)):
            raise SafeHTTPError("invalid_url")
        url = urljoin(target.url, location)
    raise SafeHTTPError("redirect_limit")
