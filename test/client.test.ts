/**
 * The wire, against a local server that answers exactly what the route family does.
 *
 * The route is only reachable on loopback and the failure shapes are unusual — a
 * refusal comes back as **HTTP 200 with `ok: false`**, so a client that only looks at
 * the status code reports success and then fails somewhere else. Each of the four
 * ways this can fail is exercised here, plus the timeout and the unreachable host,
 * because those are the two that are hardest to reproduce by hand.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decodeImage,
  extensionOf,
  imageDataUrl,
  mimeOfFormat,
  requestImage,
  writeImage,
} from '../src/run/client.ts'
import { WhalechanError } from '../src/domain/errors.ts'
import { composeImages, loadCatalog } from '../src/domain/compose.ts'
import { CHARACTER_SKILL_ROOT } from '../src/run/vendor.ts'

/** The PNG signature, enough for the wire test to prove the bytes round-tripped. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** A server that answers one canned response, and records what it was sent. */
async function serve(
  reply: (body: unknown, res: ServerResponse) => void,
): Promise<{ base: string; received: () => unknown[]; close: () => Promise<void> }> {
  const seen: unknown[] = []
  const server: Server = createServer((request, res) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: unknown = undefined
      try {
        body = JSON.parse(raw)
      } catch {
        body = raw
      }
      seen.push({ url: request.url, method: request.method, contentType: request.headers['content-type'], body })
      reply(body, res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    base: `http://127.0.0.1:${port}`,
    received: () => seen,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

/** The smallest request that satisfies the route. */
const BODY = { prompt: 'a whale-chan', model: 'qwen-image-3.0', size: '2048x2048', n: 1, mode: 'text' } as const

test('client: a successful call posts the protocol body and returns the image', async () => {
  const server = await serve((_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, images: [{ b64: PNG_MAGIC.toString('base64'), mime: 'image/png' }] }))
  })
  try {
    const image = await requestImage(BODY, { base: server.base })
    const sent = server.received()[0] as { url: string; method: string; contentType: string; body: Record<string, unknown> }
    assert.equal(sent.method, 'POST')
    assert.equal(sent.url, '/api/dsh-imagegen/generate')
    assert.match(sent.contentType, /application\/json/)
    assert.deepEqual(sent.body, { ...BODY })
    assert.equal(image.mime, 'image/png')
    assert.deepEqual(decodeImage(image), PNG_MAGIC)
    assert.equal(extensionOf(decodeImage(image)), 'png')
  } finally {
    await server.close()
  }
})

test('client: a trailing slash on the base does not double the path', async () => {
  const server = await serve((_body, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, images: [{ b64: 'AA==', mime: 'image/png' }] }))
  })
  try {
    await requestImage(BODY, { base: `${server.base}/` })
    assert.equal((server.received()[0] as { url: string }).url, '/api/dsh-imagegen/generate')
  } finally {
    await server.close()
  }
})

/** Each refusal shape and the category it must produce. */
const REFUSALS: ReadonlyArray<readonly [string, unknown, string]> = [
  ['a capability code', { ok: false, code: 'edit-unsupported', message: 'this model takes no reference image' }, 'capability'],
  ['an unknown code', { ok: false, code: 'whatever', message: 'something went wrong' }, 'service'],
  ['an upstream timeout', { ok: false, code: 'upstream-timeout', message: 'the provider did not answer' }, 'timeout'],
  ['a moderation stop', { ok: false, code: 'bad-request', message: 'blocked by content policy' }, 'safety_rejection'],
  ['a Chinese moderation stop', { ok: false, code: 'bad-request', message: '内容违规，已被拒绝' }, 'safety_rejection'],
]

for (const [label, payload, category] of REFUSALS) {
  test(`client: ${label} on HTTP 200 is classified from the body, not the status`, async () => {
    // The route answers 200 even when it refuses; a client trusting the status code
    // would report an image and then fail to find one.
    const server = await serve((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
    try {
      await assert.rejects(
        () => requestImage(BODY, { base: server.base }),
        (error: unknown) => error instanceof WhalechanError && error.category === category,
      )
    } finally {
      await server.close()
    }
  })
}

test('client: an HTTP status the route should not use is still classified', async () => {
  for (const [status, category] of [[429, 'rate_limit'], [500, 'service'], [401, 'authentication'], [400, 'capability']] as const) {
    const server = await serve((_body, res) => {
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end('nope')
    })
    try {
      await assert.rejects(
        () => requestImage(BODY, { base: server.base }),
        (error: unknown) => error instanceof WhalechanError
          && error.category === category
          && error.message.includes(String(status)),
      )
    } finally {
      await server.close()
    }
  }
})

test('client: success without an image is a failure, not an empty result', async () => {
  for (const payload of [{ ok: true }, { ok: true, images: [] }, { ok: true, images: [{}] }, { ok: true, images: [{ b64: 7 }] }]) {
    const server = await serve((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    })
    try {
      await assert.rejects(
        () => requestImage(BODY, { base: server.base }),
        (error: unknown) => error instanceof WhalechanError && error.category === 'service',
      )
    } finally {
      await server.close()
    }
  }
})

test('client: a body that is not JSON, or not an object, is a service failure', async () => {
  for (const raw of ['<html>nope</html>', '[1,2,3]', '"a string"']) {
    const server = await serve((_body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(raw)
    })
    try {
      await assert.rejects(
        () => requestImage(BODY, { base: server.base }),
        (error: unknown) => error instanceof WhalechanError && error.category === 'service',
      )
    } finally {
      await server.close()
    }
  }
})

test('client: an empty base is refused before anything is sent', async () => {
  await assert.rejects(
    () => requestImage(BODY, { base: '   ' }),
    (error: unknown) => error instanceof WhalechanError
      && error.category === 'unavailable'
      && /could not be located/.test(error.message),
  )
})

test('client: a host that is not listening is unavailable, not a crash', async () => {
  const server = await serve((_body, res) => res.end('{}'))
  const base = server.base
  await server.close()
  await assert.rejects(
    () => requestImage(BODY, { base }),
    (error: unknown) => error instanceof WhalechanError && error.category === 'unavailable',
  )
})

test('client: a host that never answers times out with its own category', async () => {
  // The handler is never called back: the socket opens and stays silent, which is
  // what a wedged provider looks like from here.
  const server = await serve(() => {})
  try {
    await assert.rejects(
      () => requestImage(BODY, { base: server.base, timeoutMs: 150 }),
      (error: unknown) => error instanceof WhalechanError
        && error.category === 'timeout'
        && /timed out after 150ms/.test(error.message),
    )
  } finally {
    await server.close()
  }
})

test('client: the identity anchor travels as a data URL whose type comes from the file', () => {
  // The path comes from the catalogue, not from a guess: a hard-coded reference
  // filename is one `sync` away from being wrong, and this test would then fail for a
  // reason that has nothing to do with the client.
  const composed = composeImages({ prompt: 'a whale-chan sitting down' }, loadCatalog(CHARACTER_SKILL_ROOT), 1, CHARACTER_SKILL_ROOT)
  const url = imageDataUrl(composed.anchorPath)
  assert.match(url, /^data:image\/webp;base64,/)
  const payload = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
  assert.deepEqual(payload, readFileSync(composed.anchorPath), 'the payload must be the file, byte for byte')
  assert.equal(extensionOf(payload), 'webp')
})

test('client: an unreadable reference is refused before anything is spent', () => {
  assert.throws(
    () => imageDataUrl(join(tmpdir(), 'whalechan-no-such-reference.webp')),
    (error: unknown) => error instanceof WhalechanError
      && error.category === 'capability'
      && /cannot read the reference image/.test(error.message),
  )
})

test('client: the media type table covers what the catalogue ships', () => {
  assert.equal(mimeOfFormat('WEBP'), 'image/webp')
  assert.equal(mimeOfFormat('png'), 'image/png')
  assert.equal(mimeOfFormat('JPEG'), 'image/jpeg')
  assert.equal(mimeOfFormat('TIFF'), 'application/octet-stream')
})

test('client: writing an image refuses to clobber an existing one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'whalechan-client-'))
  const path = join(directory, 'image-01.png')
  writeImage(path, PNG_MAGIC)
  assert.ok(existsSync(path))
  assert.throws(() => writeImage(path, PNG_MAGIC), /refusing to overwrite/)
  // A plain file write is what makes that refusal real: nothing was truncated.
  assert.deepEqual(readFileSync(path), PNG_MAGIC)
  const other = join(directory, 'image-02.png')
  writeFileSync(join(directory, 'unrelated'), 'x', 'utf8')
  writeImage(other, PNG_MAGIC)
  assert.deepEqual(readFileSync(other), PNG_MAGIC)
})
