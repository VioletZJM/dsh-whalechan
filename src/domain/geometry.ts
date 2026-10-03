/**
 * Aspect-ratio → deliverable-geometry resolution.
 *
 * The single most important idea here: **trust the pixels, never the panel key
 * name.** The dsh-imagegen plugin's own ratio keys are sloppy — its `3:4` key
 * maps to 1024×1536, which is actually 2:3 (an 11 % deviation) — so a driver
 * that freezes "3:4" because the key says so records a ratio the channel never
 * delivered. Labels below are always derived from the mapped pixel geometry.
 */
import { WhalechanError } from './errors.ts'
import {
  channelFamily,
  isVersionedQwen,
  promptLimit,
  referencesSupported,
  transparencySupported,
  type ChannelFamily,
} from './family.ts'

/** How far a channel's mapped geometry may sit from the frozen ratio. */
export const RATIO_DEVIATION_LIMIT = 0.005

/**
 * Panel-ratio → pixels for OpenAI-shaped channels. 智谱 and the OpenAI families
 * all fall through to this table in the plugin.
 */
export const OPENAI_SIZE_BY_RATIO: Readonly<Record<string, string>> = {
  '1:1': '1024x1024',
  '3:4': '1024x1536',
  '4:3': '1536x1024',
  '9:16': '1024x1792',
  '2:3': '1024x1536',
  '3:2': '1536x1024',
  '16:9': '1792x1024',
  '21:9': '1792x1024',
}

/** DashScope size vocabulary for the classic Qwen-Image tier. */
export const QWEN_CLASSIC_SIZES: Readonly<Record<string, string>> = {
  '16:9': '1664*928',
  '21:9': '1664*928',
  '4:3': '1472*1104',
  '3:2': '1472*1104',
  '1:1': '1328*1328',
  '3:4': '1104*1472',
  '2:3': '1104*1472',
  '9:16': '928*1664',
}

/** DashScope size vocabulary for the versioned Qwen-Image tier. */
export const QWEN_HD_SIZES: Readonly<Record<string, string>> = {
  '16:9': '2688*1536',
  '21:9': '2688*1536',
  '4:3': '2368*1728',
  '3:2': '2368*1728',
  '1:1': '2048*2048',
  '3:4': '1728*2368',
  '2:3': '1728*2368',
  '9:16': '1536*2688',
}

/** Families that dial the ratio natively and let the provider choose pixels. */
export const NATIVE_RATIO_FAMILIES: ReadonlySet<ChannelFamily> = new Set(['grok', 'nanobanana', 'minimax'])

/** The only ratios MiniMax's native API accepts. */
export const MINIMAX_RATIOS: readonly string[] = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9']

/** Greatest common divisor; used to reduce a pixel pair to a `W:H` label. */
function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x
}

/** Split a `W:H` key or a `WxH` / `W*H` pixel string into two positive numbers. */
function pairOf(value: string): readonly [number, number] {
  const parts = value.trim().split(/[x*:]/)
  const width = Number(parts[0])
  const height = Number(parts[1])
  if (parts.length !== 2 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new WhalechanError(`cannot read a WIDTH:HEIGHT ratio from ${JSON.stringify(value)}`, 'capability')
  }
  return [width, height]
}

/** Aspect ratio of either a `W:H` key or a `WxH` / `W*H` pixel string. */
export function ratioOf(value: string): number {
  const [width, height] = pairOf(value)
  return width / height
}

/** The exact aspect ratio of a pixel string, as a reduced `W:H` label. */
export function ratioLabel(pixels: string): string {
  const [width, height] = pairOf(pixels)
  const divisor = gcd(width, height) || 1
  return `${width / divisor}:${height / divisor}`
}

/** Ratio → pixels for families whose plugin path sends explicit pixels. */
export function geometryTable(family: ChannelFamily, model: string): Readonly<Record<string, string>> | null {
  if (family === 'zhipu' || family === 'gpt-image' || family === 'dall-e' || family === 'unknown') {
    return OPENAI_SIZE_BY_RATIO
  }
  if (family === 'qwen') return isVersionedQwen(model) ? QWEN_HD_SIZES : QWEN_CLASSIC_SIZES
  return null
}

/**
 * Every ratio this channel delivers exactly, or `null` when the channel does
 * not choose geometry at all.
 *
 * `null` means either "the provider decides" (Seedream's resolution tiers) or
 * "the panel ratio passes through untouched" (the native-dial families).
 */
export function deliverableRatios(family: ChannelFamily, model: string): string[] | null {
  if (family === 'minimax') return [...MINIMAX_RATIOS]
  if (NATIVE_RATIO_FAMILIES.has(family)) return null
  const table = geometryTable(family, model)
  if (table === null) return null
  const labels: string[] = []
  for (const pixels of Object.values(table)) {
    const label = ratioLabel(pixels)
    if (!labels.includes(label)) labels.push(label)
  }
  return labels
}

/** Human-readable list of the ratios a table can honour, plus its nearest entry. */
export function describeDeliverables(table: Readonly<Record<string, string>> | null, requested: string): string {
  if (table === null) return 'any positive WIDTH:HEIGHT ratio (the provider picks the pixels)'
  const labels: string[] = []
  for (const pixels of Object.values(table)) {
    const label = ratioLabel(pixels)
    if (!labels.includes(label)) labels.push(label)
  }
  const wanted = ratioOf(requested)
  let nearest = ''
  let nearestDeviation = Number.POSITIVE_INFINITY
  for (const pixels of Object.values(table)) {
    const deviation = Math.abs(ratioOf(pixels) - wanted)
    if (deviation < nearestDeviation) {
      nearestDeviation = deviation
      nearest = pixels
    }
  }
  return `${labels.join(', ')} (nearest mapped geometry: ${nearest.replace('*', 'x')})`
}

/** What `resolveGeometry` decides: the panel key to send, and what to expect back. */
export interface Geometry {
  /** Ratio key sent to the plugin, or `null` when only a resolution tier is sent. */
  readonly sizeKey: string | null
  /** Pixels the channel is expected to return, or `null` when it decides. */
  readonly expectedPixels: string | null
  /** Whether the frozen ratio actually controls the output geometry. */
  readonly ratioControl: boolean
  /** Human-readable explanation recorded in the audit trail. */
  readonly note: string
}

/**
 * Resolve a frozen ratio into the geometry to request.
 * @throws WhalechanError with category `capability` when the channel cannot
 *   deliver that ratio within {@link RATIO_DEVIATION_LIMIT}.
 */
export function resolveGeometry(family: ChannelFamily, model: string, ratio: string): Geometry {
  if (NATIVE_RATIO_FAMILIES.has(family)) {
    if (family === 'minimax' && !MINIMAX_RATIOS.includes(ratio)) {
      throw new WhalechanError(
        `minimax accepts only ${MINIMAX_RATIOS.join(', ')}; ${ratio} is not one of them`,
        'capability',
      )
    }
    return {
      sizeKey: ratio,
      expectedPixels: null,
      ratioControl: true,
      note: 'the provider dials this ratio natively and chooses the pixel size',
    }
  }
  if (family === 'seedream') {
    return {
      sizeKey: null,
      expectedPixels: null,
      ratioControl: false,
      note: 'seedream receives a resolution tier only: the output ratio is provider-decided',
    }
  }
  const table = geometryTable(family, model)
  if (table === null) {
    throw new WhalechanError(`aspect_ratio ${ratio} cannot be resolved for the ${family} channel`, 'capability')
  }
  const wanted = ratioOf(ratio)
  let bestPixels: string | null = null
  let bestDeviation = Number.POSITIVE_INFINITY
  for (const pixels of Object.values(table)) {
    const deviation = Math.abs(ratioOf(pixels) - wanted) / wanted
    if (deviation <= RATIO_DEVIATION_LIMIT && deviation < bestDeviation) {
      bestDeviation = deviation
      bestPixels = pixels
    }
  }
  if (bestPixels === null) {
    throw new WhalechanError(
      `aspect_ratio ${ratio} cannot be delivered exactly by dsh-imagegen on ${family}: no entry of the ` +
        `channel's geometry table matches it. Freeze one of these instead — ${describeDeliverables(table, ratio)}`,
      'capability',
    )
  }
  const pixels = bestPixels.replace('*', 'x')
  // Several panel keys can share one geometry (both `3:4` and `2:3` map to
  // 1024x1536). Prefer the key that actually names the frozen ratio, so the
  // audit trail does not read as if a different ratio had been requested.
  const candidates = Object.keys(table).filter(key => table[key] === bestPixels)
  const exactNamed = candidates.filter(key => Math.abs(ratioOf(key) - wanted) / wanted <= RATIO_DEVIATION_LIMIT)
  const sizeKey = (exactNamed.length > 0 ? exactNamed : candidates)[0] ?? ''
  if (family === 'zhipu' && wanted === 1) {
    // 1:1 rides `auto` so upstream applies its own larger default instead of the
    // plugin's 1024-pixel mapping. Measured upstream result: 1280x1280.
    return {
      sizeKey: 'auto',
      expectedPixels: '1280x1280',
      ratioControl: true,
      note: 'sent as `auto`: upstream applies its own 1280x1280 default',
    }
  }
  return {
    sizeKey,
    expectedPixels: pixels,
    ratioControl: true,
    note: `the plugin maps panel key ${sizeKey} onto ${pixels} for this family`,
  }
}

/** What the configured channel can do, so a driver can configure itself. */
export interface ChannelReport {
  readonly ok: true
  readonly provider: 'dsh-imagegen'
  readonly model: string
  readonly channel_family: ChannelFamily
  readonly references_supported: boolean
  readonly transparency_supported: boolean
  readonly prompt_limit_chars: number
  readonly ratio_control: boolean
  readonly deliverable_ratios: string[] | null
  readonly recommended_reference_policy: 'agent-visual-only' | 'provider-edit'
}

/**
 * Capability probe: free, offline, and identical in meaning to the old
 * `generate-dsh-imagegen.py --print-family` report.
 * @throws WhalechanError when the alias matches no known family.
 */
export function channelReport(
  model: string,
  capabilities: {
    channelFamily: (alias: string) => ChannelFamily
    promptLimit: (family: ChannelFamily) => number
    referencesSupported: (family: ChannelFamily) => boolean
    transparencySupported: (family: ChannelFamily) => boolean
  } = { channelFamily, promptLimit, referencesSupported, transparencySupported },
): ChannelReport {
  const family = capabilities.channelFamily(model)
  if (family === 'unknown') {
    throw new WhalechanError(
      `cannot route model alias ${JSON.stringify(model)}: it matches no known protocol family. ` +
        'Use a real model id — never an `ep-...` endpoint id.',
      'capability',
    )
  }
  const ratios = deliverableRatios(family, model)
  return {
    ok: true,
    provider: 'dsh-imagegen',
    model,
    channel_family: family,
    references_supported: capabilities.referencesSupported(family),
    transparency_supported: capabilities.transparencySupported(family),
    prompt_limit_chars: capabilities.promptLimit(family),
    ratio_control: ratios !== null || NATIVE_RATIO_FAMILIES.has(family),
    deliverable_ratios: ratios,
    recommended_reference_policy: capabilities.referencesSupported(family) ? 'provider-edit' : 'agent-visual-only',
  }
}
