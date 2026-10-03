/**
 * The picture, and nothing else.
 *
 * Three complaints from the first real delivery (§73 of the charter) all landed after
 * the image existed: the tool returned a 1553-character prose block, the agent spent
 * two more steps measuring the file, and the whole tail cost 28 s of a 93 s turn. The
 * plugin cannot stop an agent from being thorough — but it can stop being the reason.
 * So the delivered call now says one or two lines, carries no path, and hands the file
 * to the **session's deliverables** itself (`src/run/deliver.ts`).
 *
 * What is asserted here is the text:
 *   - a delivery is short, pathless, prompt-free, plan-id-free and never mentions
 *     `present` (the sentence that caused the extra step);
 *   - a delivery the session would not take still names the file, because the money is
 *     already spent at that point and the user has to be able to find the picture;
 *   - a dry run is untouched: it is the artifact a human approves, not a report.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderImage, type ImageToolValue } from '../src/tools/image.ts'

/** A delivered value. Only the fields `renderImage` reads are populated. */
function delivered(overrides: Partial<ImageToolValue> = {}): ImageToolValue {
  return {
    dry_run: false,
    plan_id: 'f'.repeat(64),
    model: 'qwen-image-3.0',
    model_source: 'the plugin setting defaultModel',
    channel_family: 'qwen',
    prompt_ceiling: 800,
    ratio: '1:1',
    size: '1:1',
    expected_pixels: '2048x2048',
    deliverable_ratios: ['7:4', '37:27', '1:1', '27:37', '4:7'],
    form: 'semi-chibi',
    form_because: 'no form was named.',
    count: 1,
    prompt: 'PROMPT-ORIGINAL-TEXT',
    prompt_chars: 19,
    blocks: [],
    confirmation: [],
    images: [{
      name: '20261003-1839-semi-chibi-01',
      path: 'C:\\Users\\x\\.dsh\\dsh-whalechan\\images\\20261003-1839-semi-chibi-01.png',
      media_type: 'image/png',
      bytes: 2856297,
      sha256: 'b'.repeat(64),
    }],
    delivered: 1,
    delivery_error: '',
    ...overrides,
  }
}

test('presentation: a delivery is one or two lines — no prompt, no path, no plan id, no `present`', () => {
  const text = renderImage(delivered())
  assert.ok(text.length <= 220, `the delivered result is ${text.length} characters: ${text}`)
  assert.equal(text.includes('PROMPT-ORIGINAL-TEXT'), false, 'the prompt is not re-sent after the money is spent')
  assert.equal(text.includes('.png'), false, 'the delivered result names no file')
  assert.equal(text.includes('C:\\'), false, 'the delivered result names no path')
  assert.equal(text.includes('f'.repeat(64)), false, 'the delivered result does not repeat the plan id')
  // The note that created the extra step: telling the model to go and present it.
  assert.equal(/present/i.test(text), false, 'nothing asks the agent to hand the image over by hand')
  assert.match(text, /qwen-image-3\.0/)
  assert.match(text, /2048x2048/)
})

test('presentation: a delivery the session would not take falls back to the path', () => {
  const text = renderImage(delivered({ delivered: 0, delivery_error: 'this host has no session projections' }))
  assert.match(text, /this host has no session projections/)
  assert.ok(text.includes('20261003-1839-semi-chibi-01.png'), 'the user must be able to find a paid image')
  assert.ok(text.length <= 400, `the fallback is ${text.length} characters`)
  assert.equal(/present/i.test(text), false, 'even the fallback does not ask the agent to hand it over')
})

test('presentation: a partial declaration is treated as a failure, not a success', () => {
  // Two drawn, one declared: the user would otherwise be told to look at a card that
  // carries only half of what they paid for.
  const text = renderImage(delivered({
    count: 2,
    delivered: 1,
    delivery_error: 'the session took one of two',
    images: [
      { name: 'a', path: 'C:\\x\\a.png', media_type: 'image/png', bytes: 1, sha256: 'a' },
      { name: 'b', path: 'C:\\x\\b.png', media_type: 'image/png', bytes: 1, sha256: 'b' },
    ],
  }))
  assert.match(text, /C:\\x\\a\.png/)
  assert.match(text, /C:\\x\\b\.png/)
})

test('presentation: a channel that picks its own pixel size prints no empty parenthesis', () => {
  const text = renderImage(delivered({ expected_pixels: '' }))
  assert.equal(text.includes('()'), false, text)
  assert.match(text, /qwen-image-3\.0/)
})

test('presentation: a dry run still shows the prompt and the plan id in full', () => {
  // The money gate, not a report. Trimming the delivery must not touch it.
  const text = renderImage(delivered({ dry_run: true, images: [], delivered: 0 }))
  assert.match(text, /PROMPT-ORIGINAL-TEXT/)
  assert.match(text, new RegExp('f'.repeat(64)))
  assert.match(text, /Nothing has been spent/)
})

test('presentation: NEGATIVE — the old report would fail every one of the delivery assertions', () => {
  // The exact shape the installed 0.3.3 returned, kept as the fixture for the guard
  // above: a guard that cannot fail is indistinguishable from one that works.
  const old = [
    'Generated 1 image(s) on qwen-image-3.0, channel family "qwen".',
    'Form: semi-chibi — b',
    'Prompt: 33 characters (the compiler\'s ceiling is 800).',
    '',
    'PROMPT-ORIGINAL-TEXT',
    '',
    `Plan id ${'f'.repeat(64)}`,
    '  n: C:\\somewhere\\images\\20261003-1839-semi-chibi-01.png (1 bytes, image/png)',
    '',
    "Nothing checked these drawings — show them with the host's `present` tool.",
  ].join('\n')
  assert.ok(old.length > 220, 'the old result was 664 characters, not one line')
  assert.ok(old.includes('PROMPT-ORIGINAL-TEXT'))
  assert.ok(old.includes('.png'))
  assert.ok(/present/i.test(old), 'the old result asked the agent to present the image by hand')
})
