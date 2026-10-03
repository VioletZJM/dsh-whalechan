/**
 * `canonicalJson`: the serialization every digest here is taken over, checked against
 * the Python that wrote the frozen artefacts.
 *
 * Two things can silently change a digest: key order, and how a number is spelled.
 * `JSON.stringify` differs from `json.dumps` on both — it keeps insertion order, and
 * it writes `4` where Python writes `4.0` — so the port cannot lean on it. The
 * differential below is what keeps the port honest; the JS-only cases state the two
 * places where JavaScript simply cannot see what Python saw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalJson } from '../src/run/plan.ts'
import { pythonFloatRepr, pythonJsonString } from '../src/domain/python-compat.ts'
import { oracleSkip, runPythonSnippet } from './support/oracle.ts'

const skip = oracleSkip()

/**
 * Values a plan digest is actually taken over: strings, integers, booleans, small
 * non-integral floats, and the nesting that carries them.
 *
 * Integral floats are deliberately absent. JavaScript has one number type, so `4.0`
 * and `4` are the same value by the time this module sees one — see the JS-only case
 * at the end, which pins that rather than pretending otherwise.
 */
const SAMPLES: readonly unknown[] = [
  'plain',
  'quote " backslash \\ newline \n tab \t',
  '中文与标点，破折号——',
  'emoji 🐳 and an astral pair',
  { b: 1, a: 2, c: [1, 2, 3] },
  { nested: { z: null, y: true, x: false }, list: [{ name: 'image-01', prompt: 'a whale-chan' }] },
  { ratio: 1.5, mean: 2.8, band: [3.105, 3.405] },
  [],
  {},
  [{}, []],
]

/** Python's own canonical form, for the same parsed value. */
function oracleCanonical(value: unknown): string {
  const outcome = runPythonSnippet(
    'import json, sys\nprint(json.dumps(json.loads(sys.stdin.read()), sort_keys=True, ensure_ascii=True, separators=(",", ":")))',
    [],
    JSON.stringify(value),
  )
  assert.equal(outcome.ok, true, `the oracle failed: ${outcome.ok ? '' : outcome.error}`)
  // Python on Windows writes CRLF, so the trailing line ending is two characters.
  return outcome.stdout.replace(/\r?\n$/, '')
}

test('canonicalJson: agrees with Python’s json.dumps on every shape a digest carries', { skip }, async t => {
  for (const [index, sample] of SAMPLES.entries()) {
    await t.test(`sample ${index}`, () => {
      assert.equal(canonicalJson(sample), oracleCanonical(sample))
    })
  }
})

test('canonicalJson: key order is sorted, not insertion order', () => {
  // The failure this prevents is quiet: two runs building the same facts in a
  // different order would produce two digests for one plan.
  assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
})

test('canonicalJson: non-ASCII is escaped, because json.dumps defaults to ensure_ascii', () => {
  // `JSON.stringify` would leave 中文 as-is; Python escapes it, and a digest taken
  // over the two would differ for the same plan.
  assert.equal(canonicalJson('中文'), '"\\u4e2d\\u6587"')
  assert.equal(canonicalJson('🐳'), '"\\ud83d\\udc33"', 'an astral code point becomes a surrogate pair')
  assert.equal(canonicalJson('a"b'), '"a\\"b"')
})

test('canonicalJson: an integral JavaScript number is an integer, and that is a real limit', () => {
  // Python keeps 4 and 4.0 apart; JavaScript does not. So this module cannot render
  // `4.0` for a value that arrived as a JS number — and `pythonFloatRepr` exists for
  // the callers that know they hold a float. The plan digest carries only strings and
  // integers, so the ambiguity never reaches it; this states that rather than leaving
  // a reader to discover it.
  assert.equal(canonicalJson(4), '4')
  assert.equal(canonicalJson(4.0), '4')
  assert.equal(pythonFloatRepr(4), '4.0', 'the float spelling is available when the caller knows')
  assert.equal(pythonJsonString('中文'), '"\\u4e2d\\u6587"')
})

test('canonicalJson: a value it cannot render is refused, not guessed', () => {
  // `pythonFloatRepr` refuses a non-finite number rather than emitting a digest it
  // cannot vouch for; that refusal has to surface as an error, not as `null`.
  assert.throws(() => canonicalJson(Number.NaN), /non-finite/)
  assert.throws(() => canonicalJson(() => {}), /cannot canonicalize/)
  assert.equal(canonicalJson(null), 'null')
  assert.equal(canonicalJson(undefined), 'null', 'an absent key and an explicit null hash the same, as in JSON')
})
