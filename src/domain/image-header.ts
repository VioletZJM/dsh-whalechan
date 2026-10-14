/**
 * Image headers, read directly.
 *
 * The plugin needs one thing from a reference image before spending: its format,
 * its pixel size, and its colour space. The oracle got those by shelling out to
 * ImageMagick, which DSH does not ship and which is therefore the one binary a
 * user would have to install themselves.
 *
 * Reading a header is not an image operation — nothing is decoded, resampled, or
 * measured — so doing it here removes that dependency from the plan path without
 * weakening the rule that pixel work belongs to Pillow (D1).
 *
 * Only the container headers are parsed: PNG `IHDR`, JPEG `SOF`, the three WEBP
 * chunk layouts, and the GIF screen descriptor. Everything else is refused by
 * name rather than guessed at.
 */
import { openSync, readSync, closeSync } from 'node:fs'
import { WhalechanError } from './errors.ts'

/** What a reference image's header tells us, in ImageMagick's vocabulary. */
export interface ImageHeader {
  /** ImageMagick's `%m`: `PNG`, `JPEG`, `WEBP`, `GIF`. */
  readonly format: string
  readonly width: number
  readonly height: number
  /** ImageMagick's `%[colorspace]`: `sRGB`, `Gray`, or `CMYK`. */
  readonly colorspace: string
}

/** How much of the file to read; JPEG metadata can push `SOF` a long way in. */
const HEADER_BYTES = 1024 * 1024

/** Read up to {@link HEADER_BYTES} from the file. */
function readHead(path: string): Buffer {
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const read = readSync(handle, buffer, 0, HEADER_BYTES, 0)
    return buffer.subarray(0, read)
  } finally {
    closeSync(handle)
  }
}

/** Refuse a file whose container we do not parse. */
function unsupported(path: string, detail: string): never {
  throw new WhalechanError(
    `${path} could not be read as an image header: ${detail}. dsh-whalechan reads PNG, JPEG, WebP and GIF `
      + 'headers directly; convert the reference to one of those formats.',
    'capability',
  )
}

/** The colour space ImageMagick reports for a PNG colour type. */
function pngColorspace(colorType: number): string {
  // 0 grey, 2 truecolour, 3 indexed, 4 grey+alpha, 6 truecolour+alpha.
  if (colorType === 0 || colorType === 4) return 'Gray'
  return 'sRGB'
}

/** Parse a PNG `IHDR`. */
function readPng(head: Buffer, path: string): ImageHeader {
  if (head.length < 26) unsupported(path, 'the PNG is too short to hold an IHDR')
  if (head.toString('latin1', 12, 16) !== 'IHDR') unsupported(path, 'the first PNG chunk is not IHDR')
  return {
    format: 'PNG',
    width: head.readUInt32BE(16),
    height: head.readUInt32BE(20),
    colorspace: pngColorspace(head.readUInt8(25)),
  }
}

/** JPEG start-of-frame markers, whose payload carries the dimensions. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

/** Walk JPEG segments to the first start-of-frame. */
function readJpeg(head: Buffer, path: string): ImageHeader {
  let offset = 2
  while (offset + 4 <= head.length) {
    if (head.readUInt8(offset) !== 0xff) {
      // Fill bytes are legal between segments; anything else means we lost the framing.
      offset += 1
      continue
    }
    const marker = head.readUInt8(offset + 1)
    if (marker === 0xff || marker === 0x00) {
      offset += 1
      continue
    }
    // Markers without a length payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2
      continue
    }
    const length = head.readUInt16BE(offset + 2)
    if (length < 2) unsupported(path, 'a JPEG segment declares an impossible length')
    if (JPEG_SOF.has(marker)) {
      if (offset + 9 > head.length) unsupported(path, 'the JPEG start-of-frame is truncated')
      const components = head.readUInt8(offset + 9)
      return {
        format: 'JPEG',
        height: head.readUInt16BE(offset + 5),
        width: head.readUInt16BE(offset + 7),
        colorspace: components === 1 ? 'Gray' : components === 4 ? 'CMYK' : 'sRGB',
      }
    }
    offset += 2 + length
  }
  unsupported(path, 'the JPEG has no start-of-frame before the header window ends')
}

/** The first WEBP chunk after the RIFF header. */
function readWebp(head: Buffer, path: string): ImageHeader {
  if (head.length < 30) unsupported(path, 'the WebP is too short')
  const fourCc = head.toString('latin1', 12, 16)
  if (fourCc === 'VP8X') {
    // Canvas size is stored minus one, as 24-bit little-endian.
    return {
      format: 'WEBP',
      width: (head.readUInt8(24) | (head.readUInt8(25) << 8) | (head.readUInt8(26) << 16)) + 1,
      height: (head.readUInt8(27) | (head.readUInt8(28) << 8) | (head.readUInt8(29) << 16)) + 1,
      colorspace: 'sRGB',
    }
  }
  if (fourCc === 'VP8 ') {
    // Lossy: a 3-byte frame tag, then the 0x9d012a start code, then 14-bit dimensions.
    if (head.readUInt8(23) !== 0x9d || head.readUInt8(24) !== 0x01 || head.readUInt8(25) !== 0x2a) {
      unsupported(path, 'the WebP lossy frame header is missing its start code')
    }
    return {
      format: 'WEBP',
      width: head.readUInt16LE(26) & 0x3fff,
      height: head.readUInt16LE(28) & 0x3fff,
      colorspace: 'sRGB',
    }
  }
  if (fourCc === 'VP8L') {
    // Lossless: after the 0x2f signature, 14 bits of width-1 then 14 bits of height-1.
    if (head.readUInt8(20) !== 0x2f) unsupported(path, 'the WebP lossless stream has no signature')
    const bits = head.readUInt32LE(21)
    return {
      format: 'WEBP',
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      colorspace: 'sRGB',
    }
  }
  unsupported(path, `unrecognised WebP chunk ${JSON.stringify(fourCc)}`)
}

/** Parse the GIF logical screen descriptor. */
function readGif(head: Buffer, path: string): ImageHeader {
  if (head.length < 10) unsupported(path, 'the GIF is too short to hold a screen descriptor')
  return {
    format: 'GIF',
    width: head.readUInt16LE(6),
    height: head.readUInt16LE(8),
    colorspace: 'sRGB',
  }
}

/**
 * Read one image's header.
 * @param path - absolute path of the image.
 * @returns the format, pixel size, and colour space ImageMagick would report.
 */
export function readImageHeader(path: string): ImageHeader {
  let head: Buffer
  try {
    head = readHead(path)
  } catch (error) {
    throw new WhalechanError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'unavailable',
    )
  }
  if (head.length < 12) unsupported(path, 'the file is too short to identify')
  if (head.readUInt32BE(0) === 0x89504e47) return readPng(head, path)
  if (head.readUInt16BE(0) === 0xffd8) return readJpeg(head, path)
  if (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
    return readWebp(head, path)
  }
  const gif = head.toString('latin1', 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') return readGif(head, path)
  unsupported(path, 'the signature matches no supported container')
}

/**
 * {@link readImageHeader} shaped as the assignment validator's `identify` dependency.
 *
 * Async only to match the seam; nothing here awaits. Passing this to
 * `validateAssignment` is what lets a plan run with no Python process and no
 * ImageMagick.
 * @param path - absolute path of the reference image.
 * @returns the format, pixel size, and colour space.
 */
export async function identifyImage(path: string): Promise<ImageHeader> {
  return readImageHeader(path)
}
