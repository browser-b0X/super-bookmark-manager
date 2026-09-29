# Super Bookmark Manager — legacy installed-Python folder

The supported public release path is the self-contained Windows installer described
in [BUILDING.md](../BUILDING.md) and [BUILD_INSTALLER.md](BUILD_INSTALLER.md).
Normal users do not need Python or Node.

`build_package.py`, `package_start.py` and `Start Super Bookmark Manager.bat` are
retained historical installed-Python tooling, not the v0.1.0 release recipe. Their
earlier acceptance predates current credential/auth and import modules; they are not
recertified by this readiness pass. Use the standalone/installer commands for current
source. Do not run legacy maintenance or packaging tools on a personal library.

Source launch uses `run.py --serve-only`; see the root build guide. The old folder
model stores its default database beside run.py. Preserve that folder's data before
removing it. The new packaged runtime retains `%LOCALAPPDATA%\SavedPostsDashboard\`;
no automatic data-directory migration is performed.
