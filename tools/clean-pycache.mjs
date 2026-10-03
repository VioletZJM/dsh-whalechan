#!/usr/bin/env node
/**
 * Delete `__pycache__` trees from the package before it is packed.
 *
 * Running the vendored Python engine — which the test suite and `verify-bundle`
 * both do — leaves `__pycache__` behind inside `vendor/`. `files: ["vendor"]`
 * ships the whole directory, so the first `pnpm pack` after a test run put five
 * `.pyc` files into the tarball. They are harmless at runtime (the provenance
 * digest excludes them, and Python ignores stale bytecode) and they are still not
 * something this package should hand to anyone.
 *
 * Wired to `prepack`, so it runs exactly when the tree is about to be shipped —
 * which is the only moment the answer matters. `node_modules` is skipped: other
 * packages' bytecode is not this package's business.
 */
import { readdirSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const SKIP = new Set(['node_modules', '.git'])
const removed = []

/** Remove every `__pycache__` directory under `directory`, depth-first. */
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(directory, entry.name)
    if (entry.name === '__pycache__') {
      rmSync(full, { recursive: true, force: true })
      removed.push(relative(ROOT, full))
      continue
    }
    if (SKIP.has(entry.name)) continue
    walk(full)
  }
}

walk(ROOT)
process.stdout.write(
  removed.length === 0
    ? 'clean-pycache: nothing to remove\n'
    : `clean-pycache: removed ${removed.length} directory(ies): ${removed.join(', ')}\n`,
)
