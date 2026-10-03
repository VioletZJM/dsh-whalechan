#!/usr/bin/env python3
"""Install the Pillow `magick` stand-in into a Python process that runs the oracle.

`shutil.which("magick")` is the oracle's only gate on ImageMagick: three scripts
ask for the executable by name and then hand its argv to `subprocess.run`. Both
of those are patchable, so the shim installs itself by replacing exactly those
two, and needs no executable on PATH — which is what makes it immune to cmd.exe
eating the `%` and `|` in the format strings.

Usage:
    import oracle_bootstrap   # side effect: the stand-in is installed
    assert shutil.which("magick") is not None
"""

from __future__ import annotations

import subprocess
import shutil

import magick_shim

SENTINEL = "<pillow-magick>"

_original_which = shutil.which
_original_run = subprocess.run


def _which(command, *args, **kwargs):
    if command == "magick":
        return SENTINEL
    return _original_which(command, *args, **kwargs)


def _run(args, *pargs, **kwargs):
    if isinstance(args, (list, tuple)) and args and args[0] == SENTINEL:
        result = magick_shim.invoke([str(item) for item in args[1:]])
        completed = subprocess.CompletedProcess(args, result.code, result.stdout, result.stderr)
        if kwargs.get("check") and result.code != 0:
            raise subprocess.CalledProcessError(result.code, args, result.stdout, result.stderr)
        return completed
    return _original_run(args, *pargs, **kwargs)


def install() -> None:
    """Patch `shutil.which` and `subprocess.run`; idempotent."""
    shutil.which = _which
    subprocess.run = _run


install()
