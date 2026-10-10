# CC BY-NC-SA 4.0 — the parts that are not mine

This repository is **layered**. `LICENSE` (MIT) covers the original code.
**This file covers the CC BY-NC-SA 4.0 parts** — the content derived from the
upstream project [DeepSeek Whale-chan](https://github.com/Neko3000/deepseek-whalechan).

> The 15 reference **images are not covered by this file.** Upstream places them
> outside its MIT and CC grants. Their status, and what this repository relies on
> for them, is in `THIRD-PARTY-NOTICES.md` section 1. Read that before reusing
> them for anything.

## What is under CC BY-NC-SA 4.0

| Path | What it is | Upstream source |
| --- | --- | --- |
| `vendor/whalechan-image-character/references/reference-catalog.json` | the machine-readable form / ratio / hash catalogue — upstream JSON catalogue metadata, which upstream licenses under CC BY-NC-SA 4.0 | `skills/whalechan-image-character/references/reference-catalog.json` |
| `src/domain/prompt/character.ts` | the deterministic prompt compiler — **our own implementation of the upstream character specification**. Upstream ships no character-side prompt compiler (its agent composes the prompt from the spec documents), so this file is not a port of upstream code. Its identity / proportion wording is derived from the upstream spec, and it reproduces the sentence "keep apparent age unchanged" verbatim | `skills/whalechan-image-character/references/character-spec.md`, `references/form-profiles.md` |

Taken from upstream as well, but **not** under this licence:

- `src/domain/compose.ts` quotes three canonical constants (`DEFAULT_STYLE`,
  `DEFAULT_COSTUME`, `DEFAULT_BACKGROUND`) verbatim from upstream's
  `skills/whalechan-image-character/scripts/manage-run.py`. That is *code*, and
  upstream licenses its code under **MIT** — so that file stays under MIT and
  upstream's own MIT notice covers the quoted strings. It does not restrict a
  commercial fork.
- `vendor/whalechan-image-character/assets/reference-images/**` — the 15 webp
  images, outside the upstream blanket grants. See `THIRD-PARTY-NOTICES.md`
  section 1.

The exact file list, byte sizes and SHA-256 digests of everything redistributed are
generated into `THIRD-PARTY-NOTICES.md` by `tools/verify-notices.mjs`, and the
provenance digests are checked by the `vendor:check` gate. Nothing about the
redistribution surface is maintained by hand.

## The licence

**Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)**

- Full legal text: <https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode>
- Human-readable summary: <https://creativecommons.org/licenses/by-nc-sa/4.0/>

In plain terms:

- **BY** — you must credit `DeepSeek Whale-chan` (the name the upstream author
  asks for — do not append a "Project" suffix) and the third-party creators named
  in `THIRD-PARTY-NOTICES.md`, and link to the upstream repository.
- **NC** — **you may not use this material commercially.** The upstream README is
  explicit: *"任何商业性使用，商业出版或盈利性衍生品开发，必须获得相关原始著作权人及相关品牌权利方的明确书面授权。"* That authorization is not mine to give.
- **SA** — if you remix, transform or build on it, you must distribute your
  contribution under the same licence.

## Authorization on record

The upstream author answered our authorization request on 2026-10-07 (issue #3,
comment [`6040420103`](https://github.com/Neko3000/deepseek-whalechan/issues/3#issuecomment-6040420103)).
In their words: *"我在此正式授权基于本仓库 README 与 Skills 文档改编/整理内容。"*

Upstream's own `THIRD-PARTY-NOTICES.md` records that reply as supporting this
integration and as explicitly authorizing adaptation/organization of the README
and Skills documentation — and states that it "is not a blanket grant of
third-party rights", and that redistribution of images and transmission to
image-generation services require permissions from the relevant rights holders.
How this repository treats each asset is spelled out in `THIRD-PARTY-NOTICES.md`
section 1.

## Why the plugin is not simply MIT

Anyone who wants a plain-MIT, commercially usable version has to remove the parts
listed above — and **the images are the blocking one**:

1. stop redistributing the 15 reference images: fetch them from the upstream
   repository at first run, or let the user supply their own. The catalogue is
   CC BY-NC-SA 4.0 as well, so drop or replace it too; and
2. replace the specification-derived wording in the compiler with your own
   description of the character.

That is a real option, and the plugin is structured so it is a *deletion* rather
than a rewrite: `src/run/vendor.ts` owns the vendored tree, and the compiler is one
module behind one function. What it costs is the character's calibrated look —
**not** an upstream differential test, because upstream has no character-side
compiler to differ from. Our own differential test
(`test/character-prompt.test.ts`) pins the TypeScript compiler against the Python
implementation this project was ported *from*, which is also ours. The three
quoted constants do not block a commercial fork at all: upstream licenses them
under MIT.

## Non-official

This is a community project. It is **not** an official DeepSeek product; the names
"DeepSeek" and "DeepSeek Whale-chan" and any associated marks belong to their
respective owners. See `THIRD-PARTY-NOTICES.md`.
