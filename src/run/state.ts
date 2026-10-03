/**
 * Load receipt: evidence that the host actually mounted this plugin.
 *
 * Why this exists: this project has already lost a day to a *silent* host
 * refusal — a skill whose frontmatter had a `: ` in a plain scalar was dropped
 * without an error anywhere the user could see. A plugin that fails to resolve,
 * or whose `apply` throws, is equally invisible from the outside. Writing one
 * small file into the plugin's own data directory turns "did it load?" into a
 * question with an answer.
 *
 * Failure policy: a receipt problem must never break the plugin, so every error
 * is swallowed.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { VERSION } from '../version.ts'
import { bootedProfile } from './profile.ts'

/** The subset of the host environment the path resolution reads. */
export interface HostEnv {
  readonly DSH_HOME?: string | undefined
  readonly DSH_PROFILE?: string | undefined
  readonly DSH_WEB_URL?: string | undefined
}

/** Format of the receipt written to `<dataRoot>/state/loaded.json`. */
export interface LoadReceipt {
  readonly plugin: 'dsh-whalechan'
  readonly version: string
  readonly appliedAt: string
  readonly pid: number
  readonly profile: string
  /**
   * The address **this** host serves on, measured from its own listener, or empty
   * when that is not known yet.
   *
   * Deliberately not `process.env.DSH_WEB_URL`: that variable is inherited by
   * child processes, so a host started from a shell that carried another host's
   * URL records a plausible address belonging to a different process.
   */
  readonly webUrl: string
  /**
   * The imagegen base URL this mount resolved, or empty when none resolved.
   *
   * Read together with {@link imagegenBaseSource}: an empty base with an
   * `unresolved` source means "not known yet", while a base sourced from
   * `DSH_WEB_URL` means "an inherited claim, not a measurement".
   */
  readonly imagegenBase: string
  /** Which source supplied {@link imagegenBase}. */
  readonly imagegenBaseSource: string
  /**
   * Whether the host's session-projection service bound to this mount.
   *
   * This is the difference between "the plugin declares each drawing as a deliverable,
   * so it reaches the user on its own" and "the delivered result names the file and the
   * agent has to hand it over". It is a property of the host, not of the plugin, so it
   * is recorded as measured rather than assumed.
   */
  readonly delivery: boolean
  readonly tools: readonly string[]
}

/** What a caller knows at mount time. */
export interface LoadReceiptInput {
  readonly tools: readonly string[]
  readonly webUrl: string
  readonly imagegenBase: string
  readonly imagegenBaseSource: string
  readonly delivery: boolean
}

/** Default data root: `<DSH_HOME>/dsh-whalechan`, then the user home. */
export function defaultDataRoot(env: HostEnv): string {
  const home = env.DSH_HOME?.trim() !== undefined && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME.trim()
    : path.join(homedir(), '.dsh')
  return path.join(home, 'dsh-whalechan')
}

/** Resolve a configured data root, falling back to the default. */
export function resolveDataRoot(configured: string | undefined, env: HostEnv): string {
  const value = typeof configured === 'string' ? configured.trim() : ''
  return value !== '' ? value : defaultDataRoot(env)
}

/**
 * Write the load receipt, best-effort.
 * @returns the receipt path, whether or not the write succeeded.
 */
export async function writeLoadReceipt(root: string, input: LoadReceiptInput): Promise<string> {
  const target = path.join(root, 'state', 'loaded.json')
  const receipt: LoadReceipt = {
    plugin: 'dsh-whalechan',
    version: VERSION,
    appliedAt: new Date().toISOString(),
    pid: process.pid,
    // From the command line, not the environment: an inherited `DSH_PROFILE`
    // reports the launching shell's profile, which is a different thing.
    profile: bootedProfile(process.argv).profile,
    webUrl: input.webUrl,
    imagegenBase: input.imagegenBase,
    imagegenBaseSource: input.imagegenBaseSource,
    delivery: input.delivery,
    tools: [...input.tools],
  }
  try {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
  } catch {
    // Best effort: a receipt failure is never a plugin failure.
  }
  return target
}
