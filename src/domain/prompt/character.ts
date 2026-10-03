/**
 * Budget-aware prompt compiler for the character skill (assignment schema v4).
 *
 * Ported from `dsh-port/overlay/whalechan-image-character/scripts/build-prompt.py`
 * with byte-identical output as the acceptance bar.
 *
 * Why it exists: 智谱 `glm-image` accepts at most 800 characters and **silently
 * truncates** the overflow. Hand-assembled prompts routinely land at 2000+, so
 * the lost tail is invisible. Here the identity block and the other frozen
 * blocks are constants, the scene text gets whatever is left, and a prompt that
 * does not fit is a hard error instead of a silent amputation.
 *
 * Determinism is the point: the same assignment always compiles to the same
 * bytes, because character consistency across independent text-to-image calls
 * comes from an identical identity block, not from any cross-call memory (this
 * channel cannot send reference images and exposes no seed control).
 */
import { createHash } from 'node:crypto'
import { WhalechanError } from '../errors.ts'
import { formatGeneral, pythonRound } from '../python-compat.ts'

export { formatGeneral, pythonRound }

/** Assignment schema this compiler accepts. */
export const SCHEMA_VERSION = 4

/** Label prefixed to every block except the identity block. */
export const LABELS: Readonly<Record<string, string>> = {
  proportion: 'Proportion: ',
  style: 'Style: ',
  costume: 'Costume: ',
  scene: 'Scene: ',
  props: 'Props: ',
  background: 'Background: ',
}

/** Canonical head-to-body ratios per form preset. */
export const PRESET_HEADS: Readonly<Record<string, number>> = {
  standard: 4.0,
  compact: 3.3,
  'semi-chibi': 2.8,
  chibi: 2.5,
  'super-deformed': 2.1,
}

/**
 * Permanent identity. Constant on purpose.
 *
 * The proper name is deliberately absent: measured twice on this channel, the
 * moment "DeepSeek Whale-chan" appears the model renders it as a poster title
 * or bottom caption, which fails the X1/S1 gates. The physical description
 * carries the identity instead.
 */
export const IDENTITY =
  'Anime girl, ageless humanoid whale mascot: round face, big blue eyes, deep-blue hair, ' +
  'cyan tips, whale-fin ears sticking out sideways from her head (fins, not bows), ' +
  'a forward-curving ahoge, a single small whale tail at her lower back, correct anatomy.'

/** The no-text contract; explicit and early. */
export const NO_TEXT = 'NO TEXT: no title, caption, lettering, logo, signature, watermark.'

/**
 * Measured on 3 of the first 6 candidates: without an explicit framing
 * constraint the model crops the figure at the knees, losing the frozen
 * full-body composition and every sole landmark.
 */
export const FRAMING = 'entire figure in frame, feet visible'

/** Canonical style, used when `image.style.mode` is `canonical`. */
export const STYLE_CANONICAL = 'clean rounded cel shading, navy/cyan palette.'

/** Canonical costume, used when `image.costume.mode` is `canonical`. */
export const COSTUME_CANONICAL =
  'navy-white frilled maid dress, white apron with a blue whale emblem, ' +
  'white headpiece, socks, blue shoes.'

/** The channel truncates past this, so no budget may exceed it. */
export const HARD_MAX_CHARS = 800

/** Default budget: the documented 800 minus a safety margin. */
export const DEFAULT_MAX_CHARS = 780

/** One compiled block: its name and its rendered line (label included). */
export interface BlockSize {
  readonly name: string
  readonly chars: number
}

/** A compiled prompt plus the per-block budget report. */
export interface CompiledPrompt {
  readonly prompt: string
  readonly blocks: readonly BlockSize[]
  /** Lowercase hex SHA-256 of the prompt bytes; the audit anchor. */
  readonly promptSha256: string
}

/** A prompt that cannot be compiled within the frozen budget. */
export class PromptError extends WhalechanError {
  /** Per-block sizes, present when the failure was a budget overflow. */
  readonly blocks: readonly BlockSize[]

  constructor(message: string, category: 'capability' | 'unavailable' = 'capability', blocks: readonly BlockSize[] = []) {
    super(message, category)
    this.name = 'PromptError'
    this.blocks = blocks
  }
}

/** Narrow an unknown to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read one image object from an assignment by name. */
export function findImage(assignment: Record<string, unknown>, name: string): Record<string, unknown> {
  const images = assignment['images']
  if (!Array.isArray(images) || images.length === 0) {
    throw new PromptError('assignment has no images')
  }
  for (const image of images) {
    if (isRecord(image) && image['name'] === name) return image
  }
  const available = images.filter(isRecord).map(item => String(item['name'])).join(', ')
  throw new PromptError(`unknown image name ${JSON.stringify(name)}; assignment contains: ${available}`)
}

/** Render `image.text` when present, else the no-text directive. */
export function textBlock(image: Record<string, unknown>): string {
  const contract = image['text']
  if (contract === undefined || contract === null) return NO_TEXT
  if (!isRecord(contract)) throw new PromptError('image.text must be null or an object')
  const content = contract['content']
  if (typeof content !== 'string' || content === '') {
    throw new PromptError('image.text.content must be a non-empty string')
  }
  const pieces = [`Text: exactly ${jsonString(content)}`]
  const languages = contract['languages']
  if (Array.isArray(languages) && languages.length > 0) {
    pieces.push(`in ${languages.map(item => String(item)).join('/')}`)
  }
  const direction = contract['direction']
  if (typeof direction === 'string' && direction !== '') pieces.push(direction)
  const placement = contract['placement']
  if (typeof placement === 'string' && placement.trim() !== '') pieces.push(placement.trim())
  const style = contract['style']
  if (typeof style === 'string' && style.trim() !== '') pieces.push(style.trim())
  pieces.push('nothing else')
  return `${pieces.join(', ')}.`
}

/** JSON-encode like Python's `json.dumps(..., ensure_ascii=False)`. */
function jsonString(value: string): string {
  return JSON.stringify(value)
}

/** Render `image.proportion`. */
export function proportionBlock(image: Record<string, unknown>): string {
  const proportion = image['proportion']
  if (!isRecord(proportion)) throw new PromptError('image.proportion must be an object')
  const mode = proportion['mode']
  if (mode === 'preset') {
    const preset = proportion['preset']
    const heads = typeof preset === 'string' ? PRESET_HEADS[preset] : undefined
    if (heads === undefined) throw new PromptError(`unknown proportion preset ${JSON.stringify(preset)}`)
    return `${formatGeneral(heads)} heads tall total (head ~${pythonRound(100 / heads)}% tall); age unchanged.`
  }
  if (mode === 'custom') {
    const target = proportion['target_head_ratio']
    if (typeof target !== 'number' || !Number.isFinite(target) || target <= 1.0) {
      throw new PromptError('custom proportion needs a target_head_ratio greater than 1.0')
    }
    return `${formatGeneral(target)} heads tall total (head ~${pythonRound(100 / target)}% tall); keep apparent age unchanged.`
  }
  throw new PromptError('image.proportion.mode must be preset or custom')
}

/** Render one canonical-or-custom description field (`style`, `costume`). */
export function descriptionBlock(image: Record<string, unknown>, field: string, canonical: string): string {
  const value = image[field]
  if (!isRecord(value)) throw new PromptError(`image.${field} must be an object`)
  const mode = value['mode']
  const description = value['description']
  if (mode === 'canonical') return canonical
  if (mode === 'custom') {
    if (typeof description !== 'string' || description.trim() === '') {
      throw new PromptError(`custom ${field} needs a description`)
    }
    return description.trim()
  }
  throw new PromptError(`image.${field}.mode must be canonical or custom`)
}

/** Render the scene line, always ending with the framing constraint. */
export function sceneBlock(image: Record<string, unknown>): string {
  const parts: string[] = []
  for (const field of ['expression', 'action', 'composition']) {
    const value = image[field]
    if (typeof value === 'string' && value.trim() !== '') {
      parts.push(value.trim().replace(/\.+$/, ''))
    }
  }
  if (parts.length === 0) {
    throw new PromptError('image needs at least one of expression, action or composition')
  }
  parts.push(FRAMING)
  return `${parts.join(', ')}.`
}

/** Render `props` + `objects`, or the empty string when there are none. */
export function propsBlock(image: Record<string, unknown>): string {
  const entries: string[] = []
  for (const field of ['props', 'objects']) {
    const value = image[field]
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) throw new PromptError(`image.${field} must be a list`)
    for (const item of value) {
      const text = itemText(item).trim().replace(/\.+$/, '')
      if (text !== '') entries.push(text)
    }
  }
  return entries.length > 0 ? `${entries.join(', ')}.` : ''
}

/** Stringify one prop entry; the schema says string, so other shapes are defensive. */
function itemText(item: unknown): string {
  if (typeof item === 'string') return item
  if (typeof item === 'number' || typeof item === 'boolean') return String(item)
  if (item === null || item === undefined) return ''
  return JSON.stringify(item) ?? ''
}

/** Render `image.background`, refusing the transparency this channel cannot honour. */
export function backgroundBlock(image: Record<string, unknown>): string {
  const background = image['background']
  if (!isRecord(background)) throw new PromptError('image.background must be an object')
  const mode = background['mode']
  const description = background['description']
  if (mode === 'transparent') {
    throw new PromptError(
      'background.mode=transparent cannot be satisfied here: 智谱 glm-image returns an opaque ' +
        'JPEG payload with no transparency contract. Freeze a solid or custom background.',
    )
  }
  if (mode !== 'solid' && mode !== 'custom') {
    throw new PromptError('image.background.mode must be solid, custom or transparent')
  }
  if (typeof description !== 'string' || description.trim() === '') {
    throw new PromptError('image.background needs a description')
  }
  return description.trim()
}

/** Assemble the ordered blocks for one image. */
export function compileBlocks(image: Record<string, unknown>): Array<readonly [string, string]> {
  const blocks: Array<readonly [string, string]> = [
    ['identity', IDENTITY],
    ['proportion', proportionBlock(image)],
    ['style', descriptionBlock(image, 'style', STYLE_CANONICAL)],
    ['costume', descriptionBlock(image, 'costume', COSTUME_CANONICAL)],
    ['scene', sceneBlock(image)],
  ]
  const props = propsBlock(image)
  if (props !== '') blocks.push(['props', props])
  blocks.push(['background', backgroundBlock(image)])
  blocks.push(['text', textBlock(image)])
  return blocks
}

/** Join blocks into the final prompt; only the identity block goes unlabelled. */
export function render(blocks: ReadonlyArray<readonly [string, string]>): string {
  return blocks
    .map(([name, value]) => (name === 'identity' ? value : `${LABELS[name] ?? ''}${value}`))
    .join('\n')
}

/**
 * Compile one image of a frozen assignment into a budget-checked prompt.
 * @throws PromptError with category `capability` when the prompt exceeds the budget.
 */
export function compilePrompt(
  assignment: Record<string, unknown>,
  imageName: string,
  maxChars: number = DEFAULT_MAX_CHARS,
): CompiledPrompt {
  if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > HARD_MAX_CHARS) {
    throw new PromptError(
      `max_chars must be between 200 and ${HARD_MAX_CHARS} (upstream truncates past ${HARD_MAX_CHARS})`,
    )
  }
  const image = findImage(assignment, imageName)
  const blocks = compileBlocks(image)
  const prompt = render(blocks)
  // Per-block sizes count the rendered line (label included); the total counts
  // the newlines that join them. The two deliberately do not add up.
  const sizes: BlockSize[] = blocks.map(([name, value]) => ({
    name,
    chars: `${LABELS[name] ?? ''}${value}`.length,
  }))
  if (prompt.length > maxChars) {
    const over = prompt.length - maxChars
    const ranked = [...sizes].sort((left, right) => right.chars - left.chars)
    const detail = ranked.map(item => `${item.name}=${item.chars}`).join(', ')
    throw new PromptError(
      `compiled prompt is ${prompt.length} characters, ${over} over the ${maxChars}-character budget ` +
        `(${detail}). Shorten the scene text (it owns whatever the constant blocks leave) — ` +
        `the identity block is fixed on purpose.`,
      'capability',
      sizes,
    )
  }
  return {
    prompt,
    blocks: sizes,
    promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
  }
}

/**
 * Validate the schema version of a parsed assignment object.
 * @throws PromptError when the version is not {@link SCHEMA_VERSION}.
 */
export function requireSchemaVersion(assignment: Record<string, unknown>): void {
  const found = assignment['schema_version']
  if (found !== SCHEMA_VERSION) {
    throw new PromptError(
      `assignment schema_version must be ${SCHEMA_VERSION}, found ${JSON.stringify(found)}`,
    )
  }
}
