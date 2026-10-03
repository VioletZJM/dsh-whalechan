/**
 * `whalechan_image` — the whole surface, in one tool.
 *
 * What the first real delivery cost is measured in §68 of the charter: 98 model
 * steps, of which **104 of 113 tool calls had nothing to do with the plugin** — the
 * model was reading a reference catalogue, guessing canonical strings and repairing
 * an assignment document that this tool now assembles. The plugin's own execution was
 * 58 s of 861 s, and 55.7 s of that was the provider drawing the picture.
 *
 * So the contract is deliberately small. The caller says what they want in their own
 * words, and gets back either the exact prompt that will be sent (free) or the image
 * (paid). Everything between — form, identity anchor, canonical style, geometry,
 * budget — is the plugin's business, and is reported rather than requested.
 *
 * The money gate survives, because it is the reason this plugin exists and it is not
 * a guess about pixels: `plan_id` binds the compiled prompt, the model and the size,
 * and a confirmed call that does not carry it is refused **before** anything is spent.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { composeImages, loadCatalog } from '../domain/compose.ts'
import { WhalechanError } from '../domain/errors.ts'
import { channelFamily, promptLimit } from '../domain/family.ts'
import { deliverableRatios, resolveGeometry } from '../domain/geometry.ts'
import { HARD_MAX_CHARS, compilePrompt } from '../domain/prompt/character.ts'
import { canonicalJson } from '../run/plan.ts'
import {
  decodeImage,
  extensionOf,
  imageDataUrl,
  requestImage,
  writeImage,
} from '../run/client.ts'
import { resolveImagegenBase } from '../run/endpoint.ts'
import { resolveModelChoice, type ImagegenSettingsView, type ModelSource } from '../run/imagegen.ts'
import { resolveDataRoot } from '../run/state.ts'
import type { DeliverFiles, DeliverableFile, DeliveryOutcome } from '../run/deliver.ts'
import { CHARACTER_SKILL_ROOT } from '../run/vendor.ts'
import type { Config } from '../settings.ts'
import type { EndpointSources } from '../run/endpoint.ts'

/** Stable tool name; the whole plugin surface is prefixed `whalechan_`. */
export const IMAGE_TOOL_NAME = 'whalechan_image'

/** The ratio a caller gets when they do not name one. */
export const DEFAULT_RATIO = '1:1'

/** Everything the tool needs from the host, injected so tests never touch one. */
export interface ImageToolDeps {
  /** Live plugin configuration. */
  resolveConfig: () => Config
  /** Where the dsh-imagegen host might be; resolved per call, not cached. */
  endpointSources: () => EndpointSources
  /** Settings reader; overridden in tests with a stub. */
  describe: (sources: EndpointSources) => Promise<ImagegenSettingsView>
  /**
   * Declare the drawn files as this turn's deliverables, so the host shows them
   * without the agent touching them.
   *
   * Optional on purpose: a host that composes no delivery seam still gets the tool,
   * and the rendered result falls back to naming the file. A paid picture the user
   * cannot find is the one outcome this must never produce silently.
   */
  deliver?: DeliverFiles | undefined
}

/** One image the tool produced, or would produce. */
export interface ImageToolImage {
  readonly name: string
  readonly path: string
  readonly media_type: string
  readonly bytes: number
  readonly sha256: string
}

/** The value {@link IMAGE_TOOL_NAME} returns. */
export interface ImageToolValue {
  readonly dry_run: boolean
  readonly plan_id: string
  readonly model: string
  readonly model_source: string
  readonly channel_family: string
  readonly prompt_ceiling: number
  readonly ratio: string
  readonly size: string
  /** What the channel is expected to return, or empty when it decides. */
  readonly expected_pixels: string
  readonly deliverable_ratios: string[]
  readonly form: string
  readonly form_because: string
  readonly count: number
  /** The compiled prompt, verbatim — the thing a human is approving. */
  readonly prompt: string
  readonly prompt_chars: number
  readonly blocks: Array<{ readonly name: string; readonly chars: number }>
  readonly confirmation: string[]
  /** Empty on a dry run; one entry per written file otherwise. */
  readonly images: ImageToolImage[]
  /** How many files the session accepted as this turn's deliverables. */
  readonly delivered: number
  /** Why the files could not be declared, or empty when they were. */
  readonly delivery_error: string
}

/** Output schema of {@link IMAGE_TOOL_NAME}. */
const imageSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dry_run: { type: 'boolean', required: true },
    plan_id: { type: 'string', required: true },
    model: { type: 'string', required: true },
    model_source: { type: 'string', required: true },
    channel_family: { type: 'string', required: true },
    prompt_ceiling: { type: 'integer', required: true },
    ratio: { type: 'string', required: true },
    size: { type: 'string', required: true },
    expected_pixels: { type: 'string', required: true },
    deliverable_ratios: { type: 'array', items: { type: 'string' }, required: true },
    form: { type: 'string', required: true },
    form_because: { type: 'string', required: true },
    count: { type: 'integer', required: true },
    prompt: { type: 'string', required: true },
    prompt_chars: { type: 'integer', required: true },
    blocks: {
      required: true,
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', required: true }, chars: { type: 'integer', required: true } },
      },
    },
    confirmation: { type: 'array', items: { type: 'string' }, required: true },
    images: {
      required: true,
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          path: { type: 'string', required: true },
          media_type: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          sha256: { type: 'string', required: true },
        },
      },
    },
    delivered: { type: 'integer', required: true },
    delivery_error: { type: 'string', required: true },
  },
} as const

/** One phrase per model-source, for the audit line. */
function describeModelSource(source: ModelSource): string {
  switch (source) {
    case 'request':
      return 'the tool call'
    case 'setting':
      return 'the plugin setting defaultModel'
    case 'imagegen-default':
      return "dsh-imagegen's own defaultModel"
    case 'sole-catalogue-entry':
      return 'the only model alias in the catalogue'
  }
}

/** A compact timestamp for a file name: `20261003-1812`. */
function stamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

/**
 * The plan's identity: everything that decides what is sent, and nothing else.
 *
 * Deliberately narrow. It binds the compiled prompts, the model and the size — the
 * three things a confirmed call must not have changed — and it ignores the label of
 * the file or the time of day, so taking the plan twice is idempotent.
 * @param parts - the facts a human approved.
 * @returns a 64-character hex digest.
 */
export function planDigest(parts: {
  readonly model: string
  readonly size: string
  readonly ratio: string
  readonly count: number
  readonly prompts: readonly { readonly name: string; readonly prompt: string }[]
}): string {
  return createHash('sha256').update(canonicalJson(parts), 'utf8').digest('hex')
}

/**
 * The plan, before anything is spent.
 *
 * This is the money gate's artifact: a human reads it and decides. It is long on
 * purpose — the compiled prompt goes out verbatim — and it is the one thing the
 * delivery below must **not** imitate.
 * @param value - a dry-run value.
 * @returns the text a user approves.
 */
function renderPlan(value: ImageToolValue): string {
  const lines = [
    `Plan for ${value.count} image(s) on ${value.model} (${value.model_source}), channel family `
      + `"${value.channel_family}".`,
    `Form: ${value.form} — ${value.form_because}`,
    `Geometry: the panel key ${value.size} is sent for ${value.ratio}`
      + (value.expected_pixels === '' ? '; the channel chooses the pixel size.' : `; about ${value.expected_pixels} comes back.`)
      + ` The channel delivers exactly ${value.deliverable_ratios.join(', ')}.`,
    `Prompt: ${value.prompt_chars} characters (the compiler's ceiling is ${value.prompt_ceiling}).`,
    '',
    value.prompt,
    '',
    `Plan id ${value.plan_id}`,
    '',
    'Before approving:',
    ...value.confirmation.map(item => `  - ${item}`),
    '',
    'Nothing has been spent. Pass confirm: true together with this plan_id to draw it.',
  ]
  return lines.join('\n')
}

/**
 * The delivery: the picture is already handed to the session, so say that and stop.
 *
 * Everything the old version printed here — the compiled prompt, the plan id, the
 * sha256, the path — was a *report about* the picture, and the first real delivery
 * paid for it: the model read the prose, went looking for the file, measured it, and
 * re-read its own sidecar before handing it over (§73). The path is withheld on
 * purpose: an agent cannot measure a file it was never told about, and the file is
 * already declared as this turn's deliverable. It comes back only when the
 * declaration failed, because at that point a paid image with no way to find it is
 * the real failure.
 * @param value - a delivered value.
 * @returns one to three lines.
 */
function renderDelivery(value: ImageToolValue): string {
  const plural = value.count === 1 ? 'image' : 'images'
  const it = value.count === 1 ? 'it' : 'them'
  const pixels = value.expected_pixels === '' ? '' : ` (${value.expected_pixels})`
  const lines = [`Drew ${value.count} ${plural} on ${value.model}${pixels}.`]
  if (value.delivered >= value.images.length) {
    lines.push(`Delivered to this turn — judge ${it} yourself; do not read, measure or re-check ${it}.`)
    return lines.join('\n')
  }
  const why = value.delivery_error === '' ? 'the session did not take it' : value.delivery_error
  lines.push(`Could not declare ${it} as a deliverable (${why}), so ${it} is on disk here:`)
  for (const image of value.images) lines.push(`  ${image.path}`)
  lines.push(`Judge ${it} yourself; nothing here checked ${it}.`)
  return lines.join('\n')
}

/** Human-readable rendering of a plan or a delivery. */
export function renderImage(value: ImageToolValue): string {
  return value.dry_run ? renderPlan(value) : renderDelivery(value)
}

/**
 * Draw, or plan to draw, one or more images.
 * @param args - the tool call's arguments.
 * @param deps - injected host access.
 * @param exec - the executing call, handed to the delivery seam untouched; omitted
 *   (as a dry run, or in a test) it simply means nothing can be delivered.
 * @returns the plan, or the delivered files.
 */
export async function imageRun(
  args: {
    readonly prompt: string
    readonly form?: string | undefined
    readonly ratio?: string | undefined
    readonly count?: number | undefined
    readonly model?: string | undefined
    readonly plan_id?: string | undefined
    readonly confirm?: boolean | undefined
  },
  deps: ImageToolDeps,
  exec?: unknown,
): Promise<ImageToolValue> {
  const config = deps.resolveConfig()
  if (config.enabled === false) {
    throw new WhalechanError('dsh-whalechan is disabled in its settings.', 'capability')
  }
  const view = await deps.describe(deps.endpointSources())
  const choice = resolveModelChoice(view, args.model ?? '', config.defaultModel ?? '')
  const family = channelFamily(choice.alias)
  const ratio = (args.ratio ?? DEFAULT_RATIO).trim()
  const count = args.count ?? 1

  const catalog = loadCatalog(CHARACTER_SKILL_ROOT)
  const composed = composeImages({ prompt: args.prompt, ...(args.form === undefined ? {} : { form: args.form }) }, catalog, count, CHARACTER_SKILL_ROOT)

  // Geometry first, because it is where an undeliverable ratio is refused — with the
  // channel's own list and the nearest mapped size, which is more useful than a second
  // check written here could be. One refusal, in the module that owns the table.
  const geometry = resolveGeometry(family, choice.alias, ratio)
  // `sizeKey` is the panel key the route family expects (`1:1`, `7:4`, `auto`), not a
  // pixel size: dsh-imagegen maps the key onto its own geometry, and `expectedPixels`
  // is what comes back. Sending pixels here would be a different, wrong request.
  const size = geometry.sizeKey ?? 'auto'
  const deliverable = deliverableRatios(family, choice.alias) ?? []

  // The ceiling is the compiler's, not the channel's: the identity block is sized for
  // it, and a longer prompt would be truncated upstream rather than refused here.
  const compiled = composed.names.map(name => {
    const result = compilePrompt(composed.assignment as unknown as Record<string, unknown>, name, HARD_MAX_CHARS)
    return { name, prompt: result.prompt, blocks: result.blocks }
  })
  const digest = planDigest({
    model: choice.alias,
    size,
    ratio,
    count,
    prompts: compiled.map(entry => ({ name: entry.name, prompt: entry.prompt })),
  })

  const first = compiled[0]!
  const confirmation = [
    `${count} image(s) will be drawn on ${choice.alias} at ${ratio} (${size}); each one costs whatever your `
      + 'channel charges per image.',
    `The prompt below is sent verbatim. Its identity, style and costume blocks are constant; the scene line is `
      + `your description. It is ${first.prompt.length} characters, inside the compiler's ${HARD_MAX_CHARS}.`,
    `Plan id ${digest} binds the compiled prompt(s), the model and the size. Pass it back with confirm: true, and `
      + 'it is checked before anything is sent — if the plan changed, the call is refused and nothing is spent.',
  ]

  const base: Omit<ImageToolValue, 'dry_run' | 'images' | 'delivered' | 'delivery_error'> = {
    plan_id: digest,
    model: choice.alias,
    model_source: describeModelSource(choice.source),
    channel_family: family,
    prompt_ceiling: HARD_MAX_CHARS,
    ratio,
    size,
    expected_pixels: geometry.expectedPixels ?? '',
    deliverable_ratios: deliverable,
    form: composed.form.anchor,
    form_because: composed.form.because,
    count,
    prompt: first.prompt,
    prompt_chars: first.prompt.length,
    blocks: first.blocks.map(block => ({ name: block.name, chars: block.chars })),
    confirmation,
  }

  if (args.confirm !== true) {
    return { ...base, dry_run: true, images: [], delivered: 0, delivery_error: '' }
  }
  if (args.plan_id === undefined || args.plan_id.trim() === '') {
    throw new WhalechanError(
      `Refusing to draw without the plan id. Nothing has been spent, and nothing will be until the plan is `
        + `carried back: the plan id for this request is ${digest}. Call again with confirm: true and that `
        + 'plan_id (it changes if the prompt, the model, the ratio or the count changes).',
      'capability',
    )
  }
  if (args.plan_id.trim() !== digest) {
    throw new WhalechanError(
      `Refusing to draw: plan_id ${JSON.stringify(args.plan_id)} does not match the request that would be sent `
        + `(${digest}). The plan this call compiles is not the one that was approved, so nothing was spent. Take `
        + 'the plan again (omit confirm) and approve what you actually see.',
      'capability',
    )
  }

  const baseUrl = resolveImagegenBase(deps.endpointSources())
  const anchor = imageDataUrl(composed.anchorPath)
  const now = new Date()
  const directory = join(resolveDataRoot(config.dataRoot, process.env), 'images')
  const written: ImageToolImage[] = []
  const drawn: DeliverableFile[] = []

  for (const [index, entry] of compiled.entries()) {
    const image = await requestImage(
      {
        prompt: entry.prompt,
        model: choice.alias,
        size,
        n: 1,
        // The identity anchor goes with every request: it is what keeps the character
        // the same character between runs, and the channel supports reference images.
        mode: 'edit',
        image: anchor,
      },
      { base: baseUrl },
    )
    const bytes = decodeImage(image)
    const mediaType = image.mime === '' ? 'image/png' : image.mime
    const name = `${stamp(now)}-${composed.form.anchor}-${String(index + 1).padStart(2, '0')}`
    const path = join(directory, `${name}.${extensionOf(bytes)}`)
    // The directory appears with the first image that actually arrived: a refused
    // draw must leave no trace at all, not an empty folder that says "something ran".
    mkdirSync(directory, { recursive: true })
    writeImage(path, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(`${path}.json`, `${JSON.stringify({
      tool: IMAGE_TOOL_NAME,
      plan_id: digest,
      model: choice.alias,
      form: composed.form.anchor,
      ratio,
      size,
      prompt: entry.prompt,
      sha256,
      bytes: bytes.byteLength,
      created: now.toISOString(),
    }, null, 2)}\n`, 'utf8')
    written.push({ name, path, media_type: mediaType, bytes: bytes.byteLength, sha256 })
    // The label stays short and parenthetical-free: the client strips a trailing
    // `(…)` from a description before showing it beside the file name.
    drawn.push({ path, description: `whale-chan · ${composed.form.anchor} · ${ratio} · ${choice.alias}` })
  }

  const outcome = await deliverQuietly(deps.deliver, drawn, exec)
  return { ...base, dry_run: false, images: written, delivered: outcome.delivered, delivery_error: outcome.error }
}

/**
 * Declare the files, or say why not.
 *
 * Never throws. By the time this runs the picture exists and has been paid for, so
 * the only wrong outcome is a *failed call*: the caller's fallback is to print the
 * paths, which is strictly better than an error that says "no image".
 * @param deliver - the host's delivery seam, when it has one.
 * @param files - the files that exist on disk, in order.
 * @param exec - the executing call.
 * @returns what the session took, and why not when it took nothing.
 */
async function deliverQuietly(
  deliver: DeliverFiles | undefined,
  files: readonly DeliverableFile[],
  exec: unknown,
): Promise<DeliveryOutcome> {
  if (files.length === 0) return { delivered: 0, error: '' }
  // The host-level condition first: "this build cannot deliver" is the more useful
  // diagnosis, and it is the one a reader can act on.
  if (deliver === undefined) return { delivered: 0, error: 'this host has no delivery seam' }
  if (exec === undefined) return { delivered: 0, error: 'this call cannot be delivered from' }
  try {
    const outcome = await deliver(files, exec)
    return { delivered: Math.max(0, Math.trunc(outcome.delivered)), error: outcome.error }
  } catch (error) {
    return { delivered: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Register the image tool; returns the disposer cordis needs. */
export function registerImageTool(ctx: Context, deps: ImageToolDeps): () => void {
  return ctx.tools.register(
    defineTool({
      name: IMAGE_TOOL_NAME,
      description:
        'Draw a Whale-chan illustration from a plain description of the scene. Free unless confirmed: without '
        + 'confirm it returns the exact prompt, the model, the geometry and a plan_id — show that to the user '
        + 'first. With confirm: true and a matching plan_id it draws the images and declares them as this turn\'s '
        + 'deliverables, so the user sees them at once: do not read, measure, re-present or re-check them, and '
        + 'reply in one line — the user judges the picture. '
        // Every byte here is paid on every request in every session, so the rationale
        // lives in the module comment above rather than in the tool description.
        + 'The prompt is compiled by the plugin: say the scene, not the style.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'The scene in your own words, e.g. "sitting on the floor eating a bowl of white rice, smiling". '
            + 'It becomes the scene line verbatim.',
        },
        form: {
          type: 'string',
          description: 'Form name (standard, compact, semi-chibi, chibi, super-deformed) or a head count such as 3. '
            + 'A head count is stated literally; only the identity anchor snaps to the nearest form. Default semi-chibi.',
        },
        ratio: {
          type: 'string',
          description: 'Aspect ratio the channel delivers exactly, e.g. 1:1 (default) or 4:7. The plan lists them.',
        },
        count: {
          type: 'integer',
          description: 'How many images, 1 or more. Each is a separate paid generation.',
        },
        model: {
          type: 'string',
          description: 'Image model alias as configured in dsh-imagegen. Omit for the usual chain.',
        },
        plan_id: {
          type: 'string',
          description: 'The plan_id the dry run returned. Required with confirm: true.',
        },
        confirm: {
          type: 'boolean',
          description: 'True spends real quota. Only after the user has agreed to the prompt and the cost.',
        },
      },
      output: {
        schema: imageSchema,
        // Text only, and one line on the paid path. The picture reaches the user
        // through the session's own deliverable card, not through this content: a
        // rendered image block here would be flattened into a JSON dump by the
        // generic tool row (`image-card-model.ts` only builds a gallery for
        // `read_image`), and a text-only model has no use for it either.
        render: (_args, value) => [{ type: 'text', text: renderImage(value) }],
      },
      async execute(args, exec) {
        return imageRun(args, deps, exec)
      },
    }),
  )
}
