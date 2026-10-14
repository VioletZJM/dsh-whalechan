/**
 * Model alias → protocol family, mirrored from the dsh-imagegen plugin's own
 * catalogue rather than imported from it.
 *
 * Why mirror: that plugin re-exports its internals only "for smoke tests and
 * host-side debugging", and its package README states the plugin contract is
 * just `name / inject / Config / apply`. Importing `engine.ts` would couple two
 * independently versioned packages. The price is that these rules are a copy: when
 * dsh-imagegen adds or renames a model, check them by hand against its catalogue,
 * because nothing here can notice on its own.
 */

/** The protocol families this plugin knows how to shape a request for. */
export type ChannelFamily =
  | 'gpt-image'
  | 'dall-e'
  | 'grok'
  | 'nanobanana'
  | 'seedream'
  | 'zhipu'
  | 'qwen'
  | 'minimax'
  | 'unknown'

/** One ordered detection rule; the first match wins. */
interface FamilyRule {
  readonly family: Exclude<ChannelFamily, 'unknown'>
  readonly pattern: RegExp
}

/** Detection order matters — keep it identical to the plugin's own list. */
export const FAMILY_RULES: readonly FamilyRule[] = [
  { family: 'gpt-image', pattern: /^gpt-image/i },
  { family: 'dall-e', pattern: /^dall-e/i },
  { family: 'grok', pattern: /^grok-imagine(?:-|$)/i },
  {
    family: 'nanobanana',
    pattern: /^nanobanana|^(?:gemini-3-pro-image|gemini-3-pro-image-preview|gemini-3\.1-flash-image|gemini-3\.1-flash-image-preview|gemini-3\.1-flash-lite-image|gemini-2\.5-flash-image)$/i,
  },
  { family: 'seedream', pattern: /^(?:doubao-)?seedream/i },
  { family: 'zhipu', pattern: /^(?:glm-image|cogview)(?:-|$)/i },
  { family: 'qwen', pattern: /^qwen-image(?:[-_.]|$)/i },
  { family: 'minimax', pattern: /^(?:minimax[-_/])?image-\d+/i },
]

/** Documented upstream prompt ceilings, in characters, per family. */
export const PROMPT_LIMITS: Readonly<Record<string, number | undefined>> = {
  zhipu: 800,
  minimax: 1500,
}

/** Ceiling for families with no documented limit. */
export const DEFAULT_PROMPT_LIMIT = 4000

/** The plugin's protocol family for one model alias, or `unknown`. */
export function channelFamily(model: string): ChannelFamily {
  const trimmed = model.trim()
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(trimmed)) return rule.family
  }
  return 'unknown'
}

/** Qwen-Image ships two geometry tiers; only the dotted ids are the new one. */
export function isVersionedQwen(model: string): boolean {
  return /^qwen-image-\d+\.\d/i.test(model.trim())
}

/** Prompt character ceiling for one family. */
export function promptLimit(family: ChannelFamily): number {
  return PROMPT_LIMITS[family] ?? DEFAULT_PROMPT_LIMIT
}

/** Only the 智谱 image models are text-to-image-only in this plugin. */
export function referencesSupported(family: ChannelFamily): boolean {
  return family !== 'zhipu'
}

/** Only the gpt-image family has a verified native transparent-output contract. */
export function transparencySupported(family: ChannelFamily): boolean {
  return family === 'gpt-image'
}
