/**
 * Vendored engine trees: what ships with the plugin, and proof of where it came from.
 *
 * The charter freezes the patched skill trees into the package rather than
 * reading them from `~/.dsh/skills`, because a discovery location is not a
 * dependency: the tree can be moved, edited, or removed without the plugin
 * noticing until a run fails.
 *
 * Freezing a copy creates its own hazard, though — the copy can silently drift
 * from the original. So every vendor tree carries a **digest over its exact file
 * set and contents**, recorded in `vendor/PROVENANCE.json`, and the test suite
 * recomputes it. Editing a vendored file by hand, or re-vendoring from a
 * different source, cannot pass unnoticed.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The marker that identifies the package root, and only the package root. */
const PACKAGE_MARKER = join('vendor', 'PROVENANCE.json')

/**
 * Find the package root by walking up from this module.
 *
 * A fixed `../..` is correct for the **source** layout (`src/run/vendor.ts`) and
 * wrong for the **bundled** one (`lib/index.js`, one directory shallower) — and
 * the bundled one is what the host loads. That mistake is invisible until a real
 * host calls a tool: the live plan probe passed only because it imported `src/`
 * directly, while the packaged build resolved the engine to a sibling directory
 * that does not exist.
 *
 * So the root is *found*, not computed: the first ancestor holding the engine is
 * the package, in either layout.
 * @param from - the directory to start walking up from.
 * @returns the package root.
 * @throws when no ancestor holds the vendored engine, because a plugin without it
 *   cannot serve any of its tools and should say so rather than mount quietly.
 */
export function findPackageRoot(from: string): string {
  let current = resolve(from)
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, PACKAGE_MARKER))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error(
    `dsh-whalechan could not find its own package root: no ancestor of ${resolve(from)} contains `
      + `${PACKAGE_MARKER}. The vendored engine is part of the package, so this build is incomplete.`,
  )
}

/** Repository root, found rather than assumed. */
export const REPO_ROOT = findPackageRoot(fileURLToPath(new URL('.', import.meta.url)))

/** Where frozen engine trees live inside the package. */
export const VENDOR_ROOT = join(REPO_ROOT, 'vendor')

/** A vendored skill: its package-relative directory name and its upstream source. */
export interface SkillVendor {
  /** Directory name under `vendor/`, also the skill's own name. */
  readonly name: string
  /** Upstream location, relative to the repository root. */
  readonly source: string
}

/** Directory name of the vendored skill, both under `vendor/` and upstream. */
export const CHARACTER_SKILL_NAME = 'whalechan-image-character'

/**
 * The engine tree, and where it is frozen from.
 *
 * The source is kept **relative** so the provenance file stays meaningful on
 * another checkout instead of recording one machine's absolute path.
 */
export const SKILL_VENDORS: readonly SkillVendor[] = [
  { name: CHARACTER_SKILL_NAME, source: `../dsh-whalechan/.dsh/skills/${CHARACTER_SKILL_NAME}` },
]

/** Absolute path of the vendored engine every tool runs. */
export const CHARACTER_SKILL_ROOT = join(VENDOR_ROOT, CHARACTER_SKILL_NAME)

/**
 * The runtime subset: **the catalogue and the reference images, nothing else**.
 *
 * This used to ship the whole skill tree — the Python engine under `scripts/`, the
 * specification Markdown under `references/`, and `SKILL.md`. v0.3 needs none of it:
 * the prompt compiler and the assignment shape are ours (upstream has no character-side
 * compiler to port), the images go out over HTTP, and the only file read at runtime is
 * `reference-catalog.json`.
 *
 * Shrinking it is not only tidiness. The prose files are CC-BY-NC-SA 4.0 and the
 * reference images carry third-party rights, so every file dropped here is a file
 * that no longer has to be licensed for redistribution (§66.7).
 */
export const VENDOR_FILES = ['references/reference-catalog.json'] as const

/** Directories whose whole contents are part of the runtime subset. */
export const VENDOR_DIRECTORIES = ['assets'] as const

/** Is this path part of the vendored runtime? */
export function isVendoredPath(relativePosix: string): boolean {
  const segments = relativePosix.split('/')
  if (segments.some(segment => segment === '__pycache__')) return false
  if (relativePosix.endsWith('.pyc')) return false
  if ((VENDOR_FILES as readonly string[]).includes(relativePosix)) return true
  const [head] = segments
  if (head === undefined) return false
  if ((VENDOR_DIRECTORIES as readonly string[]).includes(head)) return true
  // A **directory that holds** an allowed file has to be descended into, or the
  // allow-list entry above is unreachable: the copy walks `references` long before it
  // walks `references/reference-catalog.json`. Measured — the first freeze of this
  // rule shipped fifteen images and no catalogue at all.
  return (VENDOR_FILES as readonly string[]).some(file => file.startsWith(`${relativePosix}/`))
}

/** One file's contribution to the tree digest. */
interface TreeEntry {
  readonly path: string
  readonly bytes: number
  readonly digest: string
}

/** A tree's identity: how many files, how many bytes, and one digest over both. */
export interface TreeDigest {
  readonly files: number
  readonly bytes: number
  readonly digest: string
}

/** List every file under `root` as a posix-relative path. */
function listFiles(root: string, prefix = ''): string[] {
  let entries: string[]
  try {
    entries = readdirSync(join(root, prefix))
  } catch {
    return []
  }
  const found: string[] = []
  for (const entry of entries) {
    const relativePath = prefix === '' ? entry : `${prefix}/${entry}`
    if (statSync(join(root, relativePath)).isDirectory()) found.push(...listFiles(root, relativePath))
    else found.push(relativePath)
  }
  return found
}

/**
 * Compute a tree's digest over its file set and contents.
 *
 * The digest covers `path\0content-digest` per file, in sorted path order, so it
 * changes when a file is added, removed, renamed, or edited — and it does **not**
 * depend on directory iteration order or on file timestamps.
 * @param root - absolute path of the tree.
 * @param filter - which relative paths count; defaults to {@link isVendoredPath}.
 * @returns the file count, byte count, and digest.
 */
export function treeDigest(root: string, filter: (path: string) => boolean = isVendoredPath): TreeDigest {
  const paths = listFiles(root).filter(filter).sort()
  const accumulator = createHash('sha256')
  let bytes = 0
  for (const path of paths) {
    const content = readFileSync(join(root, ...path.split('/')))
    bytes += content.byteLength
    accumulator.update(`${path}\0`)
    accumulator.update(createHash('sha256').update(content).digest('hex'))
    accumulator.update('\n')
  }
  return { files: paths.length, bytes, digest: accumulator.digest('hex') }
}

/** One vendored tree's recorded provenance. */
export interface VendorRecord {
  readonly source: string
  readonly files: number
  readonly bytes: number
  readonly digest: string
}

/** The provenance file's shape. */
export interface VendorProvenance {
  /** What the digest covers, so a reader can reproduce it. */
  readonly covers: string
  readonly vendors: Readonly<Record<string, VendorRecord>>
  /** One digest over every vendor record, so the file itself is tamper-evident. */
  readonly digest: string
}

/** The path of the provenance file. */
export const PROVENANCE_PATH = join(VENDOR_ROOT, 'PROVENANCE.json')

/** Canonical text of the vendor records, the input to the provenance digest. */
export function provenanceText(vendors: Readonly<Record<string, VendorRecord>>): string {
  return Object.keys(vendors).sort()
    .map(name => {
      const record = vendors[name]!
      return `${name}\0${record.source}\0${record.files}\0${record.bytes}\0${record.digest}\n`
    })
    .join('')
}

/** Read the recorded provenance. */
export function readProvenance(path: string = PROVENANCE_PATH): VendorProvenance {
  return JSON.parse(readFileSync(path, 'utf8')) as VendorProvenance
}

/** What the digest covers, recorded verbatim so the rule is not folklore. */
export const DIGEST_COVERS =
  'per vendored skill: every file under assets/, plus references/reference-catalog.json, '
  + 'excluding __pycache__ and *.pyc; for each file in sorted posix-path order, '
  + '"<path>\\0<sha256 of contents>\\n" is fed to sha256'

/** Platform-independent form of a path, for messages and relative reporting. */
export function toPosixPath(absolute: string): string {
  return absolute.split(sep).join('/')
}
