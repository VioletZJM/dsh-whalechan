/**
 * Turn four things a caller actually knows into the object the prompt compiler eats.
 *
 * **Why this module exists.** The first real delivery spent seven of its fourteen
 * minutes with the model *authoring an assignment document* — reading the reference
 * catalogue, guessing canonical strings, discovering that a reference needs an
 * explicit role list, and failing validation three times before one compile
 * succeeded. The measured runs are in §68 of the charter: the plugin's own code was
 * 0.3 s of it. The interface's abstraction level was wrong: a request for "a
 * 3-head-tall whale-chan sitting on the floor eating rice" was answered with a
 * 30-field schema.
 *
 * So the schema stays, but it is **assembled here** from:
 *
 *   prompt   the scene, in the caller's own words — it becomes the scene line
 *   form     a catalogue form name, or a head count like `3` / `3头身`
 *   count    how many images
 *   ratio    an aspect ratio the channel can deliver exactly
 *
 * Nothing in this module touches the filesystem except the catalogue, and nothing
 * it produces is validated against anything: the compiler is the only consumer, and
 * it already refuses what it cannot render. There is no second schema to keep in
 * step — that was the cost of the old design, and it was paid in model steps.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { WhalechanError } from './errors.ts'
import { PRESET_HEADS } from './prompt/character.ts'

/**
 * The canonical strings, moved here from the retired assignment validator.
 *
 * They are what the frozen engine wrote into every prompt, so they are quoted
 * rather than composed: `canonical clean rounded cel-shaded Whale-chan style` is a
 * prompt fragment the channel has been calibrated on, not a description of one.
 */
export const DEFAULT_STYLE = 'canonical clean rounded cel-shaded Whale-chan style'
/** The canonical costume fragment. */
export const DEFAULT_COSTUME = 'canonical navy-and-white ornate maid outfit'
/** The canonical background. The comic half used pure white; this half does not. */
export const DEFAULT_BACKGROUND = 'warm ivory-beige #F5EADD'

/** One reference image of a catalogue form. */
export interface CatalogReference {
  readonly path: string
  readonly sha256: string
  readonly primary: boolean
  readonly measured_head_ratio: number
}

/** One form: its identity anchor, its measured heads, and its acceptance band. */
export interface CatalogForm {
  readonly primary: string
  readonly mean_head_ratio: number
  readonly acceptance_range: readonly number[]
  readonly references: readonly CatalogReference[]
}

/** The vendored reference catalogue. */
export interface Catalog {
  readonly schema_version: number
  readonly default_form: string
  readonly forms: Readonly<Record<string, CatalogForm>>
}

/** Path of the catalogue inside the package. */
export function catalogPath(skillRoot: string): string {
  return join(skillRoot, 'references', 'reference-catalog.json')
}

/**
 * Read and check the catalogue.
 * @param skillRoot - absolute path of the vendored skill tree.
 * @throws WhalechanError when the file is missing or does not describe forms.
 */
export function loadCatalog(skillRoot: string): Catalog {
  const path = catalogPath(skillRoot)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new WhalechanError(
      `cannot read the reference catalogue at ${path}: ${error instanceof Error ? error.message : String(error)}. `
        + 'The vendored tree is part of the package, so this build is incomplete.',
      'unavailable',
    )
  }
  const catalog = parsed as Partial<Catalog>
  const forms = catalog.forms
  if (typeof forms !== 'object' || forms === null || Object.keys(forms).length === 0) {
    throw new WhalechanError(`${path} describes no forms`, 'unavailable')
  }
  if (typeof catalog.default_form !== 'string' || !(catalog.default_form in forms)) {
    throw new WhalechanError(`${path} names a default form it does not define`, 'unavailable')
  }
  // The compiler turns a preset name into a head count through its own table, and a
  // catalogue form the compiler has never heard of would fail *there*, far from the
  // catalogue that introduced it. Check the two agree, once, here.
  for (const name of Object.keys(forms)) {
    if (!(name in PRESET_HEADS)) {
      throw new WhalechanError(
        `the catalogue defines the form ${JSON.stringify(name)}, but the prompt compiler has no head count for `
          + `it (it knows ${Object.keys(PRESET_HEADS).join(', ')}). The two tables must agree.`,
        'service',
      )
    }
  }
  return catalog as Catalog
}

/** How a requested form was understood. */
export interface FormChoice {
  /** The catalogue form whose identity anchor is used. */
  readonly anchor: string
  /** Its measured head count, for the dry-run report. */
  readonly anchorHeads: number
  /**
   * What the prompt states: a preset (the anchor's own count) or an exact custom
   * target the caller named.
   */
  /**
   * What the prompt states: a preset (the anchor's own count) or an exact custom
   * target the caller named.
   *
   * These are the **compiler's** field names, not this module's taste:
   * `proportionBlock` reads `preset` or `target_head_ratio`, and throws "custom
   * proportion needs a target_head_ratio greater than 1.0" for anything else. The
   * first real request — `form: "3头身"` — hit exactly that, because every check until
   * then had gone through the default preset and never compiled the custom branch.
   */
  readonly proportion: { readonly mode: 'preset'; readonly preset: string }
    | { readonly mode: 'custom'; readonly target_head_ratio: number }
  /** One sentence saying what was understood, printed in the dry run. */
  readonly because: string
}

/** Parse a head count out of free text such as `3`, `3.0`, `3 heads`, `3头身`. */
function headCountIn(requested: string): number | undefined {
  const match = /(\d+(?:\.\d+)?)/.exec(requested)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) && value > 1 ? value : undefined
}

/** The nearest catalogue form to a head count, ties going to the shorter figure. */
function nearestForm(catalog: Catalog, heads: number): string {
  return Object.keys(catalog.forms)
    .map(name => ({ name, distance: Math.abs(catalog.forms[name]!.mean_head_ratio - heads) }))
    .sort((left, right) => left.distance - right.distance
      || catalog.forms[left.name]!.mean_head_ratio - catalog.forms[right.name]!.mean_head_ratio)[0]!.name
}

/**
 * Work out which form a request means, without asking the caller to learn the table.
 *
 * A **name** selects that form and states its own counted ratio; a **number** is
 * taken literally — `3头身` becomes a custom 3.0 rather than being snapped to the
 * nearest preset — while the nearest form still supplies the identity anchor, which
 * is what a reference image is for.
 * @param catalog - the loaded catalogue.
 * @param requested - a form name, a head count, or nothing.
 * @returns the choice, plus why.
 * @throws WhalechanError when the request names nothing recognisable.
 */
export function resolveForm(catalog: Catalog, requested?: string): FormChoice {
  const trimmed = (requested ?? '').trim()
  const names = Object.keys(catalog.forms).join(', ')
  if (trimmed === '') {
    const name = catalog.default_form
    return {
      anchor: name,
      anchorHeads: catalog.forms[name]!.mean_head_ratio,
      proportion: { mode: 'preset', preset: name },
      because: `no form was named, so the catalogue default ${name} `
        + `(${catalog.forms[name]!.mean_head_ratio} heads) was used.`,
    }
  }
  if (trimmed in catalog.forms) {
    return {
      anchor: trimmed,
      anchorHeads: catalog.forms[trimmed]!.mean_head_ratio,
      proportion: { mode: 'preset', preset: trimmed },
      because: `form ${trimmed} was named, and its counted ratio is `
        + `${catalog.forms[trimmed]!.mean_head_ratio} heads.`,
    }
  }
  const heads = headCountIn(trimmed)
  if (heads !== undefined) {
    const anchor = nearestForm(catalog, heads)
    return {
      anchor,
      anchorHeads: catalog.forms[anchor]!.mean_head_ratio,
      proportion: { mode: 'custom', target_head_ratio: heads },
      because: `${heads} heads was taken literally, so the prompt states ${heads}; the identity anchor comes from `
        + `the nearest catalogue form ${anchor} (${catalog.forms[anchor]!.mean_head_ratio} heads).`,
    }
  }
  throw new WhalechanError(
    `form ${JSON.stringify(requested)} is neither a catalogue form nor a head count. Known forms: ${names}; `
      + 'a head count is any number greater than 1, e.g. 3 or "2.5头身".',
    'capability',
  )
}

/** What one composed image needs. */
export interface ComposeRequest {
  /** The scene, in the caller's words. Becomes the scene line. */
  readonly prompt: string
  /** Catalogue form name or head count; the catalogue default when omitted. */
  readonly form?: string | undefined
}

/** One image, shaped for the prompt compiler. */
export interface ComposedImage {
  readonly name: string
  readonly expression: string
  readonly action: string
  readonly composition: string
  readonly props: readonly string[]
  readonly objects: readonly string[]
  readonly style: { readonly mode: 'canonical' }
  readonly costume: { readonly mode: 'canonical' }
  readonly background: { readonly mode: 'solid'; readonly description: string }
  readonly text: null
  readonly proportion: FormChoice['proportion']
}

/** The compiler's input: an object with images, and nothing else it does not read. */
export interface ComposedAssignment {
  readonly schema_version: 4
  readonly images: readonly ComposedImage[]
}

/** Everything one composed request decided, for the dry-run report. */
export interface Composed {
  readonly assignment: ComposedAssignment
  readonly form: FormChoice
  /** Absolute path of the identity anchor image. */
  readonly anchorPath: string
  /** The image names, in order. */
  readonly names: readonly string[]
}

/** The scene line the compiler will render, ending with the framing constraint. */
function sceneOf(prompt: string): string {
  const scene = prompt.trim().replace(/[\s.。]+$/, '')
  if (scene === '') {
    throw new WhalechanError('prompt must be a non-empty description of the scene', 'capability')
  }
  return scene
}

/**
 * Compose `count` images from one description.
 * @param request - the scene and the optional form.
 * @param catalog - the loaded catalogue.
 * @param count - how many images, at least one.
 * @param skillRoot - absolute path of the vendored tree, to resolve the anchor.
 * @returns the compiler's input plus what was decided, so a caller can show it.
 */
export function composeImages(
  request: ComposeRequest,
  catalog: Catalog,
  count: number,
  skillRoot: string,
): Composed {
  if (!Number.isInteger(count) || count < 1) {
    throw new WhalechanError(`count must be a positive integer, not ${JSON.stringify(count)}`, 'capability')
  }
  const scene = sceneOf(request.prompt)
  const form = resolveForm(catalog, request.form)
  const anchorPath = join(skillRoot, ...catalog.forms[form.anchor]!.primary.split('/'))
  if (!isAbsolute(anchorPath)) {
    throw new WhalechanError(`the catalogue's anchor for ${form.anchor} is not a rooted path`, 'service')
  }
  const names = Array.from({ length: count }, (_, index) => `image-${String(index + 1).padStart(2, '0')}`)
  const images: ComposedImage[] = names.map(name => ({
    name,
    // The caller's sentence is the scene. `expression`/`action` are left empty on
    // purpose: splitting one sentence into three fields is exactly the guessing this
    // module exists to remove, and the compiler is happy with one non-empty field.
    expression: '',
    action: '',
    composition: scene,
    props: [],
    objects: [],
    style: { mode: 'canonical' },
    costume: { mode: 'canonical' },
    background: { mode: 'solid', description: DEFAULT_BACKGROUND },
    text: null,
    proportion: form.proportion,
  }))
  return {
    assignment: { schema_version: 4, images },
    form,
    anchorPath,
    names,
  }
}
