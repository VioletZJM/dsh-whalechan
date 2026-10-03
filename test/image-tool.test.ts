/**
 * `whalechan_image`: the money path, against a fake host that answers like the real
 * route family does.
 *
 * Four assertions carry the weight:
 *   - a dry run sends **nothing** and still returns the prompt that would be sent;
 *   - `plan_id` binds the prompt, the model and the size, so the same request plans
 *     to the same id and a changed one does not;
 *   - a confirmed call without the matching id is refused **before** the wire;
 *   - a drawn image lands on disk with a sidecar, and nothing else checks it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { IMAGE_TOOL_NAME, imageRun, planDigest, registerImageTool, renderImage, type ImageToolDeps } from '../src/tools/image.ts'
import { WhalechanError } from '../src/domain/errors.ts'
import { CHARACTER_SKILL_ROOT } from '../src/run/vendor.ts'
import { composeImages, loadCatalog } from '../src/domain/compose.ts'

/** Real image bytes to hand back: a vendored anchor, so the file written is a real WebP. */
const WEBP = readFileSync(
  composeImages({ prompt: 'x' }, loadCatalog(CHARACTER_SKILL_ROOT), 1, CHARACTER_SKILL_ROOT).anchorPath,
)

/** A host that answers every request with the same image, and records what it got. */
async function fakeImagegen(payload?: unknown): Promise<{
  base: string
  bodies: () => Array<Record<string, unknown>>
  close: () => Promise<void>
}> {
  const bodies: Array<Record<string, unknown>> = []
  const server: Server = createServer((request, res) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload ?? { ok: true, images: [{ b64: WEBP.toString('base64'), mime: 'image/webp' }] }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    bodies: () => bodies,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** The stub host: one alias, so the model resolves without ambiguity. */
function deps(
  base: string,
  dataRoot: string,
  config: Record<string, unknown> = {},
  deliver?: ImageToolDeps['deliver'],
): ImageToolDeps {
  return {
    resolveConfig: () => ({ dataRoot, ...config }),
    endpointSources: () => ({ explicit: base }),
    describe: async () => ({
      defaultModel: '',
      defaultChannelId: 'chan-1',
      models: [{ alias: 'qwen-image-3.0', channelId: 'chan-1', channelName: 'aliyun' }],
    }),
    deliver: deliver ?? (async files => ({ delivered: files.length, error: '' })),
  }
}

/** A stand-in for the session delivery seam, with a way to make it refuse. */
function deliverySeam(refusal?: string): {
  calls: () => Array<readonly { path: string; description: string }[]>
  deliver: NonNullable<ImageToolDeps['deliver']>
} {
  const calls: Array<readonly { path: string; description: string }[]> = []
  return {
    calls: () => calls,
    deliver: async (files) => {
      calls.push(files)
      if (refusal !== undefined) return { delivered: 0, error: refusal }
      return { delivered: files.length, error: '' }
    },
  }
}

test('image-tool: a dry run compiles, costs nothing and sends nothing', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-dry-'))
  try {
    const value = await imageRun({ prompt: 'sitting on the floor eating a bowl of white rice, smiling' }, deps(host.base, root))
    assert.equal(value.dry_run, true)
    assert.deepEqual(value.images, [])
    assert.equal(host.bodies().length, 0, 'a dry run must not touch the wire')
    assert.equal(value.model, 'qwen-image-3.0')
    assert.equal(value.channel_family, 'qwen')
    assert.equal(value.form, 'semi-chibi')
    assert.equal(value.ratio, '1:1')
    // `size` is the panel key the route expects, not a pixel size; what comes back is
    // `expected_pixels`. Sending pixels here would be a different request.
    assert.equal(value.size, '1:1')
    assert.equal(value.expected_pixels, '2048x2048')
    assert.equal(value.plan_id.length, 64)
    assert.match(value.prompt, /sitting on the floor eating a bowl of white rice, smiling/)
    assert.ok(value.blocks.some(block => block.name === 'scene'))
    assert.ok(value.confirmation.some(line => line.includes(value.plan_id)), 'the plan id is stated in full')
    assert.deepEqual(
      value.deliverable_ratios,
      ['7:4', '37:27', '1:1', '27:37', '4:7'],
      'the channel’s exact ratios are reported, not guessed',
    )
    assert.equal(existsSync(join(root, 'images')), false, 'a dry run writes no directory either')
  } finally {
    await host.close()
  }
})

test('image-tool: the plan id binds the prompt, the model and the size', () => {
  const parts = { model: 'qwen-image-3.0', size: '2048x2048', ratio: '1:1', count: 1, prompts: [{ name: 'image-01', prompt: 'p' }] }
  assert.equal(planDigest(parts), planDigest({ ...parts }))
  assert.notEqual(planDigest(parts), planDigest({ ...parts, prompts: [{ name: 'image-01', prompt: 'q' }] }))
  assert.notEqual(planDigest(parts), planDigest({ ...parts, model: 'qwen-image-max' }))
  assert.notEqual(planDigest(parts), planDigest({ ...parts, size: '1024x1024' }))
  assert.notEqual(planDigest(parts), planDigest({ ...parts, count: 2 }))
})

test('image-tool: a changed description plans to a different id', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-id-'))
  try {
    const first = await imageRun({ prompt: 'a whale-chan waving' }, deps(host.base, root))
    const again = await imageRun({ prompt: 'a whale-chan waving' }, deps(host.base, root))
    const other = await imageRun({ prompt: 'a whale-chan sleeping' }, deps(host.base, root))
    assert.equal(first.plan_id, again.plan_id)
    assert.notEqual(first.plan_id, other.plan_id)
  } finally {
    await host.close()
  }
})

test('image-tool: confirming without the plan id is refused, and hands the id back', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-noplan-'))
  try {
    const plan = await imageRun({ prompt: 'a whale-chan waving' }, deps(host.base, root))
    await assert.rejects(
      () => imageRun({ prompt: 'a whale-chan waving', confirm: true }, deps(host.base, root)),
      (error: unknown) => error instanceof WhalechanError
        && error.category === 'capability'
        && error.message.includes(plan.plan_id)
        && /Nothing has been spent/.test(error.message),
    )
    assert.equal(host.bodies().length, 0)
  } finally {
    await host.close()
  }
})

test('image-tool: a plan id from a different request is refused before the wire', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-mismatch-'))
  try {
    const plan = await imageRun({ prompt: 'a whale-chan waving' }, deps(host.base, root))
    await assert.rejects(
      () => imageRun({ prompt: 'a whale-chan sleeping', confirm: true, plan_id: plan.plan_id }, deps(host.base, root)),
      (error: unknown) => error instanceof WhalechanError
        && /does not match the request that would be sent/.test(error.message),
    )
    assert.equal(host.bodies().length, 0, 'a mismatched plan must not spend')
    assert.equal(existsSync(join(root, 'images')), false)
  } finally {
    await host.close()
  }
})

test('image-tool: a confirmed call draws the image, writes it, and writes its sidecar', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-draw-'))
  try {
    const plan = await imageRun({ prompt: 'sitting on the floor eating a bowl of white rice' }, deps(host.base, root))
    const value = await imageRun(
      { prompt: 'sitting on the floor eating a bowl of white rice', confirm: true, plan_id: plan.plan_id },
      deps(host.base, root),
    )
    assert.equal(value.dry_run, false)
    assert.equal(value.images.length, 1)
    const image = value.images[0]!
    assert.ok(existsSync(image.path), image.path)
    assert.equal(image.media_type, 'image/webp')
    assert.equal(image.bytes, WEBP.byteLength)
    assert.equal(image.sha256, createHash('sha256').update(readFileSync(image.path)).digest('hex'))
    assert.equal(image.path.includes('semi-chibi'), true, 'the file name records the form')
    const sidecar = JSON.parse(readFileSync(`${image.path}.json`, 'utf8')) as Record<string, unknown>
    assert.equal(sidecar['prompt'], plan.prompt)
    assert.equal(sidecar['plan_id'], plan.plan_id)
    assert.equal(sidecar['model'], 'qwen-image-3.0')

    // What actually went on the wire: the compiled prompt, the anchor as a data URL,
    // and the geometry the plan promised.
    const sent = host.bodies()[0]!
    assert.equal(sent['prompt'], plan.prompt)
    assert.equal(sent['model'], 'qwen-image-3.0')
    assert.equal(sent['size'], plan.size)
    assert.equal(sent['n'], 1)
    assert.equal(sent['mode'], 'edit')
    assert.match(String(sent['image']), /^data:image\/webp;base64,/)
  } finally {
    await host.close()
  }
})

test('image-tool: a count of two is two generations and two files', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-count-'))
  try {
    const plan = await imageRun({ prompt: 'a whale-chan waving', count: 2 }, deps(host.base, root))
    assert.equal(plan.count, 2)
    const value = await imageRun({ prompt: 'a whale-chan waving', count: 2, confirm: true, plan_id: plan.plan_id }, deps(host.base, root))
    assert.equal(host.bodies().length, 2)
    assert.equal(value.images.length, 2)
    assert.deepEqual(readdirSync(join(root, 'images')).filter(name => name.endsWith('.webp')).length, 2)
  } finally {
    await host.close()
  }
})

test('image-tool: a ratio the channel cannot deliver is refused, naming the ones it can', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-ratio-'))
  try {
    // The refusal comes from the geometry table, which owns the answer, and it names
    // both the exact alternatives and the nearest size rather than just saying no.
    await assert.rejects(
      () => imageRun({ prompt: 'a whale-chan waving', ratio: '16:9' }, deps(host.base, root)),
      (error: unknown) => error instanceof WhalechanError
        && error.category === 'capability'
        && /cannot be delivered exactly/.test(error.message)
        && error.message.includes('7:4, 37:27, 1:1, 27:37, 4:7'),
    )
    assert.equal(host.bodies().length, 0)
  } finally {
    await host.close()
  }
})

test('image-tool: a refusal from the host surfaces with its category and writes nothing', async () => {
  for (const [payload, category] of [
    [{ ok: false, code: 'bad-request', message: 'blocked by content policy' }, 'safety_rejection'],
    [{ ok: false, code: 'edit-unsupported', message: 'no reference images on this model' }, 'capability'],
    [{ ok: false, code: 'whatever', message: 'it broke' }, 'service'],
  ] as const) {
    const host = await fakeImagegen(payload)
    const root = mkdtempSync(join(tmpdir(), 'whalechan-image-refused-'))
    try {
      const prompt = 'a whale-chan waving'
      const plan = await imageRun({ prompt }, deps(host.base, root))
      await assert.rejects(
        () => imageRun({ prompt, confirm: true, plan_id: plan.plan_id }, deps(host.base, root)),
        (error: unknown) => error instanceof WhalechanError && error.category === category,
      )
      assert.equal(existsSync(join(root, 'images')), false, 'a refused draw leaves nothing behind')
    } finally {
      await host.close()
    }
  }
})

test('image-tool: a drawn image is declared as a deliverable, and the call says one line', async () => {
  const host = await fakeImagegen()
  const seam = deliverySeam()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-deliver-'))
  try {
    const prompt = 'sitting on the floor eating a bowl of white rice'
    const plan = await imageRun({ prompt }, deps(host.base, root, {}, seam.deliver))
    assert.equal(plan.delivered, 0, 'a dry run delivers nothing')
    assert.equal(seam.calls().length, 0, 'a dry run must not touch the session')

    const value = await imageRun(
      { prompt, confirm: true, plan_id: plan.plan_id },
      deps(host.base, root, {}, seam.deliver),
      { callId: 'call-1', agent: { session: {} } },
    )
    assert.equal(value.delivery_error, '')
    assert.equal(value.delivered, 1)

    // Exactly one declaration, naming exactly the file that was written.
    assert.equal(seam.calls().length, 1)
    const declared = seam.calls()[0]!
    assert.equal(declared.length, 1)
    assert.equal(declared[0]!.path, value.images[0]!.path)
    assert.match(declared[0]!.description, /semi-chibi/)
    assert.match(declared[0]!.description, /qwen-image-3\.0/)
    // The client strips a trailing parenthetical from a description, so none is written.
    assert.equal(/[（(][^）)]*[）)]\s*$/.test(declared[0]!.description), false)

    // …and the model-facing text still names no file.
    const text = renderImage(value)
    assert.equal(text.includes(value.images[0]!.path), false, text)
    assert.ok(text.length <= 220, text)
  } finally {
    await host.close()
  }
})

test('image-tool: a session that refuses the delivery does not lose the image', async () => {
  // The money is already spent by the time the seam is called. Failing the call there
  // would turn "the session would not take it" into "there is no picture", which is
  // false — the bytes are on disk and the user paid for them.
  const host = await fakeImagegen()
  const seam = deliverySeam('session is read-only')
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-nodeliver-'))
  try {
    const prompt = 'a whale-chan waving'
    const plan = await imageRun({ prompt }, deps(host.base, root, {}, seam.deliver))
    const value = await imageRun(
      { prompt, confirm: true, plan_id: plan.plan_id },
      deps(host.base, root, {}, seam.deliver),
      { callId: 'call-1', agent: { session: {} } },
    )
    assert.equal(value.dry_run, false)
    assert.equal(value.images.length, 1)
    assert.ok(existsSync(value.images[0]!.path), 'the drawn file survives a refused delivery')
    assert.equal(value.delivered, 0)
    assert.match(value.delivery_error, /read-only/)
    assert.ok(renderImage(value).includes(value.images[0]!.path), 'the fallback has to name the file')
  } finally {
    await host.close()
  }
})

test('image-tool: a host with no delivery seam at all still draws, and says where the file is', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-noseam-'))
  try {
    const prompt = 'a whale-chan waving'
    const bare = deps(host.base, root)
    delete (bare as { deliver?: unknown }).deliver
    const plan = await imageRun({ prompt }, bare)
    const value = await imageRun({ prompt, confirm: true, plan_id: plan.plan_id }, bare)
    assert.equal(value.images.length, 1)
    assert.match(value.delivery_error, /no delivery seam/)
    assert.ok(renderImage(value).includes(value.images[0]!.path))
  } finally {
    await host.close()
  }
})

test('image-tool: a seam that throws is reported, never escalated into a failed draw', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-seamthrow-'))
  try {
    const prompt = 'a whale-chan waving'
    const throwing = deps(host.base, root, {}, async () => {
      throw new Error('the appender exploded')
    })
    const plan = await imageRun({ prompt }, throwing)
    const value = await imageRun({ prompt, confirm: true, plan_id: plan.plan_id }, throwing, { callId: 'c', agent: { session: {} } })
    assert.equal(value.images.length, 1)
    assert.match(value.delivery_error, /appender exploded/)
  } finally {
    await host.close()
  }
})

test('image-tool: a disabled plugin refuses before it compiles anything', async () => {
  const host = await fakeImagegen()
  const root = mkdtempSync(join(tmpdir(), 'whalechan-image-off-'))
  try {
    await assert.rejects(
      () => imageRun({ prompt: 'a whale-chan waving' }, deps(host.base, root, { enabled: false })),
      /disabled in its settings/,
    )
  } finally {
    await host.close()
  }
})

test('image-tool: the tool is registered under one name, with one required argument', () => {
  const definitions: Array<Record<string, unknown>> = []
  const ctx = {
    tools: { register: (definition: Record<string, unknown>) => { definitions.push(definition); return () => {} } },
  } as unknown as Context
  registerImageTool(ctx, deps('http://127.0.0.1:1', tmpdir()))
  assert.equal(definitions.length, 1)
  assert.equal(definitions[0]!['name'], IMAGE_TOOL_NAME)
  assert.equal(IMAGE_TOOL_NAME, 'whalechan_image')
  const parameters = definitions[0]!['parameters'] as { required: string[]; properties: Record<string, unknown> }
  assert.deepEqual([...parameters.required], ['prompt'])
  assert.deepEqual(
    Object.keys(parameters.properties).sort(),
    ['confirm', 'count', 'form', 'model', 'plan_id', 'prompt', 'ratio'],
  )
  const output = definitions[0]!['output'] as { schema: Record<string, unknown>; render: unknown }
  assert.equal(typeof output.render, 'function')
  assert.equal(typeof definitions[0]!['execute'], 'function')
})
