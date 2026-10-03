import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WhalechanError } from '../src/domain/errors.ts'
import {
  deliverableRatios,
  describeDeliverables,
  geometryTable,
  ratioLabel,
  ratioOf,
  resolveGeometry,
  channelReport,
  OPENAI_SIZE_BY_RATIO,
} from '../src/domain/geometry.ts'

test('ratioLabel: labels come from pixels, reduced', () => {
  assert.equal(ratioLabel('1024x1024'), '1:1')
  assert.equal(ratioLabel('1024x1536'), '2:3')
  assert.equal(ratioLabel('1536x1024'), '3:2')
  assert.equal(ratioLabel('1024x1792'), '4:7')
  assert.equal(ratioLabel('1792x1024'), '7:4')
  assert.equal(ratioLabel('1664*928'), '52:29', 'the star separator is the DashScope form')
  assert.equal(ratioLabel('1328*1328'), '1:1')
  assert.equal(ratioLabel('2368*1728'), '37:27')
  assert.equal(ratioLabel('1728*2368'), '27:37')
})

test('ratioOf: reads both the key form and the pixel form', () => {
  assert.equal(ratioOf('1:1'), 1)
  assert.equal(ratioOf('16:9'), 16 / 9)
  assert.equal(ratioOf('1792x1024'), 1.75)
  assert.equal(ratioOf('1664*928'), 1664 / 928)
})

test('geometryTable: 智谱 falls through to the OpenAI-shaped table', () => {
  assert.equal(geometryTable('zhipu', 'glm-image'), OPENAI_SIZE_BY_RATIO)
  assert.equal(geometryTable('gpt-image', 'gpt-image-1'), OPENAI_SIZE_BY_RATIO)
  assert.equal(geometryTable('grok', 'grok-imagine'), null, 'native-dial families have no table')
})

test('the plugin panel key `3:4` really holds 2:3 geometry', () => {
  // This single fact is why the adapter refuses `3:4` instead of sending it.
  assert.equal(OPENAI_SIZE_BY_RATIO['3:4'], '1024x1536')
  assert.equal(ratioLabel(OPENAI_SIZE_BY_RATIO['3:4']!), '2:3')
})

test('deliverableRatios: 智谱 exactly delivers five ratios and nothing else', () => {
  assert.deepEqual(deliverableRatios('zhipu', 'glm-image'), ['1:1', '2:3', '3:2', '4:7', '7:4'])
})

test('deliverableRatios: the two Qwen tiers differ', () => {
  assert.deepEqual(deliverableRatios('qwen', 'qwen-image-3.0'), ['7:4', '37:27', '1:1', '27:37', '4:7'])
  assert.deepEqual(deliverableRatios('qwen', 'qwen-image-max'), ['52:29', '4:3', '1:1', '3:4', '29:52'])
})

test('deliverableRatios: minimax lists its eight ratios; native-dial families return null', () => {
  assert.deepEqual(deliverableRatios('minimax', 'image-01'), [
    '1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9',
  ])
  assert.equal(deliverableRatios('grok', 'grok-imagine'), null)
  assert.equal(deliverableRatios('nanobanana', 'nanobanana-pro'), null)
  assert.equal(deliverableRatios('seedream', 'seedream-4.0'), null)
})

test('resolveGeometry: 智谱 1:1 rides `auto` for the larger upstream default', () => {
  assert.deepEqual(resolveGeometry('zhipu', 'glm-image', '1:1'), {
    sizeKey: 'auto',
    expectedPixels: '1280x1280',
    ratioControl: true,
    note: 'sent as `auto`: upstream applies its own 1280x1280 default',
  })
})

test('resolveGeometry: 7:4 is sent under the sloppy panel key `16:9`', () => {
  const geometry = resolveGeometry('zhipu', 'glm-image', '7:4')
  assert.equal(geometry.sizeKey, '16:9')
  assert.equal(geometry.expectedPixels, '1792x1024')
  assert.equal(ratioLabel(geometry.expectedPixels!), '7:4', 'what comes back IS 7:4')
})

test('resolveGeometry: 2:3 is sent under its own key, not the `3:4` alias', () => {
  const geometry = resolveGeometry('zhipu', 'glm-image', '2:3')
  assert.equal(geometry.sizeKey, '2:3')
  assert.equal(geometry.expectedPixels, '1024x1536')
})

test('NEGATIVE: 智谱 refuses 16:9 instead of quietly delivering 7:4', () => {
  assert.throws(
    () => resolveGeometry('zhipu', 'glm-image', '16:9'),
    (error: unknown) => {
      assert.ok(error instanceof WhalechanError)
      assert.equal(error.category, 'capability')
      assert.match(error.message, /cannot be delivered exactly/)
      assert.match(error.message, /nearest mapped geometry: 1792x1024/, 'must name the nearest geometry')
      return true
    },
  )
})

test('NEGATIVE: 智谱 refuses 3:4, 4:3, 9:16 and 21:9', () => {
  for (const ratio of ['3:4', '4:3', '9:16', '21:9']) {
    assert.throws(() => resolveGeometry('zhipu', 'glm-image', ratio), WhalechanError, `${ratio} must be refused`)
  }
})

test('resolveGeometry: the classic Qwen tier cannot deliver 7:4', () => {
  assert.throws(
    () => resolveGeometry('qwen', 'qwen-image-max', '7:4'),
    (error: unknown) => error instanceof WhalechanError && error.category === 'capability',
  )
  const versioned = resolveGeometry('qwen', 'qwen-image-3.0', '7:4')
  assert.equal(versioned.sizeKey, '16:9')
  assert.equal(versioned.expectedPixels, '2688x1536')
})

test('NEGATIVE: minimax refuses a ratio outside its native list', () => {
  assert.throws(
    () => resolveGeometry('minimax', 'image-01', '5:4'),
    (error: unknown) => error instanceof WhalechanError && error.category === 'capability',
  )
  assert.equal(resolveGeometry('minimax', 'image-01', '21:9').sizeKey, '21:9')
})

test('resolveGeometry: seedream sends a resolution tier and does not control the ratio', () => {
  assert.deepEqual(resolveGeometry('seedream', 'seedream-4.0', '1:1'), {
    sizeKey: null,
    expectedPixels: null,
    ratioControl: false,
    note: 'seedream receives a resolution tier only: the output ratio is provider-decided',
  })
})

test('resolveGeometry: native-dial families pass the ratio straight through', () => {
  const geometry = resolveGeometry('grok', 'grok-imagine-image', '16:9')
  assert.equal(geometry.sizeKey, '16:9')
  assert.equal(geometry.expectedPixels, null)
  assert.equal(geometry.ratioControl, true)
})

test('describeDeliverables: names the deliverable labels and the nearest geometry', () => {
  const text = describeDeliverables(OPENAI_SIZE_BY_RATIO, '16:9')
  assert.match(text, /1:1, 2:3, 3:2, 4:7, 7:4/)
  assert.match(text, /nearest mapped geometry: 1792x1024/)
})

test('channelReport: 智谱 report is text-to-image-only with an 800-char ceiling', () => {
  const report = channelReport('glm-image')
  assert.equal(report.channel_family, 'zhipu')
  assert.equal(report.references_supported, false)
  assert.equal(report.transparency_supported, false)
  assert.equal(report.prompt_limit_chars, 800)
  assert.equal(report.ratio_control, true)
  assert.equal(report.recommended_reference_policy, 'agent-visual-only')
  assert.deepEqual(report.deliverable_ratios, ['1:1', '2:3', '3:2', '4:7', '7:4'])
})

test('channelReport: the Qwen max alias reports the classic tier honestly', () => {
  const report = channelReport('qwen-image-max')
  assert.equal(report.channel_family, 'qwen')
  assert.equal(report.references_supported, true)
  assert.equal(report.prompt_limit_chars, 4000)
  assert.equal(report.recommended_reference_policy, 'provider-edit')
  assert.equal(report.deliverable_ratios?.includes('7:4'), false, '7:4 is undeliverable on this tier')
  assert.equal(report.deliverable_ratios?.includes('4:3'), true)
})

test('NEGATIVE: channelReport refuses an unroutable alias', () => {
  assert.throws(
    () => channelReport('ep-20250101-abcdef'),
    (error: unknown) => error instanceof WhalechanError && error.category === 'capability',
  )
})
