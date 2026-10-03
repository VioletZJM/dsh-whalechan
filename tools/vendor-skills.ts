#!/usr/bin/env node
/**
 * Freeze the patched skill trees into `vendor/`, or check that they still match.
 *
 * Run from the plugin repository:
 *   node tools/vendor-skills.ts          # re-freeze and rewrite PROVENANCE.json
 *   node tools/vendor-skills.ts --check  # fail if vendor/ drifted from provenance
 *
 * Node runs `.ts` directly here (type stripping), so the digest rule has exactly
 * one implementation — the one the test suite also uses. A second copy in a
 * build script would eventually disagree with it, and then neither would be
 * trustworthy.
 */
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIGEST_COVERS,
  PROVENANCE_PATH,
  REPO_ROOT,
  SKILL_VENDORS,
  VENDOR_ROOT,
  isVendoredPath,
  provenanceText,
  readProvenance,
  toPosixPath,
  treeDigest,
  type VendorRecord,
} from '../src/run/vendor.ts'
import { createHash } from 'node:crypto'

/** Copy one skill's runtime subset into `vendor/<name>`. */
function freeze(name: string, source: string): VendorRecord {
  const sourceRoot = join(REPO_ROOT, source)
  const target = join(VENDOR_ROOT, name)
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  // Copy only what the runtime needs: a filter on the source tree, so `tests/`
  // and `__pycache__` never enter the package in the first place.
  const copyDirectory = (prefix: string): void => {
    for (const entry of readdirSync(join(sourceRoot, prefix === '' ? '.' : prefix))) {
      const relativePath = prefix === '' ? entry : `${prefix}/${entry}`
      if (!isVendoredPath(relativePath)) continue
      const from = join(sourceRoot, ...relativePath.split('/'))
      const to = join(target, ...relativePath.split('/'))
      if (statSync(from).isDirectory()) {
        mkdirSync(to, { recursive: true })
        copyDirectory(relativePath)
      } else {
        cpSync(from, to)
      }
    }
  }
  copyDirectory('')

  const digest = treeDigest(target)
  return { source, files: digest.files, bytes: digest.bytes, digest: digest.digest }
}

/** Compare what is on disk with what provenance records. */
function check(): readonly string[] {
  const provenance = readProvenance()
  const problems: string[] = []
  for (const vendor of SKILL_VENDORS) {
    const record = provenance.vendors[vendor.name]
    if (record === undefined) {
      problems.push(`${vendor.name}: no provenance record`)
      continue
    }
    const actual = treeDigest(join(VENDOR_ROOT, vendor.name))
    if (actual.digest !== record.digest || actual.files !== record.files || actual.bytes !== record.bytes) {
      problems.push(
        `${vendor.name}: vendored tree drifted from provenance `
          + `(recorded ${record.files} files/${record.bytes} bytes/${record.digest.slice(0, 12)}, `
          + `found ${actual.files}/${actual.bytes}/${actual.digest.slice(0, 12)}). `
          + 'Re-run `node tools/vendor-skills.ts` if the change was intended.',
      )
    }
  }
  const expected = createHash('sha256')
    .update(provenanceText(provenance.vendors))
    .digest('hex')
  if (expected !== provenance.digest) {
    problems.push('PROVENANCE.json: the vendor records do not match the file\'s own digest')
  }
  return problems
}

const args = process.argv.slice(2)
if (args.includes('--check')) {
  const problems = check()
  for (const problem of problems) console.error(problem)
  console.log(problems.length === 0 ? 'vendor: provenance matches' : `vendor: ${problems.length} problem(s)`)
  process.exit(problems.length === 0 ? 0 : 1)
}

mkdirSync(VENDOR_ROOT, { recursive: true })
const vendors: Record<string, VendorRecord> = {}
for (const vendor of SKILL_VENDORS) {
  const record = freeze(vendor.name, vendor.source)
  vendors[vendor.name] = record
  console.log(
    `${vendor.name}: ${record.files} files, ${record.bytes} bytes, ${record.digest.slice(0, 12)} `
      + `(from ${toPosixPath(vendor.source)})`,
  )
}
writeFileSync(
  PROVENANCE_PATH,
  `${JSON.stringify(
    {
      covers: DIGEST_COVERS,
      vendors,
      digest: createHash('sha256').update(provenanceText(vendors)).digest('hex'),
    },
    null,
    2,
  )}\n`,
  'utf8',
)
console.log(`wrote ${toPosixPath(PROVENANCE_PATH)}`)
