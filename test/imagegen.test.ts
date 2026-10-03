import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WhalechanError } from '../src/domain/errors.ts'
import { describeImagegen, readSettingsView, resolveModel } from '../src/run/imagegen.ts'

/** A settings-view body shaped exactly like the live dsh-imagegen response. */
function settingsBody(): Record<string, unknown> {
  return {
    ok: true,
    value: {
      namespaces: [
        {
          ns: 'dsh-imagegen',
          schema: { uid: 19524 },
          value: {
            enabled: true,
            defaultModel: 'qwen-image-3.0',
            defaultChannelId: 'chan-b',
            channels: [
              {
                id: 'chan-a',
                name: '智谱 AI 官方',
                apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
                models: [{ alias: 'glm-image', id: 'glm-image' }],
              },
              {
                id: 'chan-b',
                name: '阿里云百炼（Qwen-Image）',
                apiUrl: 'https://dashscope.aliyuncs.com/api/v1',
                models: [
                  { alias: 'qwen-image-3.0', id: 'qwen-image-3.0' },
                  { alias: 'qwen-image-max', id: 'qwen-image-max' },
                ],
              },
            ],
            channelSecrets: { 'chan-a': 'SUPER-SECRET-ZHIPU-KEY', 'chan-b': 'SUPER-SECRET-QWEN-KEY' },
          },
          secrets: [{ set: true, path: ['channelSecrets', 'chan-a'] }],
          revision: 7,
        },
      ],
    },
  }
}

test('readSettingsView: extracts the model catalogue across channels', () => {
  const view = readSettingsView(settingsBody())
  assert.equal(view.defaultModel, 'qwen-image-3.0')
  assert.equal(view.defaultChannelId, 'chan-b')
  assert.deepEqual(view.models, [
    { alias: 'glm-image', channelId: 'chan-a', channelName: '智谱 AI 官方' },
    { alias: 'qwen-image-3.0', channelId: 'chan-b', channelName: '阿里云百炼（Qwen-Image）' },
    { alias: 'qwen-image-max', channelId: 'chan-b', channelName: '阿里云百炼（Qwen-Image）' },
  ])
})

test('SECURITY: the settings view never carries an API key', () => {
  const serialized = JSON.stringify(readSettingsView(settingsBody()))
  assert.equal(serialized.includes('SUPER-SECRET'), false, 'a key must not survive the narrowing')
  assert.equal(serialized.includes('channelSecrets'), false)
  assert.equal(serialized.includes('apiUrl'), false, 'endpoints are not needed either')
})

test('NEGATIVE: a settings body with no namespaces is reported, not guessed at', () => {
  assert.throws(
    () => readSettingsView({ ok: true, value: { namespaces: [] } }),
    (error: unknown) => error instanceof WhalechanError && error.category === 'service',
  )
  assert.throws(() => readSettingsView({}), WhalechanError)
})

test('readSettingsView: a malformed channel entry is skipped, not fatal', () => {
  const view = readSettingsView({
    ok: true,
    value: { namespaces: [{ value: { channels: [null, { id: 'c', models: [{ alias: '  ' }, { alias: 'ok' }] }] } }] },
  })
  assert.deepEqual(view.models, [{ alias: 'ok', channelId: 'c', channelName: '' }])
  assert.equal(view.defaultModel, '')
})

test('resolveModel: explicit beats configured beats the imagegen default', () => {
  const view = readSettingsView(settingsBody())
  assert.equal(resolveModel(view, 'glm-image', 'qwen-image-max'), 'glm-image')
  assert.equal(resolveModel(view, '', 'qwen-image-max'), 'qwen-image-max')
  assert.equal(resolveModel(view, '  ', ''), 'qwen-image-3.0')
})

test('resolveModel: one alias in the catalogue is unambiguous', () => {
  const view = readSettingsView({
    ok: true,
    value: { namespaces: [{ value: { channels: [{ id: 'c', models: [{ alias: 'glm-image' }] }] } }] },
  })
  assert.equal(resolveModel(view, '', ''), 'glm-image')
})

test('NEGATIVE: resolveModel asks the caller to choose when several aliases exist', () => {
  // Ambiguity only arises when nothing names a model: no request, no setting,
  // and no imagegen default — but a catalogue with more than one alias.
  const body = settingsBody()
  const namespaces = (body['value'] as { namespaces: Array<{ value: Record<string, unknown> }> }).namespaces
  namespaces[0]!.value['defaultModel'] = ''
  const view = readSettingsView(body)
  assert.throws(
    () => resolveModel(view, '', ''),
    (error: unknown) => {
      assert.ok(error instanceof WhalechanError)
      assert.equal(error.category, 'capability')
      assert.match(error.message, /glm-image/)
      assert.match(error.message, /qwen-image-max/)
      return true
    },
  )
})

test('NEGATIVE: resolveModel reports an empty catalogue clearly', () => {
  const view = readSettingsView({ ok: true, value: { namespaces: [{ value: { channels: [] } }] } })
  assert.throws(
    () => resolveModel(view, '', ''),
    (error: unknown) => error instanceof WhalechanError && error.category === 'capability',
  )
})

test('describeImagegen: reads the live view through the loopback route', async () => {
  const calls: string[] = []
  const view = await describeImagegen(
    { explicit: 'http://host:9/' },
    {
      fetchImpl: async (input) => {
        calls.push(String(input))
        return new Response(JSON.stringify(settingsBody()), { status: 200 })
      },
    },
  )
  assert.deepEqual(calls, ['http://host:9/api/dsh-imagegen/settings/describe'])
  assert.equal(view.defaultModel, 'qwen-image-3.0')
})

test('NEGATIVE: an HTTP failure is classified from its status', async () => {
  await assert.rejects(
    describeImagegen(
      { explicit: 'http://host:9' },
      { fetchImpl: async () => new Response('nope', { status: 403 }) },
    ),
    (error: unknown) => error instanceof WhalechanError && error.category === 'authentication',
  )
})

test('NEGATIVE: a non-JSON 200 is a service failure', async () => {
  await assert.rejects(
    describeImagegen(
      { explicit: 'http://host:9' },
      { fetchImpl: async () => new Response('<html>', { status: 200 }) },
    ),
    (error: unknown) => error instanceof WhalechanError && error.category === 'service',
  )
})

test('NEGATIVE: an {ok:false} body is classified from its code', async () => {
  await assert.rejects(
    describeImagegen(
      { explicit: 'http://host:9' },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: false, code: 'no-channels', message: 'nothing configured' }), {
            status: 200,
          }),
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof WhalechanError)
      assert.equal(error.category, 'capability', 'the route answers HTTP 200 even for failures')
      assert.match(error.message, /nothing configured/)
      return true
    },
  )
})
