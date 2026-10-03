/**
 * Reading image headers, checked against the tool the oracle actually calls.
 *
 * `identify_reference` in the vendored engine shells out to ImageMagick for
 * `%m|%w|%h|%[colorspace]`. This reader replaces that for the plan path, so the
 * bar is exact agreement with what ImageMagick reports — verified through the
 * Pillow stand-in on every asset the plugin ships, plus a synthetic file per
 * container and channel layout that matters.
 *
 * The real assets are the ones that count: they are what a run actually
 * dispatches, and they are the only inputs whose headers nobody chose to make
 * convenient.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { WhalechanError } from '../src/domain/errors.ts'
import { readImageHeader, type ImageHeader } from '../src/domain/image-header.ts'
import { VENDOR_ROOT } from '../src/run/vendor.ts'
import { oracleSkip, runPythonSnippet } from './support/oracle.ts'

const skip = oracleSkip()
const SCRATCH = mkdtempSync(join(tmpdir(), 'whalechan-header-'))

/** One `magick identify` call, through the same stand-in the oracle uses. */
const IDENTIFY_SNIPPET = [
  'import json, sys',
  'import oracle_bootstrap, magick_shim',
  'result = magick_shim.invoke(["identify", "-quiet", "-format", "%m|%w|%h|%[colorspace]", sys.argv[1]])',
  'print(json.dumps({"code": result.code, "out": result.stdout, "err": result.stderr}))',
].join('\n')

/** What the vendored engine's own reference check would report. */
function oracleHeader(path: string): ImageHeader {
  const outcome = runPythonSnippet(IDENTIFY_SNIPPET, [path])
  assert.equal(outcome.ok, true, `identify failed to run: ${outcome.ok ? '' : outcome.error}`)
  const parsed = JSON.parse(outcome.stdout) as { code: number; out: string; err: string }
  assert.equal(parsed.code, 0, `identify refused ${path}: ${parsed.err}`)
  const [format = '', width = '0', height = '0', colorspace = ''] = parsed.out.trim().split('|')
  return { format, width: Number(width), height: Number(height), colorspace }
}

/** Every image file the plugin ships under a vendored tree. */
function vendoredImages(): string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(webp|png|jpe?g|gif)$/i.test(entry)) found.push(path)
    }
  }
  walk(VENDOR_ROOT)
  return found.sort()
}

test('image-header: every shipped asset reads exactly as ImageMagick reads it', { skip }, async t => {
  const images = vendoredImages()
  // The shipped references are the ones that count: they are what a run actually
  // dispatches, and nobody chose their headers to be convenient. The bar is set
  // below what the tree actually carries, because all it has to do is keep this
  // sweep from going vacuous.
  assert.ok(images.length >= 10, `expected the vendored tree to ship reference images, found ${images.length}`)

  const kinds = new Map<string, number>()
  for (const path of images) {
    const expected = oracleHeader(path)
    const actual = readImageHeader(path)
    const label = `${relative(VENDOR_ROOT, path).split(sep).join('/')}`
    kinds.set(expected.format, (kinds.get(expected.format) ?? 0) + 1)
    await t.test(label, () => {
      assert.deepEqual({ ...actual }, { ...expected }, `${label}: header drift`)
    })
  }
  // Every shipped asset is WebP today; the synthetic suite covers the rest. Pinned
  // so that a format appearing here without being noticed is itself a failure.
  assert.deepEqual([...kinds.keys()], ['WEBP'], 'the shipped reference format changed')
  assert.equal(kinds.get('WEBP'), images.length)
})

test('image-header: synthetic files cover every container and channel layout', { skip }, async t => {
  const directory = join(SCRATCH, 'synthetic')
  mkdirSync(directory, { recursive: true })
  const generated = runPythonSnippet([
    'import json, os, sys',
    'from PIL import Image',
    'out = sys.argv[1]',
    'made = []',
    'def save(image, name, **options):',
    '    path = os.path.join(out, name)',
    '    image.save(path, **options)',
    '    made.append(path)',
    'save(Image.new("RGB", (37, 19), (10, 20, 30)), "rgb.png")',
    'save(Image.new("RGBA", (11, 13), (10, 20, 30, 128)), "rgba.png")',
    'save(Image.new("L", (7, 5), 128), "gray.png")',
    'save(Image.new("LA", (9, 4), (128, 200)), "graya.png")',
    'save(Image.new("P", (5, 3)), "palette.png")',
    'save(Image.new("L", (13, 7), 200), "gray.jpg", quality=90)',
    'save(Image.new("RGB", (23, 17), (1, 2, 3)), "photo.jpg", quality=80)',
    'save(Image.new("CMYK", (3, 2), (0, 0, 0, 0)), "cmyk.jpg", quality=90)',
    'save(Image.new("RGB", (29, 31), (4, 5, 6)), "lossy.webp", lossless=False)',
    'save(Image.new("RGBA", (13, 17), (4, 5, 6, 100)), "alpha.webp", lossless=False)',
    'save(Image.new("RGB", (41, 43), (7, 8, 9)), "lossless.webp", lossless=True)',
    'save(Image.new("P", (15, 11)), "still.gif")',
    'print(json.dumps(made))',
  ].join('\n'), [directory])
  assert.equal(generated.ok, true, `could not build the fixtures: ${generated.ok ? '' : generated.error}`)
  const paths = JSON.parse(generated.stdout) as string[]
  assert.equal(paths.length, 12)

  const seen = new Set<string>()
  for (const path of paths) {
    const expected = oracleHeader(path)
    const actual = readImageHeader(path)
    const label = path.split(/[\\/]/).pop()!
    seen.add(expected.format)
    await t.test(label, () => {
      assert.deepEqual({ ...actual }, { ...expected }, `${label}: header drift`)
    })
  }
  for (const format of ['PNG', 'JPEG', 'WEBP', 'GIF']) {
    assert.ok(seen.has(format), `${format} was never exercised`)
  }
})

test('image-header: the header is read without decoding the pixels', { skip }, () => {
  // Sizes here are far larger than the header window only in principle; the point
  // of the assertion is that the values come from the header, not from a decode.
  const path = join(VENDOR_ROOT, 'whalechan-image-character', 'assets', 'reference-images', 'standard', '01_gentle_wave.webp')
  const header = readImageHeader(path)
  assert.equal(header.format, 'WEBP')
  assert.ok(header.width > 0 && header.height > 0)
  assert.equal(header.colorspace, 'sRGB')
})

test('NEGATIVE: a file whose container is not parsed is refused by name', { skip }, () => {
  const cases: ReadonlyArray<readonly [string, Buffer, RegExp]> = [
    ['not-an-image', Buffer.from('this is plainly not an image at all'), /signature matches no supported container/],
    ['truncated', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), /too short to hold an IHDR|too short to identify/],
    ['png-wrong-first-chunk', Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]),
      Buffer.from('IDAT'),
      Buffer.alloc(16),
    ]), /first PNG chunk is not IHDR/],
  ]
  for (const [name, bytes, pattern] of cases) {
    const path = join(SCRATCH, `${name}.bin`)
    writeFileSync(path, bytes)
    assert.throws(
      () => readImageHeader(path),
      (error: unknown) => error instanceof WhalechanError && pattern.test(error.message),
      `${name}: wrong rejection`,
    )
  }
})

test('NEGATIVE: a missing file says so rather than claiming a bad format', { skip }, () => {
  assert.throws(
    () => readImageHeader(join(SCRATCH, 'no-such-file.webp')),
    (error: unknown) => error instanceof WhalechanError
      && error.category === 'unavailable'
      && /could not read/.test(error.message),
  )
})
