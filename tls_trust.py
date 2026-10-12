"""Check website certificates the way the operating system does.

Python's own check reads Windows' certificate store into OpenSSL and builds
the chain itself. On real Windows machines that store can hold expired
intermediates and cross-signed roots, and OpenSSL then reports "certificate
has expired" for sites the browser opens fine (seen on Wikipedia, Hacker News
and nasa.gov in October 2026). truststore hands the check to the operating
system instead: Windows' own chain engine, the macOS keychain, or the system
store on Linux. It also honours certificates that antivirus or company
software installs, as the browser does.

use_system_trust() is called once at startup by the app's entry points. When truststore is not
installed (a bare source checkout) Python's own check is used, as before.
"""

import ssl

_enabled = False


def use_system_trust() -> bool:
    """Check website certificates with the operating system from now on. True when active.

    Deliberately not truststore.inject_into_ssl(): that swaps ssl.SSLContext for
    the whole process, server-side contexts included. Only outgoing requests
    made through safe_http use client_context().
    """
    global _enabled
    try:
        import truststore  # noqa: F401
    except ImportError:
        return False
    _enabled = True
    return True


def client_context() -> ssl.SSLContext:
    """A context for outgoing HTTPS: the operating system's check when enabled."""
    if _enabled:
        import truststore
        return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    return ssl.create_default_context()
