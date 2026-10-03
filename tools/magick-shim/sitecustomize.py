"""Install the Pillow `magick` stand-in in every Python process that opts in.

The oracle's tests run `validate-image.py` as a subprocess, so patching one
interpreter is not enough: the child needs the stand-in too. Python imports
`sitecustomize` automatically at startup when it is importable, which makes it
the right hook.

Opt-in through `WHALECHAN_MAGICK_SHIM=1` so that merely having this directory on
`PYTHONPATH` changes nothing by itself.
"""

from __future__ import annotations

import os

if os.environ.get("WHALECHAN_MAGICK_SHIM") == "1":
    import oracle_bootstrap  # noqa: F401  -- the import installs the stand-in
