/**
 * The wire: one prompt in, one image out, from this process.
 *
 * Until v0.3 this went through the vendored `generate-dsh-imagegen.py` — a Python
 * interpreter, a subprocess, a Pillow stand-in and an encoding dance to do what the
 * adapter itself does in thirty lines: POST a JSON body and decode a base64 image.
 * The spawn was not the measured cost (§68: 55.7 s was the provider, and the whole
 * plugin was 6.7% of the run), but it was the reason the plugin could not stand on
 * its own, and the reason a 1.7 MB engine had to ship with it.
 *
 * The protocol is taken from that adapter, which is the frozen record of it:
 *
 * ```
 * POST {base}/api/dsh-imagegen/generate
 *   { prompt, model, size, n, mode: 'text' | 'edit', image?, images? }
 *   -> { ok: true, images: [{ b64, mime }] }
 *   -> { ok: false, code, message }
 * ```
 *
 * Two details the route family makes easy to get wrong, both inherited deliberately:
 * a failure is answered with **HTTP 200** and `ok: false`, so the status code alone
 * says nothing; and the references travel as data URLs, so a file that cannot be read
 * is a failure before anything is spent.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { WhalechanError, classifyEndpointError, classifyHttp } from '../domain/errors.ts'
import { readImageHeader } from '../domain/image-header.ts'
import { IMAGEGEN_GENERATE_PATH, joinUrl } from './endpoint.ts'

/** The request body the route consumes. */
export interface GenerateWireRequest {
  readonly prompt: string
  readonly model: string
  readonly size: string
  readonly n: number
  readonly mode: 'text' | 'edit'
  /** The primary reference, as a data URL; required in `edit` mode. */
  readonly image?: string | undefined
  /** Any further references, as data URLs. */
  readonly images?: readonly string[] | undefined
}

/** One image as the route returns it. */
export interface GenerateWireImage {
  readonly b64: string
  readonly mime: string
}

/** How to reach the host, and how long to wait. */
export interface ClientOptions {
  /** The dsh-imagegen base URL **this process** resolved. Never from the environment. */
  readonly base: string
  /** Milliseconds before the request is abandoned. */
  readonly timeoutMs?: number
  /** Injected for tests; the platform fetch by default. */
  readonly fetchImpl?: typeof fetch | undefined
}

/** The default timeout: a provider round trip is tens of seconds, not minutes. */
export const DEFAULT_TIMEOUT_MS = 180_000

/**
 * Read a reference image as a data URL.
 *
 * The media type comes from the file's own header rather than its extension: the
 * vendored anchors are `.webp`, but a caller-supplied reference can be anything, and
 * a mislabelled data URL is refused by the provider with a message about the image
 * rather than about the label.
 * @param path - absolute path of the reference.
 * @returns `data:<mime>;base64,<payload>`.
 * @throws WhalechanError with category `capability` when the file cannot be read.
 */
export function imageDataUrl(path: string): string {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch (error) {
    throw new WhalechanError(
      `cannot read the reference image ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'capability',
    )
  }
  let mime = 'application/octet-stream'
  try {
    mime = mimeOfFormat(readImageHeader(path).format)
  } catch {
    // An unreadable header is not fatal here: the provider will refuse a payload it
    // cannot decode, and that refusal names the image rather than the container.
  }
  return `data:${mime};base64,${bytes.toString('base64')}`
}

/** Map a header's format name onto a media type. */
export function mimeOfFormat(format: string): string {
  switch (format.trim().toUpperCase()) {
    case 'PNG': return 'image/png'
    case 'JPEG':
    case 'JPG': return 'image/jpeg'
    case 'WEBP': return 'image/webp'
    case 'GIF': return 'image/gif'
    default: return 'application/octet-stream'
  }
}

/** Decode the base64 a response carries. */
export function decodeImage(image: GenerateWireImage): Buffer {
  const bytes = Buffer.from(image.b64, 'base64')
  if (bytes.byteLength === 0) {
    throw new WhalechanError('the image endpoint reported an image with an empty payload', 'service')
  }
  return bytes
}

/**
 * Choose a file extension from the bytes, not from the declared media type.
 *
 * The provider's own label has been wrong before, and a `.png` file holding a WebP
 * is the kind of thing that is discovered much later.
 * @param bytes - the decoded payload.
 * @returns the extension without a dot.
 */
export function extensionOf(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg'
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'gif'
  return 'bin'
}

/** Write one decoded image, refusing to clobber a file that is already there. */
export function writeImage(path: string, bytes: Buffer): void {
  try {
    writeFileSync(path, bytes, { flag: 'wx' })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'EEXIST') {
      throw new WhalechanError(`refusing to overwrite an existing image: ${path}`, 'capability')
    }
    throw new WhalechanError(
      `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'service',
    )
  }
}

/**
 * Ask the host for one image.
 * @param body - the request, already shaped.
 * @param options - the resolved base URL and timeout.
 * @returns the decoded-able image payload.
 * @throws WhalechanError classified from the status, the body, or the transport.
 */
export async function requestImage(
  body: GenerateWireRequest,
  options: ClientOptions,
): Promise<GenerateWireImage> {
  const base = options.base.trim().replace(/\/+$/, '')
  if (base === '') {
    throw new WhalechanError(
      'Refusing to generate: the dsh-imagegen host could not be located from this process, and falling back to '
        + 'DSH_WEB_URL could send the request to a different host\'s channel and spend its quota. Start the run '
        + 'inside the DSH host, or set imagegenBaseUrl.',
      'unavailable',
    )
  }
  const endpoint = joinUrl(base, IMAGEGEN_GENERATE_PATH)
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let response: Response
  try {
    response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new WhalechanError(`the image endpoint timed out after ${timeoutMs}ms`, 'timeout')
    }
    throw new WhalechanError(
      `cannot reach the image endpoint ${endpoint}: ${error instanceof Error ? error.message : String(error)}. `
        + 'The host may have stopped, or imagegenBaseUrl may name the wrong port.',
      'unavailable',
    )
  }

  const text = await response.text()
  if (!response.ok) {
    throw new WhalechanError(
      `the image endpoint returned HTTP ${response.status}${text === '' ? '' : `: ${text.slice(0, 300)}`}`,
      classifyHttp(response.status),
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new WhalechanError(
      `the image endpoint returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      'service',
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new WhalechanError('the image endpoint returned a non-object payload', 'service')
  }
  const record = parsed as Record<string, unknown>
  if (record['ok'] !== true) {
    const code = typeof record['code'] === 'string' ? record['code'] : ''
    const message = typeof record['message'] === 'string'
      ? record['message']
      : 'the image endpoint refused the request'
    throw new WhalechanError(message, classifyEndpointError(code, message))
  }
  const images = record['images']
  if (!Array.isArray(images) || images.length === 0) {
    throw new WhalechanError('the image endpoint reported success without any image', 'service')
  }
  const first = images[0] as Record<string, unknown>
  if (typeof first !== 'object' || first === null || typeof first['b64'] !== 'string') {
    throw new WhalechanError('the image endpoint returned a malformed image payload', 'service')
  }
  return { b64: first['b64'], mime: typeof first['mime'] === 'string' ? first['mime'] : '' }
}
