/**
 * Dead-export audit: find symbols the plugin exports but never uses in production.
 *
 * This exists because of a real defect (§56.2): `preflightCandidate` was written,
 * documented with the promise "no candidate is paid for that the oracle would refuse
 * to record", exported from the index — and called from nowhere but its own test. The
 * budget gate that sentence describes was therefore not on the money path, and the
 * suite could not see it because the suite called the function directly.
 *
 * So the report is sorted by the thing that actually matters:
 *
 * | column | meaning |
 * | --- | --- |
 * | `src` | non-import references in `src/` outside the defining module |
 * | `own` | references inside the defining module |
 * | `test` | references under `test/` |
 *
 * **`src == 0 && test > 0` is the `preflightCandidate` shape**: a function with a
 * promise, exercised only by tests, wired into nothing. `src == 0 && test == 0` is
 * ordinary exported surface — a type, a constant, a tool name — and is not a finding.
 *
 * Usage: node tools/dead-exports.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')
const INDEX = join(SRC, 'index.ts')

/** Every `.ts` file under a directory. */
function sourceFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * Remove comments, then declarations.
 *
 * Comments first, and by scanning rather than by regex, because this audit was
 * defeated by exactly that: `budget.ts` documents `preflightCandidate` with
 * `{@link preflightCandidate}`, so a doc reference counted as a use and the symbol
 * never appeared as unplugged. The negative test caught it; eyeballing the output
 * would not have.
 *
 * String and template literals are tracked so a `//` inside one is not mistaken for
 * a comment. Regex literals are not tracked — none of the identifiers this audit
 * looks for appear inside one.
 */
function stripComments(text) {
  let out = ''
  let index = 0
  let quote = null
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (quote !== null) {
      out += char
      if (char === '\\') { out += next ?? ''; index += 2; continue }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; out += char; index += 1; continue }
    if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      out += ' '
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Remove the parts of a file that are declarations rather than uses.
 *
 * This has to work on the whole file, not line by line: an `export {` block is
 * routinely multi-line, and its continuation lines are bare names that look exactly
 * like uses. An earlier version tested per line and therefore counted every name in
 * `src/index.ts`'s export list as used — which is precisely the reading that would
 * hide an unplugged function.
 */
function stripDeclarations(text) {
  return stripComments(text)
    .replace(/^\s*import[\s\S]*?from\s*'[^']*'\s*;?\s*$/gm, '')
    .replace(/^\s*import\s*'[^']*'\s*;?\s*$/gm, '')
    .replace(/^\s*export\s*\{[\s\S]*?\}\s*from\s*'[^']*'\s*;?\s*$/gm, '')
    .replace(/^\s*export\s*\*[\s\S]*?from\s*'[^']*'\s*;?\s*$/gm, '')
}

/** Every name re-exported from `src/index.ts`, with the module it came from. */
function exportedNames() {
  const text = readFileSync(INDEX, 'utf8')
  const names = new Map()
  const block = /export\s*\{([^}]*)\}\s*from\s*'([^']+)'/g
  for (const match of text.matchAll(block)) {
    const from = match[2]
    for (const raw of match[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim()
      if (name !== '') names.set(name, from)
    }
  }
  for (const match of text.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/gm)) {
    names.set(match[1], './index.ts')
  }
  return names
}

const srcFiles = sourceFiles(SRC)
const testFiles = sourceFiles(TEST)
const read = files => new Map(files.map(file => [file, stripDeclarations(readFileSync(file, 'utf8'))]))
const srcText = read(srcFiles)
const testText = read(testFiles)

const names = exportedNames()
/**
 * Is this line a declaration-of-exports rather than a use?
 *
 * Only imports and *pure* re-export forms are excluded. `export const A = f(B)` is a
 * use of `B` and must count — an earlier version skipped every `export ` line and
 * therefore reported `REPO_ROOT` as unused, when its only consumer happened to sit on
 * the right-hand side of an `export const`.
 */
function isNotAUse(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('import ')
    || /^export\s*\{/.test(trimmed)
    || /^export\s*\*/.test(trimmed)
}

/** Count non-import/export references to a name across a set of files. */
function countUses(name, files, texts, skip) {
  const word = new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`)
  // The declaration itself is not a use. Without this a function nothing calls still
  // reports `own = 1`, which is exactly the reading that would hide the defect this
  // audit exists to find.
  const declaration = new RegExp(
    `^\\s*export\\s+(?:async\\s+)?(?:function|const|class|interface|type|enum)\\s+${name.replace(/[$]/g, '\\$')}\\b`,
  )
  /**
   * A file that declares its **own** binding of this name is not a user of the
   * exported one.
   *
   * Without this, a homonym in another module silently plugs the audit shut. It was
   * found the hard way: a batch of exports each looked "used in src/" only because a
   * module they had nothing to do with declared private helpers of the same names.
   * Two independent implementations that look alike are exactly the case where the
   * likeness gets read as a wire.
   *
   * Line-anchored, so a parameter or a local of the same name is still counted;
   * that direction is safe, because it can only make the tool report *more*.
   */
  const shadowed = new RegExp(
    `^\\s*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:function|const|let|var|class|interface|type|enum)\\s+${name.replace(/[$]/g, '\\$')}\\b`,
    'm',
  )
  let own = 0
  let external = 0
  const where = new Set()
  for (const file of files) {
    if (skip.has(file)) continue
    if (file !== skip.defining && shadowed.test(texts.get(file))) continue
    for (const line of texts.get(file).split('\n')) {
      if (!word.test(line) || isNotAUse(line) || declaration.test(line)) continue
      if (file === skip.defining) own += 1
      else { external += 1; where.add(relative(ROOT, file)) }
    }
  }
  return { own, external, where: [...where] }
}

/**
 * The audit's own failure modes, pinned on synthetic files.
 *
 * This runs on every invocation, so `pnpm run check:exports` fails if the
 * classifier regresses — including the two defects that a *synthetic* case caught
 * and reading the output did not: a JSDoc `{@link name}` counting as a use, and a
 * homonym in another module counting as a wire. A hand-run negative test found
 * both; these make them permanent.
 */
function selfCheck() {
  const cases = [
    {
      why: 'a private helper of the same name elsewhere is not a user',
      files: ['/r/homonym.ts', '/r/real.ts'],
      texts: {
        '/r/homonym.ts': 'function target() {}\nconst a = target()',
        '/r/real.ts': 'const b = target()',
      },
      external: 1,
    },
    {
      why: 'a doc reference is not a use, and the declaration is not either',
      files: ['/r/real.ts'],
      texts: { '/r/real.ts': '/**\n * {@link target} — documented, never called\n */' },
      external: 0,
    },
    {
      why: 'a bare name inside a re-export list is not a use',
      files: ['/r/real.ts'],
      texts: { '/r/real.ts': "export {\n  target,\n} from './x.ts'" },
      external: 0,
    },
    {
      why: "the defining module's own references are its own",
      files: ['/r/def.ts'],
      texts: { '/r/def.ts': 'export function target() {}\nconst c = target()' },
      external: 0,
      own: 1,
    },
  ]
  for (const probe of cases) {
    const map = new Map(probe.files.map(file => [file, stripDeclarations(probe.texts[file])]))
    const skip = new Set()
    skip.defining = '/r/def.ts'
    const result = countUses('target', probe.files, map, skip)
    if (result.external !== probe.external || (probe.own ?? 0) !== result.own) {
      throw new Error(
        `dead-exports self-check failed: ${probe.why} — expected external=${probe.external} `
        + `own=${probe.own ?? 0}, got external=${result.external} own=${result.own}`,
      )
    }
  }
}

selfCheck()

const report = []
for (const [name, from] of names) {
  const defining = from === './index.ts' ? INDEX : resolve(SRC, from.replace(/^\.\//, ''))
  // `index.ts` is a **user**, not a place to ignore: its `apply()` is what actually
  // registers the tools. Skipping it made every `registerXTool` look unplugged.
  const skip = new Set()
  skip.defining = defining
  const inSrc = countUses(name, srcFiles, srcText, skip)
  const inTest = countUses(name, testFiles, testText, new Set())
  report.push({ name, from: relative(ROOT, defining), ...inSrc, test: inTest.external + inTest.own })
}

/**
 * Every unplugged symbol, with the reason it is allowed to be unplugged.
 *
 * The point of requiring a reason is that a *new* unplugged symbol has none, so
 * `--check` fails on it. That is the whole value: the defect this audit was written
 * for (§56.2, a budget gate that was documented, exported and never called) cannot
 * come back silently.
 *
 * A reason must be one of:
 *   `pending:` a named half of the work that will wire it (with the section);
 *   `tooling:` consumed by something under `tools/`, which this audit does not scan;
 *   `api:`     deliberate exported surface, with what makes it deliberate.
 *
 * **Reasons are removed when the symbol is wired, not kept.** Explanations for
 * something that is already on a path are stale claims, and this list is read as the
 * worklist of what is missing.
 */
const EXPLAINED = new Map([
  // Consumed from tools/, which is outside the scanned tree.
  ['SKILL_VENDORS', 'tooling: tools/vendor-skills.ts builds the vendored tree from this list'],
  ['provenanceText', 'tooling: tools/vendor-skills.ts computes the provenance file\'s own digest'],
  ['readProvenance', 'tooling: tools/vendor-skills.ts writes and re-reads PROVENANCE.json'],
  ['treeDigest', 'tooling: tools/vendor-skills.ts digests a vendored tree'],
  // Deliberate exported surface. Both halves of each pair are the *assignment*
  // spellings: v0.3 composes `{mode:'canonical'}` and lets the compiler supply the
  // prompt text, so the runtime reads none of them — but anything that builds an
  // assignment by hand, including the differential fixture, must state them exactly.
  ['DEFAULT_STYLE', 'api: the canonical style string an assignment states, used by the differential fixture'],
  ['DEFAULT_COSTUME', 'api: the canonical costume string an assignment states, used by the differential fixture'],
  ['requireSchemaVersion', 'api: the compiler\'s own schema check, kept for callers that build an assignment'],
  ['resolveModel', 'api: the alias-only convenience over resolveModelChoice, kept for library consumers'],
  // `resolveGeometry` stood here as a "redundant mirror" until v0.3: the frozen
  // adapter owned the ratio decision, so nothing in src/ needed a second copy. Once
  // the adapter was gone, `whalechan_image` became its caller and the verdict expired —
  // which is exactly why this audit reports a stale entry instead of keeping the note.
])

const unplugged = report.filter(entry => entry.external === 0 && entry.own === 0 && entry.test > 0)
const unexplained = unplugged.filter(entry => !EXPLAINED.has(entry.name))
const wiredButLocal = report.filter(entry => entry.external === 0 && entry.own > 0)
const unused = report.filter(entry => entry.external === 0 && entry.own === 0 && entry.test === 0)

/**
 * Explanations that have outlived what they explain.
 *
 * Two shapes, and they are not equally bad:
 *
 * - **Unknown**: the map names a symbol this audit does not see at all — a typo, or
 *   an export that was renamed. That is a hard error: the entry explains nothing.
 * - **Stale**: the symbol is exported and now has a production caller, so the entry's
 *   claim ("nothing in src/ reaches this") is no longer true. Advisory, because an
 *   `api:` reason can survive its symbol becoming used, but *visible*, because this
 *   list is read as the worklist of what is missing. A batch of entries went stale
 *   the moment a new module called their symbols; they were found by hand, and would
 *   not have been again.
 */
const unknownExplanations = [...EXPLAINED.keys()].filter(name => !report.some(entry => entry.name === name))
const staleExplanations = [...EXPLAINED.keys()].filter(
  name => report.some(entry => entry.name === name) && !unplugged.some(entry => entry.name === name),
)

if (process.argv.includes('--check')) {
  if (unknownExplanations.length > 0) {
    process.stderr.write(`dead exports: ${unknownExplanations.length} explanation(s) name no exported symbol\n`)
    for (const name of unknownExplanations) process.stderr.write(`  ${name} — typo, or renamed away.\n`)
    process.exit(1)
  }
  if (unexplained.length === 0) {
    process.stdout.write(`dead exports: ${unplugged.length} unplugged, all explained; nothing unexplained\n`)
    if (staleExplanations.length > 0) {
      process.stdout.write(`  ${staleExplanations.length} stale explanation(s), now wired: ${staleExplanations.join(', ')}\n`)
    }
    process.exit(0)
  }
  process.stderr.write(`dead exports: ${unexplained.length} unexplained unplugged symbol(s)\n`)
  for (const entry of unexplained) {
    process.stderr.write(
      `  ${entry.name} (${entry.from}) — nothing in src/ calls it; only ${entry.test} test reference(s).\n`
      + '    Either wire it to the path its documentation promises, or add a reason to EXPLAINED.\n',
    )
  }
  process.exit(1)
}

process.stdout.write(
  `audited ${report.length} exported names across ${srcFiles.length} src files and ${testFiles.length} test files\n\n`,
)
process.stdout.write(
  `UNPLUGGED — nothing in src/ calls them; only tests do (${unplugged.length}, `
  + `${unexplained.length} unexplained):\n`,
)
if (unplugged.length === 0) process.stdout.write('  (none)\n')
for (const entry of unplugged) {
  const reason = EXPLAINED.get(entry.name) ?? '*** UNEXPLAINED ***'
  process.stdout.write(`  ${entry.name.padEnd(22)} ${reason}\n`)
}
process.stdout.write(
  `\nLOCAL ONLY — called inside their own module, never imported elsewhere (${wiredButLocal.length}):\n`
  + '  Ordinary for the internals of one tool; listed only so the distinction is visible.\n',
)
for (const entry of wiredButLocal) {
  process.stdout.write(`  ${entry.name.padEnd(34)} ${entry.from.padEnd(32)} own=${entry.own}\n`)
}
process.stdout.write(
  `\nNEVER REFERENCED AT ALL — types, constants, tool names (${unused.length}):\n`
  + `  ${unused.map(entry => entry.name).join(', ')}\n`,
)
process.stdout.write(
  `\nSTALE EXPLANATIONS — explained but no longer unplugged (${staleExplanations.length}):\n`
  + '  The reason claims nothing in src/ reaches the symbol; something now does. Remove the entry.\n'
  + `  ${staleExplanations.join(', ')}\n`,
)
if (unknownExplanations.length > 0) {
  process.stdout.write(
    `\nEXPLANATIONS FOR NOTHING — names in the map that this audit does not see `
    + `(${unknownExplanations.length}):\n  ${unknownExplanations.join(', ')}\n`,
  )
}

