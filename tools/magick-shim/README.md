# magick-shim — running the frozen Python oracle without ImageMagick

The plugin rewrite is measured against the frozen Python oracle in
`dsh-whalechan/.dsh/skills/**`. That oracle identifies reference images through
ImageMagick, and ImageMagick is not installed on this machine — nor is it part of
the DSH payload, which is exactly why the charter's D1 makes replacing it the
first thing the rewrite must do.

One missing binary took **20 of `test_manage_run.py`'s 38 Tests offline**: they
failed on `"ImageMagick 'magick' is required to validate reference images"`, not
on the behaviour they exist to check. That is a safety net with a hole in it,
and it is the net the whole rewrite is measured against.

## What this is

A Pillow implementation of the five `magick` invocation shapes the oracle
actually uses:

| shape | used by |
| --- | --- |
| `identify -quiet -format "%m\|%w\|%h\|%[colorspace]" <path>` | `manage-run.py` |
| `identify -quiet -format "%m\|%w\|%h\|%[colorspace]\|%[channels]" <path>` | `validate-image.py` |
| `<path> -alpha extract -format "%[fx:minima]" info:` | `validate-image.py` |
| `<path> -alpha extract -threshold 5% -format "%[fx:1-mean]" info:` | `validate-image.py` |
| `-size <WxH> xc:<colour> [-fill <c> -draw rectangle ...] [-define png:color-type=N] <out>` | fixtures |

Everything else — including `measure-form.py`'s overlay rendering over an
existing image — is **refused loudly** rather than approximated.

## Why it is not an executable

The format strings contain `%` and `|`. A `.cmd` wrapper forwarding them through
`%*` lets cmd.exe split the argument, and the shim then sees `%w` as a command
name. It installs by replacing `shutil.which` and `subprocess.run` in-process
instead, which involves no shell at all.

That patch has to reach **child interpreters** too, because the tests run
`validate-image.py` as a subprocess. `sitecustomize.py` provides that hook, and
`WHALECHAN_MAGICK_SHIM=1` keeps it opt-in.

## Use

```powershell
python tools/magick-shim/run_oracle_tests.py test_manage_run.py <oracle-tests-dir>
python tools/magick-shim/run_oracle_tests.py 'test_*.py'      <oracle-tests-dir>
```

## Fidelity caveat

This makes the oracle **internally consistent** again. It does **not** prove
Pillow matches ImageMagick pixel-for-pixel, and the oracle's own pixel tests
compare `validate-image.py` against the shim on both sides — so they cannot
detect a shim that is wrong in the same way twice.

The charter's Pillow-equivalence criterion therefore still needs either a real
`magick` once, or the frozen artifacts a real `magick` produced. Those artifacts
exist in past run directories under `.smoke/` and `artifacts/`, and diffing
against them is the honest way to close that question.
