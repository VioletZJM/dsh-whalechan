import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROMPT_LIMIT,
  channelFamily,
  isVersionedQwen,
  promptLimit,
  referencesSupported,
  transparencySupported,
} from '../src/domain/family.ts'

test('channelFamily: 智谱 aliases are zhipu', () => {
  assert.equal(channelFamily('glm-image'), 'zhipu')
  assert.equal(channelFamily('cogview-4'), 'zhipu')
  assert.equal(channelFamily('  glm-image  '), 'zhipu', 'surrounding whitespace must not matter')
})

test('channelFamily: Qwen-Image aliases are qwen', () => {
  assert.equal(channelFamily('qwen-image-3.0'), 'qwen')
  assert.equal(channelFamily('qwen-image-3.0-pro'), 'qwen')
  assert.equal(channelFamily('qwen-image-max'), 'qwen')
  assert.equal(channelFamily('qwen-image'), 'qwen')
})

test('channelFamily: OpenAI-shaped aliases', () => {
  assert.equal(channelFamily('gpt-image-1'), 'gpt-image')
  assert.equal(channelFamily('dall-e-3'), 'dall-e')
})

test('channelFamily: native-dial families', () => {
  assert.equal(channelFamily('grok-imagine-image'), 'grok')
  assert.equal(channelFamily('grok-imagine'), 'grok')
  assert.equal(channelFamily('nanobanana-pro'), 'nanobanana')
  assert.equal(channelFamily('gemini-3.1-flash-image'), 'nanobanana')
  assert.equal(channelFamily('gemini-2.5-flash-image'), 'nanobanana')
  assert.equal(channelFamily('doubao-seedream-4-0'), 'seedream')
  assert.equal(channelFamily('seedream-4.0'), 'seedream')
  assert.equal(channelFamily('image-01'), 'minimax')
  assert.equal(channelFamily('minimax/image-01'), 'minimax')
})

test('channelFamily: an unrelated alias is unknown, never a guess', () => {
  assert.equal(channelFamily('deepseek-chat'), 'unknown')
  assert.equal(channelFamily(''), 'unknown')
  assert.equal(channelFamily('ep-20250101-abcdef'), 'unknown', 'endpoint ids must never route')
})

test('channelFamily: a name that merely contains a family keyword does not match', () => {
  assert.equal(channelFamily('my-glm-image'), 'unknown')
  assert.equal(channelFamily('grok-imagineX'), 'unknown', '`grok-imagine` needs `-` or end of input')
})

test('isVersionedQwen: only dotted ids are the new geometry tier', () => {
  assert.equal(isVersionedQwen('qwen-image-3.0'), true)
  assert.equal(isVersionedQwen('qwen-image-2.0-pro'), true)
  assert.equal(isVersionedQwen('qwen-image-max'), false)
  assert.equal(isVersionedQwen('qwen-image'), false)
})

test('promptLimit: documented ceilings, conservative default elsewhere', () => {
  assert.equal(promptLimit('zhipu'), 800)
  assert.equal(promptLimit('minimax'), 1500)
  assert.equal(promptLimit('qwen'), DEFAULT_PROMPT_LIMIT)
  assert.equal(promptLimit('unknown'), DEFAULT_PROMPT_LIMIT)
})

test('referencesSupported: only 智谱 is text-to-image-only', () => {
  assert.equal(referencesSupported('zhipu'), false)
  assert.equal(referencesSupported('qwen'), true)
  assert.equal(referencesSupported('unknown'), true, 'unknown families default to the optimistic answer')
})

test('transparencySupported: only gpt-image has a verified contract', () => {
  assert.equal(transparencySupported('gpt-image'), true)
  assert.equal(transparencySupported('zhipu'), false)
  assert.equal(transparencySupported('qwen'), false)
})
