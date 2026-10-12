"""Certificates are checked by the operating system (truststore), over real TLS.

A loopback HTTPS server presents a certificate from a throwaway test CA. The
test CA is made the "system" trust store for this process via SSL_CERT_FILE,
which is how truststore finds trusted roots on Linux. No real network.
Run: python -B frontend/tests/tls_trust_test.py (needs truststore and openssl).
"""
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import sys
import tempfile
import unittest

WORKSPACE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(WORKSPACE))
sys.dont_write_bytecode = True
(WORKSPACE / ".verify" / "tls").mkdir(parents=True, exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix="tls-", dir=WORKSPACE / ".verify" / "tls"))
HOST = "metadata.fixture.test"


def make_certificates():
    """A test CA, a server certificate for HOST, and one for another name (all throwaway)."""
    run = lambda *args: subprocess.run(["openssl", *args], cwd=ROOT, check=True, capture_output=True)
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
        "-subj", "/CN=SBM throwaway test CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    for name, cn in (("server", HOST), ("other", "other.fixture.test")):
        run("req", "-newkey", "rsa:2048", "-nodes", "-keyout", f"{name}.key", "-out", f"{name}.csr", "-subj", f"/CN={cn}")
        (ROOT / f"{name}.ext").write_text(f"subjectAltName=DNS:{cn}\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n")
        run("x509", "-req", "-in", f"{name}.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", f"{name}.pem",
            "-days", "2", "-extfile", f"{name}.ext")


try:
    import truststore
except ImportError:
    truststore = None

if truststore and shutil.which("openssl"):
    make_certificates()
    os.environ["SSL_CERT_FILE"] = str(ROOT / "ca.pem")
    os.environ.pop("SSL_CERT_DIR", None)

from metadata_fixture import ControlledHTTP, install_guard, GUARD_FAILURES  # noqa: E402
os.environ["SAVED_POSTS_DB_PATH"] = str(ROOT / "synthetic.sqlite")
install_guard(ROOT)
import safe_http  # noqa: E402
import tls_trust  # noqa: E402


@unittest.skipIf(truststore is None or not shutil.which("openssl"), "truststore or openssl missing")
class SystemTrustTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assertTrue(cls, tls_trust.use_system_trust())

    @classmethod
    def tearDownClass(cls):
        tls_trust._enabled = False

    def serve(self, certificate):
        http = ControlledHTTP().__enter__()
        self.addCleanup(http.__exit__, None, None, None)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(ROOT / f"{certificate}.pem", ROOT / f"{certificate}.key")
        http.server.socket = server_context.wrap_socket(http.server.socket, server_side=True)
        http.html("/tls", "<title>Over TLS</title>")
        return http

    def test_outgoing_requests_verify_with_the_operating_system(self):
        self.assertIsInstance(tls_trust.client_context(), truststore.SSLContext)
        self.assertTrue(tls_trust.use_system_trust(), "calling twice is harmless")
        # Nothing else in the process changes: server-side contexts stay plain OpenSSL.
        self.assertIs(ssl.SSLContext, ssl.SSLContext.__mro__[0])
        self.assertNotIsInstance(ssl.create_default_context(), truststore.SSLContext)

    def test_a_trusted_certificate_is_accepted(self):
        http = self.serve("server")
        response = safe_http.get(f"https://{HOST}/tls")
        self.assertEqual(response.status, 200)
        self.assertIn(b"Over TLS", response.body)
        self.assertEqual(http.connections[0][1], 443)

    def test_a_certificate_for_another_name_is_refused(self):
        http = self.serve("other")
        with self.assertRaises(safe_http.SafeHTTPError) as raised:
            safe_http.get(f"https://{HOST}/tls")
        self.assertEqual(raised.exception.code, "network_error")
        self.assertEqual([r for r in http.requests], [], "no request is sent before the certificate is accepted")

    def test_certificates_have_arrived_when_windows_checks_them(self):
        # On Windows truststore checks the chain as soon as wrap_socket returns and
        # refuses an empty one ("Peer sent no certificates"). Linux has no such
        # step, so it is simulated here: every check must see the server's chain.
        from unittest.mock import patch
        import truststore._api as api
        seen = []

        def windows_like(context, chain, server_hostname=None):
            seen.append(len(chain))
            if not chain:
                raise ssl.SSLCertVerificationError("Peer sent no certificates to verify")
        self.serve("server")
        with patch.object(api, "_verify_peercerts_impl", windows_like):
            response = safe_http.get(f"https://{HOST}/tls")
        self.assertEqual(response.status, 200)
        self.assertTrue(seen and all(n >= 1 for n in seen), seen)

    def test_guard(self):
        self.assertEqual(GUARD_FAILURES, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
