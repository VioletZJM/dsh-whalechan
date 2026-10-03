import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyEndpointError, classifyHttp, WhalechanError } from '../src/domain/errors.ts'

test('classifyHttp: auth, rate limit, server, and everything else', () => {
  assert.equal(classifyHttp(401), 'authentication')
  assert.equal(classifyHttp(403), 'authentication')
  assert.equal(classifyHttp(429), 'rate_limit')
  assert.equal(classifyHttp(500), 'service')
  assert.equal(classifyHttp(503), 'service')
  assert.equal(classifyHttp(400), 'capability')
  assert.equal(classifyHttp(404), 'capability')
})

test('classifyEndpointError: the adapter-capability code list', () => {
  for (const code of [
    'bad-request',
    'image-model-not-configured',
    'no-models-configured',
    'model-choice-required',
    'edit-unsupported',
    'no-channels',
    'edit-image-missing',
    'edit-image-invalid',
    'edit-image-too-large',
  ]) {
    assert.equal(classifyEndpointError(code, 'whatever'), 'capability', `${code} must be capability`)
  }
})

test('classifyEndpointError: upstream timeout is its own category', () => {
  assert.equal(classifyEndpointError('upstream-timeout', 'the provider did not answer'), 'timeout')
})

test('classifyEndpointError: an unrecognised code is service, not capability', () => {
  assert.equal(classifyEndpointError('something-new', 'unexpected'), 'service')
  assert.equal(classifyEndpointError('', ''), 'service')
})

test('classifyEndpointError: safety hints win, case-insensitively', () => {
  assert.equal(classifyEndpointError('anything', 'blocked by the safety filter'), 'safety_rejection')
  assert.equal(classifyEndpointError('anything', 'Content Policy violation'), 'safety_rejection')
  assert.equal(classifyEndpointError('anything', 'MODERATION refused'), 'safety_rejection')
  assert.equal(classifyEndpointError('anything', '内容涉嫌违规'), 'safety_rejection')
  assert.equal(classifyEndpointError('anything', '提示词包含敏感内容'), 'safety_rejection')
})

test('classifyEndpointError: a safety hint outranks the capability code list', () => {
  // Order matters: a `bad-request` whose message says "safety" is a safety
  // rejection, because a safety block is never a retryable request mistake.
  assert.equal(classifyEndpointError('bad-request', 'safety refusal'), 'safety_rejection')
})

test('WhalechanError carries a category and defaults to service', () => {
  assert.equal(new WhalechanError('boom').category, 'service')
  assert.equal(new WhalechanError('boom', 'capability').category, 'capability')
  assert.equal(new WhalechanError('boom').name, 'WhalechanError')
  assert.ok(new WhalechanError('boom') instanceof Error)
})
