/**
 * The one boundary to the dsh-imagegen plugin: its published loopback route
 * family. Nothing here imports that package's internals.
 */
import { classifyEndpointError, classifyHttp, WhalechanError } from '../domain/errors.ts'
import { IMAGEGEN_SETTINGS_DESCRIBE_PATH, joinUrl, resolveImagegenBase, type EndpointSources } from './endpoint.ts'

/** One image model alias and the channel that hosts it. */
export interface ModelEntry {
  readonly alias: string
  readonly channelId: string
  readonly channelName: string
}

/** The slice of the imagegen settings view this plugin may look at. */
export interface ImagegenSettingsView {
  readonly defaultModel: string
  readonly defaultChannelId: string
  readonly models: readonly ModelEntry[]
}

/**
 * Narrow the imagegen settings descriptor to what this plugin needs.
 *
 * The raw response also carries `channelSecrets` and a `secrets` index. Both are
 * dropped here on purpose: nothing downstream — not a tool result, not a log,
 * not the run directory — may ever hold an imagegen API key.
 */
export function readSettingsView(body: unknown): ImagegenSettingsView {
  const namespaces = readPath(body, ['value', 'namespaces'])
  if (!Array.isArray(namespaces) || namespaces.length === 0) {
    throw new WhalechanError('The dsh-imagegen settings view has no namespaces; is the plugin enabled?', 'service')
  }
  const namespace = namespaces[0] as Record<string, unknown>
  const value = readPath(namespace, ['value'])
  if (!isRecord(value)) {
    throw new WhalechanError('The dsh-imagegen settings view has no value block.', 'service')
  }
  const models: ModelEntry[] = []
  const channels = Array.isArray(value['channels']) ? value['channels'] : []
  for (const channel of channels) {
    if (!isRecord(channel)) continue
    const channelId = typeof channel['id'] === 'string' ? channel['id'] : ''
    const channelName = typeof channel['name'] === 'string' ? channel['name'] : ''
    const catalog = Array.isArray(channel['models']) ? channel['models'] : []
    for (const model of catalog) {
      if (!isRecord(model)) continue
      const alias = typeof model['alias'] === 'string' ? model['alias'].trim() : ''
      if (alias !== '') models.push({ alias, channelId, channelName })
    }
  }
  return {
    defaultModel: typeof value['defaultModel'] === 'string' ? value['defaultModel'].trim() : '',
    defaultChannelId: typeof value['defaultChannelId'] === 'string' ? value['defaultChannelId'].trim() : '',
    models,
  }
}

/** Where the effective model alias came from, for the audit line. */
export type ModelSource = 'request' | 'setting' | 'imagegen-default' | 'sole-catalogue-entry'

/** A chosen alias plus the reason it won. */
export interface ModelChoice {
  readonly alias: string
  readonly source: ModelSource
}

/**
 * Pick the model alias to use, and record why.
 *
 * Precedence: an explicit request, then the plugin setting, then the imagegen
 * default model, then — only when the catalogue holds exactly one alias — that
 * alias. Anything else asks the caller to choose, naming the options.
 */
export function resolveModelChoice(view: ImagegenSettingsView, requested: string, configured: string): ModelChoice {
  const asked = requested.trim()
  if (asked !== '') return { alias: asked, source: 'request' }
  const setting = configured.trim()
  if (setting !== '') return { alias: setting, source: 'setting' }
  if (view.defaultModel !== '') return { alias: view.defaultModel, source: 'imagegen-default' }
  const aliases = [...new Set(view.models.map(model => model.alias))]
  if (aliases.length === 1) return { alias: aliases[0]!, source: 'sole-catalogue-entry' }
  if (aliases.length === 0) {
    throw new WhalechanError(
      'No image models are configured in dsh-imagegen. Add a channel with at least one image model first.',
      'capability',
    )
  }
  throw new WhalechanError(
    `dsh-imagegen has no default model set and ${aliases.length} aliases are available — ` +
      `ask the user which one to use, then pass it as \`model\`. Options: ${aliases.join(', ')}.`,
    'capability',
  )
}

/** The alias only, for callers that do not need the provenance. */
export function resolveModel(view: ImagegenSettingsView, requested: string, configured: string): string {
  return resolveModelChoice(view, requested, configured).alias
}

/** Read the live imagegen settings view over the loopback route. */
export async function describeImagegen(
  sources: EndpointSources,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ImagegenSettingsView> {
  const base = resolveImagegenBase(sources)
  const doFetch = options.fetchImpl ?? fetch
  const response = await doFetch(joinUrl(base, IMAGEGEN_SETTINGS_DESCRIBE_PATH), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  })
  if (!response.ok) {
    throw new WhalechanError(
      `dsh-imagegen answered ${response.status} for its settings view. ` +
        'Check that the imagegen plugin is installed and enabled on this host.',
      classifyHttp(response.status),
    )
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new WhalechanError('dsh-imagegen returned a settings view that is not JSON.', 'service')
  }
  if (readPath(body, ['ok']) !== true) {
    const code = typeof readPath(body, ['code']) === 'string' ? String(readPath(body, ['code'])) : ''
    const message = typeof readPath(body, ['message']) === 'string' ? String(readPath(body, ['message'])) : 'unknown error'
    throw new WhalechanError(`dsh-imagegen refused the settings read: ${message}`, classifyEndpointError(code, message))
  }
  return readSettingsView(body)
}

/** Narrow `unknown` to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one nested key without trusting any level of the shape. */
function readPath(value: unknown, keys: readonly string[]): unknown {
  let cursor: unknown = value
  for (const key of keys) {
    if (!isRecord(cursor)) return undefined
    cursor = cursor[key]
  }
  return cursor
}
