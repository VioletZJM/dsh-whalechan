/**
 * Composition: from four things a caller knows to a prompt the compiler accepts.
 *
 * The interesting assertion is the last one — that what this module builds is
 * something `compilePrompt` actually renders, with the caller's own sentence inside
 * it. Everything above it is the table lookup that used to be the *model's* job
 * (§68 of the charter: seven of sixteen minutes went to authoring the document this
 * module now assembles in microseconds).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BACKGROUND,
  composeImages,
  loadCatalog,
  resolveForm,
  type Catalog,
} from '../src/domain/compose.ts'
import { WhalechanError } from '../src/domain/errors.ts'
import { compilePrompt, requireSchemaVersion, HARD_MAX_CHARS } from '../src/domain/prompt/character.ts'
import { CHARACTER_SKILL_ROOT } from '../src/run/vendor.ts'

const CATALOG = loadCatalog(CHARACTER_SKILL_ROOT)

test('compose: the vendored catalogue and the compiler agree on the form table', () => {
  // A catalogue form the compiler has no head count for fails *in the compiler*, far
  // from the catalogue that introduced it. `loadCatalog` is where that is caught.
  assert.deepEqual(
    Object.keys(CATALOG.forms).sort(),
    ['chibi', 'compact', 'semi-chibi', 'standard', 'super-deformed'],
  )
  assert.equal(CATALOG.default_form, 'semi-chibi')
})

test('compose: a form the compiler does not know is refused where it is read', () => {
  const root = mkdtempSync(join(tmpdir(), 'whalechan-compose-'))
  mkdirSync(join(root, 'references'), { recursive: true })
  const path = join(root, 'references', 'reference-catalog.json')
  const doctored = JSON.parse(readFileSync(join(CHARACTER_SKILL_ROOT, 'references', 'reference-catalog.json'), 'utf8')) as Catalog
  writeFileSync(path, JSON.stringify({
    ...doctored,
    forms: { ...doctored.forms, 'tall-and-thin': { primary: 'x.webp', mean_head_ratio: 9, acceptance_range: [8, 10], references: [] } },
  }), 'utf8')
  assert.throws(() => loadCatalog(root), /no head count for it/)
})

test('compose: a missing or formless catalogue is refused, not half-read', () => {
  const root = mkdtempSync(join(tmpdir(), 'whalechan-compose-missing-'))
  assert.throws(() => loadCatalog(root), /cannot read the reference catalogue/)
  mkdirSync(join(root, 'references'), { recursive: true })
  writeFileSync(join(root, 'references', 'reference-catalog.json'), '{"schema_version":4,"default_form":"x","forms":{}}', 'utf8')
  assert.throws(() => loadCatalog(root), /describes no forms/)
})

test('compose: a named form states its own counted ratio', () => {
  const choice = resolveForm(CATALOG, 'compact')
  assert.equal(choice.anchor, 'compact')
  assert.deepEqual(choice.proportion, { mode: 'preset', preset: 'compact' })
  assert.match(choice.because, /compact/)
})

test('compose: a head count is taken literally, and only the anchor is snapped', () => {
  // The caller said three heads; the prompt must say three heads. Snapping the
  // *stated* ratio to the nearest preset would silently answer a different question.
  const choice = resolveForm(CATALOG, '3头身')
  assert.deepEqual(choice.proportion, { mode: 'custom', target_head_ratio: 3 })
  assert.equal(choice.anchor, 'semi-chibi', 'nearest mean to 3.0 is 2.8, not 3.3')
  assert.match(choice.because, /taken literally/)
})

test('compose: a tie between two forms resolves the same way every time', () => {
  // 3.05 is exactly between compact (3.3) and semi-chibi (2.8). Ties go to the
  // shorter figure, which is a declared rule rather than "whatever the sort did".
  assert.equal(resolveForm(CATALOG, '3.05').anchor, 'semi-chibi')
  assert.equal(resolveForm(CATALOG, '3.05').anchor, resolveForm(CATALOG, '3.05').anchor)
})

test('compose: an unrecognised form names what it would have accepted', () => {
  assert.throws(
    () => resolveForm(CATALOG, 'tallish'),
    (error: unknown) => error instanceof WhalechanError
      && error.category === 'capability'
      && /neither a catalogue form nor a head count/.test(error.message)
      && /standard, compact, semi-chibi, chibi, super-deformed/.test(error.message),
  )
})

test('compose: count and prompt are checked before anything is built', () => {
  assert.throws(() => composeImages({ prompt: 'x' }, CATALOG, 0, CHARACTER_SKILL_ROOT), /count must be a positive integer/)
  assert.throws(() => composeImages({ prompt: '   ' }, CATALOG, 1, CHARACTER_SKILL_ROOT), /non-empty description/)
})

test('compose: the built object compiles, and carries the caller sentence verbatim', () => {
  const composed = composeImages(
    { prompt: 'sitting on the floor eating a bowl of white rice, smiling.  ' },
    CATALOG,
    2,
    CHARACTER_SKILL_ROOT,
  )
  assert.deepEqual(composed.names, ['image-01', 'image-02'])
  assert.equal(composed.assignment.images.length, 2)

  // The scene line the compiler renders; trailing punctuation is stripped because
  // the compiler appends its own full stop.
  const compiled = compilePrompt(composed.assignment as unknown as Record<string, unknown>, 'image-01', 800)
  assert.doesNotThrow(() => requireSchemaVersion(composed.assignment as unknown as Record<string, unknown>))
  assert.match(compiled.prompt, /sitting on the floor eating a bowl of white rice, smiling/)
  assert.doesNotMatch(compiled.prompt, /smiling\./)
  assert.match(compiled.prompt, /^Anime girl, ageless humanoid whale mascot:/, 'the identity block leads the prompt')
  assert.ok(compiled.prompt.includes(DEFAULT_BACKGROUND), 'the canonical background is rendered')
  assert.ok(compiled.blocks.some(block => block.name === 'scene'))
  assert.ok(compiled.prompt.length < 800, `the default scene must fit the compiler budget (${compiled.prompt.length})`)
})

test('compose: a scene too long to compile is refused by the compiler, with its own words', () => {
  const composed = composeImages({ prompt: 'rice '.repeat(400) }, CATALOG, 1, CHARACTER_SKILL_ROOT)
  assert.throws(
    () => compilePrompt(composed.assignment as unknown as Record<string, unknown>, 'image-01', 800),
    /over the 800-character budget/,
  )
})

/** Compile one request and hand back the prompt, failing loudly if it cannot. */
function compiledFor(form?: string): string {
  const composed = composeImages(
    { prompt: 'sitting on the floor eating a bowl of white rice, smiling', ...(form === undefined ? {} : { form }) },
    CATALOG,
    1,
    CHARACTER_SKILL_ROOT,
  )
  return compilePrompt(composed.assignment as unknown as Record<string, unknown>, 'image-01', HARD_MAX_CHARS).prompt
}

test('compose: EVERY form and both proportion modes compile, not just the default', () => {
  // This is the test whose absence cost a real request. Every check that existed —
  // the suite, the bundle gate, the install probe, my own dry runs — went through the
  // **default preset**, so the `custom` branch never reached the compiler, shipped with
  // `target` instead of `target_head_ratio`, and the first real call (`form: "3头身"`)
  // died with the compiler's own refusal: "custom proportion needs a
  // target_head_ratio greater than 1.0".
  //
  // The lesson is not "add a test", it is "enumerate the input space, not the happy
  // path": one line per catalogue form plus both custom shapes would have caught it.
  for (const name of Object.keys(CATALOG.forms)) {
    assert.match(compiledFor(name), /Proportion: [\d.]+ heads tall total/, `form ${name} did not compile`)
  }
  assert.match(compiledFor('3头身'), /Proportion: 3 heads tall total/, 'a head count must be stated literally')
  assert.match(compiledFor('2.5'), /Proportion: 2\.5 heads tall total/)
})

test('compose: a head count states the caller’s number, a form name states the catalogue’s', () => {
  // The two modes differ in wording on purpose, and the difference is what the whole
  // "take the number literally" rule buys: `3头身` says three, `compact` says 3.3.
  assert.match(compiledFor('3头身'), /head ~33% tall\); keep apparent age unchanged/)
  assert.match(compiledFor('compact'), /Proportion: 3\.3 heads tall total/)
})
