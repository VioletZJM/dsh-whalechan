/**
 * Plugin configuration.
 *
 * **Every field here becomes a control in the user's settings UI**, so a field
 * nothing reads is worse than a missing one: the user flips it, nothing happens, and
 * the honest conclusion is that the plugin is broken. `announceToAgent` sat here for
 * three versions doing exactly that — declared, defaulted, and referenced by no line
 * of code. So: **add a field only together with the line that reads it.**
 *
 * Values arrive from the composition entry (the profile's `cordis.patch.yml`) or from
 * the host's settings store; the schema is what the host renders, so it is the only
 * description of these controls that cannot drift from reality.
 */
import z from '@deepseek-ai/schemastery'

/** The plugin's settings shape. */
export interface Config {
  /** Master switch for the tool this plugin registers. */
  enabled?: boolean
  /**
   * Base URL of the dsh-imagegen host, e.g. `http://127.0.0.1:19387`.
   * Empty asks the plugin to discover it (host address, then `DSH_WEB_URL`).
   */
  imagegenBaseUrl?: string
  /** Image model alias to use when a call does not name one. Empty uses imagegen's default. */
  defaultModel?: string
  /** Where images are written. Empty keeps the default under `DSH_HOME`. */
  dataRoot?: string
}

/** The fields the schema declares, in the order the settings card shows them. */
export const CONFIG_FIELDS = ['enabled', 'imagegenBaseUrl', 'defaultModel', 'dataRoot'] as const

const configSchema = z.object({
  enabled: z.boolean().default(true),
  imagegenBaseUrl: z.string().default(''),
  defaultModel: z.string().default(''),
  dataRoot: z.string().default(''),
})

/** Validated configuration, read by cordis before `apply` runs. */
export const Config: z<Config> = configSchema as unknown as z<Config>
