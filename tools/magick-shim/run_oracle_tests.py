#!/usr/bin/env python3
"""Run the frozen Python oracle's unittest suite with the Pillow `magick` stand-in installed.

Why a runner instead of a plain `python -m unittest`: the oracle identifies
reference images through ImageMagick, which DSH does not ship. Without a stand-in
20 of `test_manage_run.py`'s 38 tests fail on a missing binary rather than on the
behaviour they exist to check. This puts the stand-in in place for both this
interpreter and the ones the tests spawn.

The oracle lives outside this package (`dsh-whalechan/.dsh/skills/**`), so the
runner takes its directory rather than assuming a layout.

Usage:
    python tools/magick-shim/run_oracle_tests.py test_manage_run.py <tests-dir>
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent

# `sitecustomize` in this directory reaches child interpreters; the flag keeps it opt-in.
os.environ["WHALECHAN_MAGICK_SHIM"] = "1"
_pythonpath = os.environ.get("PYTHONPATH", "")
if str(HERE) not in _pythonpath.split(os.pathsep):
    os.environ["PYTHONPATH"] = os.pathsep.join(part for part in (str(HERE), _pythonpath) if part)

sys.path.insert(0, str(HERE))

import oracle_bootstrap  # noqa: E402  -- the import installs the stand-in in this process too


def main(argv: list[str]) -> int:
    """@param argv - `[pattern, tests_dir]`, both optional."""
    pattern = argv[0] if argv else "test_*.py"
    tests_dir = Path(argv[1]).resolve() if len(argv) > 1 else Path.cwd()
    sys.path.insert(0, str(tests_dir))
    suite = unittest.TestLoader().discover(str(tests_dir), pattern=pattern, top_level_dir=str(tests_dir))
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
