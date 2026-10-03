/**
 * Diagnostic route: `GET /api/dsh-whalechan/status`.
 *
 * Why a plugin that is otherwise host-tool-only ships one route: this project
 * has already been burned by silent host refusals, and a cordis plugin whose
 * `apply` throws — or whose module was cached from an older build — looks
 * exactly like a plugin that works. A route answers "is it mounted, which
 * build, and can it find the imagegen host?" from outside the process, with no
 * session and no browser.
 *
 * Deliberately loopback-only, and deliberately free: the plain form answers
 * from memory, and `?probe=1` adds the settings read (no generation), so even
 * the probing form never spends money.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { channelReport } from './domain/geometry.ts'
import { WhalechanError } from './domain/errors.ts'
import type { EndpointSources } from './run/endpoint.ts'
import { resolveImagegenBase } from './run/endpoint.ts'
import { bootedProfile } from './run/profile.ts'
import { describeImagegen, resolveModelChoice } from './run/imagegen.ts'
import type { Config } from './settings.ts'

/** Absolute pathname of the status route. */
export const STATUS_PATH = '/api/dsh-whalechan/status'

/** Minimal structural view of the host web server service. */
export interface WebServerLike {
  /** Listening port; 0 or undefined until the listener binds. */
  readonly port?: number | undefined
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Everything the status route reports or needs. */
export interface StatusDeps {
  readonly version: string
  readonly tools: readonly string[]
  readonly endpointSources: () => EndpointSources
  /**
   * Live plugin configuration. The probing form must apply the same precedence
   * the tools do; a diagnostic that reports a different model than the next
   * real call would select is worse than no diagnostic.
   */
  readonly resolveConfig: () => Config
  readonly describe: (sources: EndpointSources) => Promise<Awaited<ReturnType<typeof describeImagegen>>>
  /**
   * Whether the host's session-projection service bound to this mount.
   *
   * Reported here as well as in the load receipt because it decides something the
   * user can see: the drawing declared as a deliverable the moment it lands, or a path
   * in the text.
   */
  readonly delivery: () => boolean
}

/** Is this request from the loopback interface? */
export function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Write one JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** The in-memory half of the report, which cannot fail. */
function baseReport(deps: StatusDeps): Record<string, unknown> {
  let base = ''
  let baseError: string | null = null
  // Resolved from the command line, not the environment: see `run/profile.ts`.
  const booted = bootedProfile(process.argv)
  try {
    base = resolveImagegenBase(deps.endpointSources())
  } catch (error) {
    baseError = error instanceof Error ? error.message : String(error)
  }
  return {
    plugin: 'dsh-whalechan',
    version: deps.version,
    pid: process.pid,
    profile: booted.profile,
    profileSource: booted.source,
    tools: [...deps.tools],
    delivery: deps.delivery(),
    imagegenBase: base,
    imagegenBaseError: baseError,
  }
}

/**
 * Register the status route.
 * @returns the disposer cordis needs.
 */
export function registerStatusRoute(server: WebServerLike, deps: StatusDeps): () => void {
  return server.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writeJson(res, 405, { error: `method not allowed: ${req.method ?? ''}` })
        return
      }
      const report = baseReport(deps)
      const url = new URL(req.url ?? STATUS_PATH, 'http://dsh.invalid')
      if (url.searchParams.get('probe') === '1' && report['imagegenBaseError'] === null) {
        try {
          const view = await deps.describe(deps.endpointSources())
          const choice = resolveModelChoice(view, '', deps.resolveConfig().defaultModel ?? '')
          report['imagegen'] = {
            ok: true,
            model: choice.alias,
            modelSource: choice.source,
            catalogue: [...new Set(view.models.map(model => model.alias))],
            channel: channelReport(choice.alias),
          }
        } catch (error) {
          report['imagegen'] = {
            ok: false,
            category: error instanceof WhalechanError ? error.category : 'service',
            message: error instanceof Error ? error.message : String(error),
          }
        }
      }
      writeJson(res, 200, report)
    },
  })
}
