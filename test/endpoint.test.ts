import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WhalechanError } from '../src/domain/errors.ts'
import {
  IMAGEGEN_GENERATE_PATH,
  IMAGEGEN_SETTINGS_DESCRIBE_PATH,
  describeImagegenBase,
  hostAddressOf,
  joinUrl,
  normalizeBase,
  resolveImagegenBase,
} from '../src/run/endpoint.ts'

test('normalizeBase: trims and drops trailing slashes', () => {
  assert.equal(normalizeBase('  http://127.0.0.1:19387/  '), 'http://127.0.0.1:19387')
  assert.equal(normalizeBase('http://host:1///'), 'http://host:1')
  assert.equal(normalizeBase(''), '')
  assert.equal(normalizeBase(undefined), '')
})

test('resolveImagegenBase: an explicit setting wins over everything', () => {
  assert.equal(
    resolveImagegenBase({ explicit: 'http://explicit:1/', hostAddress: 'http://host:2', env: { DSH_WEB_URL: 'http://env:3' } }),
    'http://explicit:1',
  )
})

test('resolveImagegenBase: the host address beats the environment variable', () => {
  assert.equal(
    resolveImagegenBase({ hostAddress: 'http://host:2', env: { DSH_WEB_URL: 'http://env:3' } }),
    'http://host:2',
  )
})

test('resolveImagegenBase: DSH_WEB_URL is the last resort', () => {
  assert.equal(resolveImagegenBase({ env: { DSH_WEB_URL: 'http://env:3/' } }), 'http://env:3')
})

test('resolveImagegenBase: a blank explicit setting falls through instead of winning', () => {
  assert.equal(resolveImagegenBase({ explicit: '   ', env: { DSH_WEB_URL: 'http://env:3' } }), 'http://env:3')
})

test('NEGATIVE: no source at all is a classified, actionable failure', () => {
  assert.throws(
    () => resolveImagegenBase({ env: {} }),
    (error: unknown) => {
      assert.ok(error instanceof WhalechanError)
      assert.equal(error.category, 'unavailable')
      assert.match(error.message, /imagegenBaseUrl/, 'must tell the user what to set')
      assert.match(error.message, /DSH_WEB_URL/, 'must name the missing environment variable')
      return true
    },
  )
})

test('joinUrl: composes the two published route paths', () => {
  assert.equal(joinUrl('http://h:1', IMAGEGEN_GENERATE_PATH), 'http://h:1/api/dsh-imagegen/generate')
  assert.equal(joinUrl('http://h:1/', IMAGEGEN_SETTINGS_DESCRIBE_PATH), 'http://h:1/api/dsh-imagegen/settings/describe')
})

test('hostAddressOf: a bound port becomes a loopback base URL', () => {
  assert.equal(hostAddressOf(3080), 'http://127.0.0.1:3080')
  assert.equal(hostAddressOf(19387), 'http://127.0.0.1:19387')
})

test('hostAddressOf: an unbound listener is "not ready yet", not an address', () => {
  // `ctx.webServer.port` is 0 until the listener binds, and a plugin is mounted
  // before that — so this must degrade instead of producing http://127.0.0.1:0.
  assert.equal(hostAddressOf(0), undefined)
  assert.equal(hostAddressOf(undefined), undefined)
  assert.equal(hostAddressOf(-1), undefined)
  assert.equal(hostAddressOf(70000), undefined)
  assert.equal(hostAddressOf(3.5), undefined)
})

test('describeImagegenBase: the source is reported, and the measured one wins', () => {
  // The defect this pins: on the first real 3080 run, the host process inherited
  // `DSH_WEB_URL` naming a *different* host (19387) while serving on 3080. The
  // value alone could not be told apart from a measurement; the source can.
  assert.deepEqual(
    describeImagegenBase({
      explicit: undefined,
      hostAddress: 'http://127.0.0.1:3080',
      env: { DSH_WEB_URL: 'http://127.0.0.1:19387' },
    }),
    { base: 'http://127.0.0.1:3080', source: 'host-web-server' },
  )

  // Before the listener binds, the inherited URL is all there is, and it says so.
  assert.deepEqual(
    describeImagegenBase({
      explicit: undefined,
      hostAddress: undefined,
      env: { DSH_WEB_URL: 'http://127.0.0.1:19387' },
    }),
    { base: 'http://127.0.0.1:19387', source: 'DSH_WEB_URL' },
  )

  assert.deepEqual(
    describeImagegenBase({ explicit: 'http://example.test:9', hostAddress: 'http://127.0.0.1:3080' }),
    { base: 'http://example.test:9', source: 'setting' },
  )

  // Nothing resolves: an empty base and an honest source rather than a throw, so
  // the receipt stays writable on a cold start either way.
  assert.deepEqual(describeImagegenBase({}), { base: '', source: 'unresolved' })

  // The source must agree with what `resolveImagegenBase` picks, not merely be
  // plausible: both read the same candidate list.
  const sources = {
    explicit: '',
    hostAddress: 'http://127.0.0.1:1234',
    env: { DSH_WEB_URL: 'http://127.0.0.1:9999' },
  }
  assert.equal(describeImagegenBase(sources).base, resolveImagegenBase(sources))
})
