"""Versioned, non-overwriting local release candidate paths."""
import os
import re

VERSION = "0.2.0"  # the one place the release version is set
CANDIDATE = os.environ.get("SBM_BUILD_CANDIDATE", f"v{VERSION}")
if not re.fullmatch(rf"v{re.escape(VERSION)}(?:-r[1-9][0-9]*)?", CANDIDATE):
    raise ValueError(f"SBM_BUILD_CANDIDATE must be v{VERSION} or v{VERSION}-rN")
