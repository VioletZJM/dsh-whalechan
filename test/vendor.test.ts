/**
 * The vendored engine trees, and the two ways they could silently rot.
 *
 * A frozen copy fails in two directions, and both are quiet:
 *
 * 1. **Edited in place.** Someone patches a vendored script to fix a run, the
 *    plugin ships it, and the change is nowhere near the source of truth.
 * 2. **Diverged from the oracle.** The upstream tree is re-synced and the copy is
 *    not, so the plugin runs one engine while every differential test in this
 *    repository validates against another.
 *
 * The provenance digest catches the first inside the normal suite. The second is
 * caught by digesting the upstream tree with the same rule — which is why the
 * digest helper lives in `src/` and is shared rather than reimplemented here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  PROVENANCE_PATH,
  REPO_ROOT,
  SKILL_VENDORS,
  VENDOR_ROOT,
  provenanceText,
  readProvenance,
  treeDigest,
} from '../src/run/vendor.ts'
import { oracleSkip } from './support/oracle.ts'

test('vendor: every tree matches its recorded provenance', () => {
  const provenance = readProvenance()
  for (const vendor of SKILL_VENDORS) {
    const record = provenance.vendors[vendor.name]
    assert.ok(record !== undefined, `${vendor.name}: no provenance record; run \`node tools/vendor-skills.ts\``)
    const actual = treeDigest(join(VENDOR_ROOT, vendor.name))
    assert.deepEqual(
      { files: actual.files, bytes: actual.bytes, digest: actual.digest },
      { files: record.files, bytes: record.bytes, digest: record.digest },
      `${vendor.name}: the vendored tree no longer matches its provenance. If the edit was intended, re-run `
        + '`node tools/vendor-skills.ts`; if it was not, restore the file.',
    )
  }
})

test('vendor: the provenance file is tamper-evident', () => {
  const provenance = readProvenance()
  assert.ok(existsSync(PROVENANCE_PATH))
  assert.equal(
    createHash('sha256').update(provenanceText(provenance.vendors)).digest('hex'),
    provenance.digest,
    'the vendor records do not match the provenance file\'s own digest',
  )
  assert.match(provenance.covers, /sha256 of contents/, 'the file must state what its digest covers')
})

test('vendor: the frozen tree equals the oracle it was taken from', { skip: oracleSkip() }, async t => {
  for (const vendor of SKILL_VENDORS) {
    const sourceRoot = join(REPO_ROOT, vendor.source)
    const vendored = treeDigest(join(VENDOR_ROOT, vendor.name))
    const upstream = treeDigest(sourceRoot)
    await t.test(vendor.name, () => {
      assert.deepEqual(
        { files: vendored.files, bytes: vendored.bytes, digest: vendored.digest },
        { files: upstream.files, bytes: upstream.bytes, digest: upstream.digest },
        `${vendor.name}: the vendored copy and ${vendor.source} have diverged. The differential suite validates `
          + 'against the upstream tree, so a divergence means the shipped engine and the tested engine differ. '
          + 'Decide which is correct, then re-run `node tools/vendor-skills.ts`.',
      )
    })
  }
})

test('vendor: the runtime subset is what ships, and nothing else', () => {
  // A negative on the filter itself: `tests/` and `__pycache__` must never be part
  // of a vendored tree, and the digest rule is what would be wrong first.
  const vendored = treeDigest(join(VENDOR_ROOT, SKILL_VENDORS[0]!.name))
  assert.ok(vendored.files > 0)
  const provenance = readProvenance()
  assert.equal(provenance.vendors[SKILL_VENDORS[0]!.name]?.files, vendored.files)
})
