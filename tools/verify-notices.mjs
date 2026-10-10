#!/usr/bin/env node
/**
 * Keep the redistribution surface and the declaration of it in step.
 *
 * This plugin hands out 16 files it did not write (15 reference images and the
 * upstream catalogue), and it quotes upstream specification text inside its own
 * source. That is the one part of publishing this repository that can go wrong
 * **silently**: everything else is caught by `tsc` or a failing test, but a
 * redistributed file with no notice, or a notice that has quietly stopped matching
 * what is on disk, looks exactly like a correct repository.
 *
 * So the file list is generated from the tree itself — not maintained by hand —
 * and this script asserts that the committed declaration is exactly what the tree
 * produces: one generated copy, one committed copy, asserted equal.
 *
 * It also answers three questions that must be true before a repository can be
 * published at all:
 *   - the layered licence files exist and actually say what they claim;
 *   - the mandatory attributions (upstream, the two named third-party creators,
 *     the runtime dependency, the non-official disclaimer) are present, together
 *     with the authorization record and the scope caveat upstream attaches to it;
 *   - the package no longer declares itself private.
 *
 * Usage:
 *     node tools/verify-notices.mjs            # regenerate the block in place
 *     node tools/verify-notices.mjs --check    # fail if it drifted
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const NOTICES = join(ROOT, 'THIRD-PARTY-NOTICES.md')
const BEGIN = '<!-- vendored-files:begin -->'
const END = '<!-- vendored-files:end -->'
const VENDOR = join(ROOT, 'vendor', 'whalechan-image-character')

/** Fail with a readable reason. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Read a file, or return '' when it is absent. */
function readOr(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Every file under a directory, posix-relative and sorted. */
function filesUnder(root, prefix = '') {
  const found = []
  const directory = prefix === '' ? root : join(root, ...prefix.split('/'))
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...filesUnder(root, path))
    else found.push(path)
  }
  return found
}

/**
 * The generated block: one row per redistributed file, in tree order.
 *
 * The digests are the point. A notice that says "15 images from project X" cannot
 * be checked by anyone; a table of paths, byte sizes and SHA-256 digests can be
 * compared against the upstream repository file by file.
 */
function generated() {
  check(existsSync(VENDOR), `no vendored tree at ${VENDOR} — is this the plugin repository?`)
  const files = filesUnder(VENDOR)
  check(files.length > 0, 'the vendored tree is empty')
  const rows = files.map((path) => {
    const bytes = readFileSync(join(VENDOR, ...path.split('/')))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return `| \`vendor/whalechan-image-character/${path}\` | ${bytes.byteLength} | \`${sha256}\` |`
  })
  const provenance = JSON.parse(readFileSync(join(ROOT, 'vendor', 'PROVENANCE.json'), 'utf8'))
  const record = provenance.vendors['whalechan-image-character']
  const total = files.reduce((sum, path) => sum + statSync(join(VENDOR, ...path.split('/'))).size, 0)
  return [
    BEGIN,
    `再分发文件共 **${files.length}** 个，合计 **${total}** 字节。清单与摘要由 \`tools/verify-notices.mjs\` 生成。`,
    '',
    '| 文件 | 字节 | SHA-256 |',
    '| --- | ---: | --- |',
    ...rows,
    '',
    `本 vendor 树的摘要（口径见 \`vendor/PROVENANCE.json\` 的 \`covers\`；路径相对本树根）：\`${record.digest}\``,
    '',
    `\`vendor/PROVENANCE.json\` 自身的摘要（对上面这些记录再哈希一次，动任何一处都会变）：\`${provenance.digest}\``,
    '',
    `上游对应位置：\`skills/${record.source.split('/').pop()}/\`（本机冻结来源：\`${record.source}\`）。`,
    END,
  ].join('\n')
}

/** Replace the block between the markers, refusing a document without them. */
function splice(text) {
  const from = text.indexOf(BEGIN)
  const to = text.indexOf(END)
  check(from >= 0 && to > from, `THIRD-PARTY-NOTICES.md is missing its ${BEGIN} … ${END} block`)
  return `${text.slice(0, from)}${generated()}${text.slice(to + END.length)}`
}

/** The attributions that must survive any edit of the notice. */
const REQUIRED = [
  ['the upstream repository', 'https://github.com/Neko3000/deepseek-whalechan'],
  ['the upstream author', 'Neko3000'],
  ['the first named third-party creator', 'ZipZipPipe'],
  ['the second named third-party creator', '上善无形'],
  ['the runtime dependency', '@dickpy/dsh-imagegen'],
  ['its licence', 'Apache-2.0'],
  ['the non-official disclaimer', '不是 DeepSeek 官方项目'],
  ['the non-commercial warning', '不得用于商业用途'],
  ['the CC BY-NC-SA licence', 'CC BY-NC-SA 4.0'],
  // The authorization is pinned by link, so it cannot be quietly dropped or
  // restated as something wider than what upstream actually recorded.
  ['the upstream authorization record', 'issues/3#issuecomment-6040420103'],
  ['the upstream licence-change record', 'ea972d7'],
  ['the image-scope caveat, in upstream\'s own words', 'not a blanket grant of third-party rights'],
]

function main() {
  // 1. The layered licence must exist and say what it claims.
  const mit = readOr(join(ROOT, 'LICENSE'))
  check(mit.includes('MIT License'), 'LICENSE does not contain the MIT text')
  check(mit.includes('Permission is hereby granted'), 'LICENSE does not contain the MIT grant')
  check(
    mit.includes('vendor/') && mit.includes('character.ts'),
    'LICENSE must name what MIT does NOT cover (the vendored tree and the specification-derived compiler)',
  )
  const cc = readOr(join(ROOT, 'LICENSE-CC-BY-NC-SA-4.0.md'))
  check(cc.includes('CC BY-NC-SA 4.0'), 'LICENSE-CC-BY-NC-SA-4.0.md does not name its licence')
  check(cc.includes('creativecommons.org/licenses/by-nc-sa/4.0'), 'it does not link the licence text')
  check(cc.includes('reference-catalog.json'), 'it does not list the redistributed catalogue')

  // 2. The notice must carry every mandatory attribution.
  const notices = readOr(NOTICES)
  check(notices !== '', 'THIRD-PARTY-NOTICES.md is missing')
  for (const [what, needle] of REQUIRED) {
    check(notices.includes(needle), `THIRD-PARTY-NOTICES.md no longer names ${what} (${needle})`)
  }

  // 3. The generated block must match the tree that is actually on disk.
  const rendered = splice(notices)
  const checkOnly = process.argv.includes('--check')
  if (checkOnly) {
    check(
      rendered === notices,
      'the redistributed-file list in THIRD-PARTY-NOTICES.md has drifted from vendor/ — '
        + 'run `node tools/verify-notices.mjs` and commit the result',
    )
  } else if (rendered !== notices) {
    writeFileSync(NOTICES, rendered, 'utf8')
  }

  // 4. A repository that still says private cannot be published.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  check(manifest.private !== true, 'package.json still declares "private": true — it cannot be published as is')
  check(
    typeof manifest.license === 'string' && manifest.license !== 'MIT',
    'package.json must not claim a single SPDX licence: this repository is layered '
      + '(MIT for the original code, CC BY-NC-SA 4.0 for the redistributed upstream content)',
  )
  for (const file of ['LICENSE', 'LICENSE-CC-BY-NC-SA-4.0.md', 'THIRD-PARTY-NOTICES.md']) {
    check(manifest.files?.includes(file) === true, `package.json "files" must ship ${file}`)
  }

  const files = filesUnder(VENDOR)
  process.stdout.write(
    `notices verification passed\n`
      + `  licence     LICENSE (MIT: our code plus the MIT-licensed upstream constants) + LICENSE-CC-BY-NC-SA-4.0.md\n`
      + `  scope       the images are outside upstream's grants; the caveat and the authorization link are pinned\n`
      + `  attributable ${REQUIRED.length} mandatory names present, ${files.length} redistributed files listed\n`
      + `  block       ${checkOnly ? 'matches vendor/ exactly' : 'regenerated in place'}\n`
      + `  package     not private, no single-SPDX claim, licenses shipped\n`,
  )
}

try {
  main()
} catch (error) {
  process.stderr.write(`notices verification FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
