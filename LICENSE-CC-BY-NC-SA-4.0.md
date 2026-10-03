# CC BY-NC-SA 4.0 — the parts that are not mine

This repository is **layered**, exactly like the upstream project it vendors from.
`LICENSE` (MIT) covers the original code. **This file covers everything else** — the
content that comes from, or is derived from, the
[DeepSeek Whale-chan Project](https://github.com/Neko3000/deepseek-whalechan).

## What is under CC BY-NC-SA 4.0

| Path | What it is | Upstream source |
| --- | --- | --- |
| `vendor/whalechan-image-character/assets/reference-images/**` | 15 reference WebP images (three per form) used as identity anchors | `skills/whalechan-image-character/assets/reference-images/**` |
| `vendor/whalechan-image-character/references/reference-catalog.json` | the machine-readable form / ratio / hash catalogue | `skills/whalechan-image-character/references/reference-catalog.json` |
| `src/domain/prompt/character.ts` | the deterministic prompt compiler — **our own implementation of the upstream character specification**. Upstream ships no character-side prompt compiler (its agent composes the prompt from the spec documents), so this file is not a port of upstream code. Its identity / proportion wording is derived from the upstream spec, and it reproduces the sentence "keep apparent age unchanged" verbatim | `skills/whalechan-image-character/references/character-spec.md`, `references/form-profiles.md` |
| `src/domain/compose.ts` | the three canonical default strings (`DEFAULT_STYLE`, `DEFAULT_COSTUME`, `DEFAULT_BACKGROUND`), quoted **verbatim** from upstream's source | `skills/whalechan-image-character/scripts/manage-run.py` (lines 50–52) |

The exact file list, byte sizes and SHA-256 digests of everything redistributed are
generated into `THIRD-PARTY-NOTICES.md` by `tools/verify-notices.mjs`, and the
provenance digests are checked by the `vendor:check` gate. Nothing about the
redistribution surface is maintained by hand.

## The licence

**Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**

- Full legal text: <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>
- Human-readable summary: <https://creativecommons.org/licenses/by-nc-sa/4.0/>

In plain terms:

- **BY** — you must credit `DeepSeek Whale-chan Project` (and the third-party
  creators named in `THIRD-PARTY-NOTICES.md`) and link to the upstream repository.
- **NC** — **you may not use this material commercially.** The upstream README is
  explicit: *"任何商业性使用，商业出版或盈利性衍生品开发，必须获得相关原始著作权人及相关品牌权利方的明确书面授权。"* That authorization is not mine to give.
- **SA** — if you remix, transform or build on it, you must distribute your
  contribution under the same licence.

## Why the plugin is not simply MIT

Anyone who wants a plain-MIT, commercially usable version has to remove the parts in
the table above:

1. stop redistributing the 15 reference images and the catalogue — fetch them from
   the upstream repository at first run, or let the user supply their own; and
2. replace the ported compiler and the quoted canonical text with an independent
   implementation.

That is a real option, and the plugin is structured so it is a *deletion* rather
than a rewrite: `src/run/vendor.ts` owns the vendored tree, and the compiler is one
module behind one function. What it costs is the character's calibrated look and the
three quoted canonical constants — **not** an upstream differential test, because
upstream has no character-side compiler to differ from. Our own differential test
(`test/character-prompt.test.ts`) pins the TypeScript compiler against the Python
implementation this project was ported *from*, which is also ours.

## Non-official

This is a community project. It is **not** an official DeepSeek product; the names
"DeepSeek" and "DeepSeek Whale-chan" and any associated marks belong to their
respective owners. See `THIRD-PARTY-NOTICES.md`.
