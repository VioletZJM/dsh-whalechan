/**
 * Where the dsh-imagegen route family lives.
 *
 * Discovery order (D4 of the rewrite charter): an explicit setting wins, then
 * the address the host web server actually reports, then the host-injected
 * `DSH_WEB_URL`. A missing answer is a *classified* `unavailable` failure with
 * an actionable message — never a bare `Invalid URI` from deep inside `fetch`.
 */
import { WhalechanError } from '../domain/errors.ts'

/** Loopback-only route that turns one prompt into one candidate. */
export const IMAGEGEN_GENERATE_PATH = '/api/dsh-imagegen/generate'

/** Loopback-only route that exposes the imagegen settings view. */
export const IMAGEGEN_SETTINGS_DESCRIBE_PATH = '/api/dsh-imagegen/settings/describe'

/** Every source the base URL may come from, most specific first. */
export interface EndpointSources {
  /** Plugin setting `imagegenBaseUrl`; empty means "not configured". */
  readonly explicit?: string | undefined
  /** Address the host web server reports, when the service exposes one. */
  readonly hostAddress?: string | undefined
  /** Process environment; defaults to `process.env` at the call site. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
}

/** Trim a configured base URL and drop trailing slashes. */
export function normalizeBase(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\/+$/, '')
}

/**
 * Resolve the imagegen base URL.
 * @throws WhalechanError with category `unavailable` when nothing is configured.
 */
export function resolveImagegenBase(sources: EndpointSources = {}): string {
  for (const [, value] of baseCandidates(sources)) {
    if (value !== '') return value
  }
  throw new WhalechanError(
    'The dsh-imagegen host could not be located: no imagegenBaseUrl setting, no host web server address, ' +
      'and DSH_WEB_URL is not set. Run this inside the DSH host, or set imagegenBaseUrl to that host\'s ' +
      'base URL (for example http://127.0.0.1:19387).',
    'unavailable',
  )
}

/** Which source supplied a resolved base URL. */
export type ImagegenBaseSource = 'setting' | 'host-web-server' | 'DSH_WEB_URL' | 'unresolved'

/** The candidate sources, most specific first. */
function baseCandidates(
  sources: EndpointSources,
): ReadonlyArray<readonly [ImagegenBaseSource, string]> {
  return [
    ['setting', normalizeBase(sources.explicit)],
    ['host-web-server', normalizeBase(sources.hostAddress)],
    ['DSH_WEB_URL', normalizeBase(sources.env?.['DSH_WEB_URL'])],
  ]
}

/**
 * Resolve the base URL **and say where it came from**.
 *
 * The source matters because the two are not equally trustworthy. A value from
 * `host-web-server` was measured from this process's own listener; a value from
 * `DSH_WEB_URL` is an inherited claim that may name an entirely different host —
 * which is exactly what a receipt recorded the first time this plugin ran on a
 * real 3080 host, where the launching shell carried another host's URL.
 * @param sources - the same sources `resolveImagegenBase` reads.
 * @returns the base URL (empty when none resolves) and the winning source.
 */
export function describeImagegenBase(
  sources: EndpointSources = {},
): { readonly base: string; readonly source: ImagegenBaseSource } {
  for (const [source, value] of baseCandidates(sources)) {
    if (value !== '') return { base: value, source }
  }
  return { base: '', source: 'unresolved' }
}

/** Join a normalized base URL with an absolute route path. */
export function joinUrl(base: string, path: string): string {
  return `${normalizeBase(base)}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * Loopback base URL for a host web server that reports its listening port.
 *
 * This is the primary discovery source, and it has to be: `DSH_WEB_URL` is
 * injected into the shells the host *spawns*, not into the host process itself.
 * A plugin reading `process.env.DSH_WEB_URL` inside the host gets nothing —
 * measured on the local web profile, where the host process had neither
 * `DSH_WEB_URL` nor `DSH_PROFILE` set.
 *
 * The port is 0 until the listener binds, so callers must resolve per request
 * and treat `undefined` as "not ready yet" rather than as a hard failure.
 */
export function hostAddressOf(port: number | undefined): string | undefined {
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return `http://127.0.0.1:${port}`
}
