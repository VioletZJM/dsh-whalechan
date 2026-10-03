/**
 * Finding the package root, in both layouts that actually ship.
 *
 * The bug this pins is the kind that passes every test and fails on first use: a
 * fixed `../..` from `import.meta.url` is correct in `src/run/` and **one level
 * too high** in the bundled `lib/index.js` — which is exactly what the host loads.
 * The live plan probe passed because it imported `src/` directly; the packaged
 * build resolved `vendor/` to a sibling of the package that does not exist.
 *
 * So both layouts are built here as real directories and asserted to resolve to
 * the same root.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPO_ROOT, VENDOR_ROOT, findPackageRoot } from '../src/run/vendor.ts'
import { VERSION } from '../src/version.ts'

/** Build a package skeleton and return its root. */
function makePackage(name: string, moduleDir: string): { root: string; from: string } {
  const root = join(mkdtempSync(join(tmpdir(), 'whalechan-root-')), name)
  mkdirSync(join(root, 'vendor'), { recursive: true })
  writeFileSync(join(root, 'vendor', 'PROVENANCE.json'), '{}', 'utf8')
  const from = join(root, ...moduleDir.split('/'))
  mkdirSync(from, { recursive: true })
  return { root: realpathSync(root), from }
}

test('findPackageRoot: the source layout resolves two levels up', () => {
  const { root, from } = makePackage('pkg-src', 'src/run')
  assert.equal(findPackageRoot(from), root)
})

test('findPackageRoot: the bundled layout resolves one level up', () => {
  // The regression: `../..` from `lib/` lands outside the package entirely.
  const { root, from } = makePackage('pkg-lib', 'lib')
  assert.equal(findPackageRoot(from), root)
})

test('findPackageRoot: both layouts agree, which is the whole point', () => {
  const pkg = makePackage('pkg-both', 'src/run')
  mkdirSync(join(pkg.root, 'lib'), { recursive: true })
  assert.equal(findPackageRoot(join(pkg.root, 'lib')), findPackageRoot(join(pkg.root, 'src', 'run')))
})

test('findPackageRoot: a missing engine is refused, not guessed at', () => {
  // A plugin whose engine is absent cannot serve a single tool; pointing at the
  // wrong directory would turn that into a confusing not-found much later.
  const root = mkdtempSync(join(tmpdir(), 'whalechan-empty-'))
  const nested = join(root, 'a', 'b', 'c')
  mkdirSync(nested, { recursive: true })
  assert.throws(
    () => findPackageRoot(nested),
    /could not find its own package root[\s\S]*vendor[\\/]PROVENANCE\.json/,
  )
})

test('findPackageRoot: this checkout resolves to a real engine, from the built entry too', () => {
  // The package under test must pass its own check, and `lib/` must agree with
  // `src/`: that is the assertion the live host would have failed.
  assert.equal(findPackageRoot(join(REPO_ROOT, 'lib')), REPO_ROOT)
  assert.equal(VENDOR_ROOT, join(REPO_ROOT, 'vendor'))
})

test('the reported version is the package version, not a second copy of it', () => {
  // An installer resolves `package.json`; the host reports `src/version.ts` through
  // the status route. Two literals with no guard name two different builds the first
  // time one of them is bumped, and the status route is exactly what a reader trusts
  // when asking "which build is loaded".
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
  assert.equal(VERSION, manifest.version)
})
