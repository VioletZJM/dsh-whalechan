import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  COSTUME_CANONICAL,
  DEFAULT_MAX_CHARS,
  IDENTITY,
  NO_TEXT,
  PRESET_HEADS,
  PromptError,
  STYLE_CANONICAL,
  compilePrompt,
  formatGeneral,
  pythonRound,
  requireSchemaVersion,
} from '../src/domain/prompt/character.ts'

/** The shared fixture; the same bytes the Python implementation this was ported from was diffed against. */
const FIXTURE = JSON.parse(
  readFileSync(new URL('./fixtures/character-assignment.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

/**
 * SHA-256 of the prompt the **Python** implementation produces for the fixture.
 *
 * Which Python: the `build-prompt.py` this plugin's compiler was ported *from* — a
 * file of the porting layer, **not** an upstream file. Upstream ships no character-side
 * prompt compiler at all (its agent composes the prompt from `references/character-spec.md`),
 * so this constant cannot, and does not claim to, pin agreement with upstream. It pins
 * the port against the implementation it came from.
 *
 * Measured, not assumed: that script emits exactly this digest at 775 characters. If the
 * test ever fails, the TypeScript port has drifted and must be fixed here, not by
 * updating the constant.
 */
const PYTHON_GOLDEN_SHA256 = '108c8542f76daaed23e61b469e4158261664af902531597b966afeb35ebd058d'
const PYTHON_GOLDEN_CHARS = 775

/** Build one image object, mirroring the Python test helper. */
function image(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'gentle_wave',
    subject: 'one Whale-chan',
    expression: 'gentle closed-eye smile',
    action: 'holds a white rice bowl with both hands',
    composition: 'front view, full body centered',
    props: ['white rice bowl', 'wooden chopsticks'],
    objects: [],
    style: { mode: 'canonical', description: 'canonical clean rounded cel-shaded Whale-chan style' },
    costume: { mode: 'canonical', description: 'canonical navy-and-white ornate maid outfit' },
    background: { mode: 'solid', description: 'warm ivory-beige #F5EADD' },
    text: null,
    proportion: {
      mode: 'preset',
      preset: 'semi-chibi',
      target_head_ratio: 2.8,
      acceptance_range: [2.689, 2.989],
      proportion_reference: null,
    },
    references: [],
    output: {
      format: 'png',
      aspect_ratio: '1:1',
      alpha: false,
      resolution: { mode: 'provider-native', width: null, height: null },
    },
    counterpart: null,
    ...overrides,
  }
}

/** Build an assignment around one image. */
function assignment(images?: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 4,
    confirmation: { confirmed: true, confirmed_at: '2026-10-02T00:00:00+00:00' },
    input: { type: 'text', content: 'a test request', focus: null },
    run_name: 'dsh-port-test',
    image_count: images?.length ?? 1,
    images: images ?? [image()],
    execution: { mode: 'sequential', requested_parallelism: 1, max_parallelism: 5, commit_strategy: 'coordinator-serial' },
    budget: { per_image_candidates: 8, per_provider_candidates: 2, run_candidates: 8, confirmed_over_24: false },
    ...overrides,
  }
}

test('DIFFERENTIAL: the fixture compiles to the porting-layer Python implementation’s exact bytes', () => {
  const compiled = compilePrompt(FIXTURE, 'gentle_wave')
  assert.equal(compiled.prompt.length, PYTHON_GOLDEN_CHARS)
  assert.equal(compiled.promptSha256, PYTHON_GOLDEN_SHA256)
})

test('canonical prompt is deterministic and within budget', () => {
  const first = compilePrompt(assignment(), 'gentle_wave')
  const second = compilePrompt(assignment(), 'gentle_wave')
  assert.equal(first.prompt, second.prompt)
  assert.ok(first.prompt.length <= DEFAULT_MAX_CHARS)
  assert.ok(first.prompt.includes(IDENTITY))
  assert.ok(first.prompt.includes(NO_TEXT))
  assert.ok(first.prompt.includes(COSTUME_CANONICAL))
  assert.ok(first.prompt.includes('2.8 heads tall total'))
  assert.ok(first.prompt.includes('white rice bowl'))
  assert.ok(first.prompt.includes('#F5EADD'))
  assert.deepEqual(
    first.blocks.map(block => block.name),
    ['identity', 'proportion', 'style', 'costume', 'scene', 'props', 'background', 'text'],
  )
})

test('per-block sizes count the rendered line, so they do not sum to the prompt length', () => {
  // The prompt is joined with newlines, which the per-block report excludes.
  // Getting this wrong silently shifts every block size by one.
  const compiled = compilePrompt(assignment(), 'gentle_wave')
  const summed = compiled.blocks.reduce((total, block) => total + block.chars, 0)
  assert.equal(compiled.prompt.length - summed, compiled.blocks.length - 1)
})

test('constant blocks leave real room for the scene', () => {
  const compiled = compilePrompt(assignment(), 'gentle_wave')
  const fixed = compiled.blocks.filter(block => block.name !== 'scene').reduce((total, block) => total + block.chars, 0)
  assert.ok(fixed <= DEFAULT_MAX_CHARS - 60, `constant blocks consume ${fixed} characters`)
  assert.ok(DEFAULT_MAX_CHARS - fixed > 100)
})

test('the no-text directive leads the prompt contract', () => {
  const compiled = compilePrompt(assignment(), 'gentle_wave')
  assert.equal(compiled.prompt.includes('Whale-chan:'), false, "a leading 'Name:' invites a rendered title")
  assert.ok(compiled.prompt.startsWith('Anime girl'))
  assert.ok(compiled.prompt.includes(NO_TEXT))
})

test('the identity block never names the character', () => {
  // Measured twice on this channel: the moment the name is in the prompt, it is painted.
  const compiled = compilePrompt(assignment(), 'gentle_wave')
  assert.equal(compiled.prompt.includes('Whale-chan'), false)
  assert.equal(compiled.prompt.includes('DeepSeek'), false)
  assert.ok(NO_TEXT.includes('caption'))
})

test('custom fields override the canonical defaults', () => {
  const compiled = compilePrompt(
    assignment([
      image({
        style: { mode: 'custom', description: 'flat watercolor with visible paper grain' },
        costume: { mode: 'custom', description: 'yellow raincoat and boots' },
        proportion: { mode: 'custom', preset: null, target_head_ratio: 5.0, acceptance_range: [4.85, 5.15], proportion_reference: null },
        background: { mode: 'custom', description: 'rainy neon street at night' },
      }),
    ]),
    'gentle_wave',
  )
  assert.ok(compiled.prompt.includes('flat watercolor with visible paper grain'))
  assert.ok(compiled.prompt.includes('yellow raincoat and boots'))
  assert.ok(compiled.prompt.includes('5 heads tall total'))
  assert.ok(compiled.prompt.includes('rainy neon street at night'))
  assert.equal(compiled.prompt.includes(COSTUME_CANONICAL), false)
  assert.equal(compiled.prompt.includes(STYLE_CANONICAL), false)
})

test('an exact-text contract replaces the no-text directive', () => {
  const compiled = compilePrompt(
    assignment([
      image({
        props: [],
        objects: [],
        expression: 'calm smile',
        action: 'stands still',
        composition: 'front view, full body',
        text: {
          content: '鲸鱼娘，先吃饭，后推理！',
          languages: ['zh-Hans'],
          direction: 'ltr',
          placement: 'above the character',
          style: 'rounded deep-blue lettering',
        },
      }),
    ]),
    'gentle_wave',
  )
  assert.ok(compiled.prompt.includes('鲸鱼娘，先吃饭，后推理！'))
  assert.ok(compiled.prompt.includes('zh-Hans'))
  assert.ok(compiled.prompt.includes('nothing else'))
  assert.equal(compiled.prompt.includes(NO_TEXT), false)
})

test('NEGATIVE: a text contract plus a rich scene fails loudly with the block report', () => {
  assert.throws(
    () =>
      compilePrompt(
        assignment([
          image({
            text: {
              content: '鲸鱼娘，先吃饭，后推理！',
              languages: ['zh-Hans'],
              direction: 'ltr',
              placement: 'above the character',
              style: 'rounded deep-blue lettering',
            },
          }),
        ]),
        'gentle_wave',
      ),
    (error: unknown) => {
      assert.ok(error instanceof PromptError)
      assert.equal(error.category, 'capability')
      assert.match(error.message.toLowerCase(), /shorten/)
      assert.ok(error.blocks.length > 0, 'the overflow must carry per-block sizes')
      return true
    },
  )
})

test('NEGATIVE: transparency is refused up front', () => {
  assert.throws(
    () => compilePrompt(assignment([image({ background: { mode: 'transparent', description: 'cut out' } })]), 'gentle_wave'),
    (error: unknown) => {
      assert.ok(error instanceof PromptError)
      assert.equal(error.category, 'capability')
      assert.match(error.message, /transparent/)
      return true
    },
  )
})

test('NEGATIVE: an unknown image name lists what is available', () => {
  assert.throws(
    () => compilePrompt(assignment(), 'nope'),
    (error: unknown) => {
      assert.ok(error instanceof PromptError)
      assert.match(error.message, /unknown image name/)
      assert.match(error.message, /gentle_wave/)
      return true
    },
  )
})

test('NEGATIVE: an out-of-range budget is rejected before anything is compiled', () => {
  for (const budget of [199, 801, 0, -1, 780.5]) {
    assert.throws(() => compilePrompt(assignment(), 'gentle_wave', budget), PromptError, `budget ${budget}`)
  }
})

test('NEGATIVE: a wrong schema version is rejected', () => {
  assert.throws(() => requireSchemaVersion({ schema_version: 3 }), PromptError)
  assert.throws(() => requireSchemaVersion({}), PromptError)
  assert.doesNotThrow(() => requireSchemaVersion({ schema_version: 4 }))
})

test('NEGATIVE: an unknown proportion preset is rejected', () => {
  assert.throws(
    () => compilePrompt(assignment([image({ proportion: { mode: 'preset', preset: 'heroic' } })]), 'gentle_wave'),
    PromptError,
  )
})

test('NEGATIVE: a custom proportion needs a ratio above 1.0', () => {
  assert.throws(
    () => compilePrompt(assignment([image({ proportion: { mode: 'custom', target_head_ratio: 1.0 } })]), 'gentle_wave'),
    PromptError,
  )
})

test('NEGATIVE: a scene with no expression, action or composition is rejected', () => {
  assert.throws(
    () => compilePrompt(assignment([image({ expression: '', action: '  ', composition: '' })]), 'gentle_wave'),
    PromptError,
  )
})

test('formatGeneral matches Python’s %g at precision 6', () => {
  assert.equal(formatGeneral(4.0), '4', 'trailing zeros are dropped')
  assert.equal(formatGeneral(5), '5')
  assert.equal(formatGeneral(3.3), '3.3')
  assert.equal(formatGeneral(2.8), '2.8')
  assert.equal(formatGeneral(2.85), '2.85')
  assert.equal(formatGeneral(2.1), '2.1')
  // The whole point: 6 significant digits, so binary noise never reaches a prompt.
  assert.equal(formatGeneral(2.8000000000000003), '2.8')
  assert.equal(formatGeneral(1.1000000000000001), '1.1')
})

test('pythonRound is half-to-even, unlike Math.round', () => {
  assert.equal(pythonRound(2.5), 2, 'JavaScript’s Math.round(2.5) would give 3')
  assert.equal(pythonRound(3.5), 4)
  assert.equal(pythonRound(35.714285714285715), 36)
  assert.equal(pythonRound(30.303030303030305), 30)
  assert.equal(pythonRound(47.61904761904762), 48)
  assert.equal(pythonRound(40), 40)
})

test('every preset head count renders as a Python-identical line', () => {
  const expected: Readonly<Record<string, string>> = {
    standard: '4 heads tall total (head ~25% tall); age unchanged.',
    compact: '3.3 heads tall total (head ~30% tall); age unchanged.',
    'semi-chibi': '2.8 heads tall total (head ~36% tall); age unchanged.',
    chibi: '2.5 heads tall total (head ~40% tall); age unchanged.',
    'super-deformed': '2.1 heads tall total (head ~48% tall); age unchanged.',
  }
  for (const [preset, line] of Object.entries(expected)) {
    assert.equal(PRESET_HEADS[preset] === undefined, false, `${preset} must exist`)
    const compiled = compilePrompt(
      assignment([image({ proportion: { mode: 'preset', preset } })]),
      'gentle_wave',
    )
    assert.ok(compiled.prompt.includes(line), `${preset}: expected ${line}`)
  }
})
