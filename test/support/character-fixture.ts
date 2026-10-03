/**
 * Shared character-half fixtures.
 *
 * Two suites need the same three things: a valid **authoring** draft, a
 * reference-image header reader that works without ImageMagick, and the vendored
 * skill root. Keeping one copy matters here more than usual — the draft builder
 * is what makes the differential meaningful, and two copies would eventually
 * build subtly different assignments.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CHARACTER_ORACLE, oracleScript, runPythonSnippet } from './oracle.ts'
import { DEFAULT_BACKGROUND, DEFAULT_COSTUME, DEFAULT_STYLE } from '../../src/domain/compose.ts'
import type { ImageHeader as ReferenceMetadata } from '../../src/domain/image-header.ts'

/** The character half's reference catalog, read for its form targets. */
export const CHARACTER_CATALOG = JSON.parse(
  readFileSync(join(CHARACTER_ORACLE, 'references', 'reference-catalog.json'), 'utf8'),
) as {
  default_form: string
  forms: Record<string, { primary: string; mean_head_ratio: number; acceptance_range: number[] }>
}

/** The form every fixture uses. */
export const FIXTURE_FORM = 'semi-chibi'

/** Absolute path of a form's primary reference. */
export function primaryPath(form: string = FIXTURE_FORM, skillRoot: string = CHARACTER_ORACLE): string {
  return join(skillRoot, ...CHARACTER_CATALOG.forms[form]!.primary.split('/'))
}

/**
 * The oracle's `identify_reference`, reached through the Pillow stand-in.
 *
 * Memoized: the suites validate the same handful of catalog images many times and
 * each uncached call costs a Python start-up.
 */
const IDENTIFIED = new Map<string, ReferenceMetadata>()
const IDENTIFY_SNIPPET = [
  'import json, sys',
  'import oracle_bootstrap, magick_shim',
  'result = magick_shim.invoke(["identify", "-quiet", "-format", "%m|%w|%h|%[colorspace]", sys.argv[1]])',
  'print(json.dumps({"code": result.code, "out": result.stdout, "err": result.stderr}))',
].join('\n')

/** Read one reference image's header metadata, without ImageMagick. */
export async function identify(path: string): Promise<ReferenceMetadata> {
  const cached = IDENTIFIED.get(path)
  if (cached !== undefined) return cached
  const outcome = runPythonSnippet(IDENTIFY_SNIPPET, [path])
  assert.equal(outcome.ok, true, `could not identify ${path}: ${outcome.ok ? '' : outcome.error}`)
  const parsed = JSON.parse(outcome.stdout) as { code: number; out: string; err: string }
  assert.equal(parsed.code, 0, `identify failed for ${path}: ${parsed.err}`)
  const [format = '', width = '0', height = '0', colorspace = ''] = parsed.out.trim().split('|')
  const metadata: ReferenceMetadata = { format, width: Number(width), height: Number(height), colorspace }
  IDENTIFIED.set(path, metadata)
  return metadata
}

/**
 * One reference entry, shaped like the oracle's own test fixture.
 *
 * `skillRoot` matters: the reference is an **absolute path**, and the assignment
 * validator resolves it against the catalog of whichever tree is being validated.
 * A fixture rooted at the oracle is rejected by a plan running against the
 * vendored tree, and vice versa.
 */
export function reference(form: string = FIXTURE_FORM, skillRoot: string = CHARACTER_ORACLE): Record<string, unknown> {
  return {
    id: 'canonical-identity',
    path: primaryPath(form, skillRoot),
    roles: ['identity', 'style', 'costume', 'proportion'],
    instruction: 'Canonical Whale-chan identity anchor',
  }
}

/** One image spec, shaped like the oracle's own test fixture. */
export function image(
  name: string,
  form: string = FIXTURE_FORM,
  skillRoot: string = CHARACTER_ORACLE,
): Record<string, unknown> {
  const profile = CHARACTER_CATALOG.forms[form]!
  return {
    name,
    subject: 'one Whale-chan',
    expression: 'calm',
    action: 'stand',
    composition: 'full body',
    props: [],
    objects: [],
    style: { mode: 'canonical', description: DEFAULT_STYLE },
    costume: { mode: 'canonical', description: DEFAULT_COSTUME },
    background: { mode: 'solid', description: DEFAULT_BACKGROUND },
    text: null,
    proportion: {
      mode: 'preset',
      preset: form,
      target_head_ratio: profile.mean_head_ratio,
      acceptance_range: [...profile.acceptance_range],
      proportion_reference: profile.primary,
    },
    references: [reference(form, skillRoot)],
    output: {
      format: 'png',
      aspect_ratio: '1:1',
      alpha: false,
      resolution: { mode: 'provider-native', width: null, height: null },
    },
    counterpart: null,
  }
}

/** Wrap images in an otherwise valid assignment. */
export function assignment(images: Array<Record<string, unknown>>, runName = 'test-run'): Record<string, unknown> {
  const estimated = images.length * 8
  return {
    schema_version: 4,
    confirmation: { confirmed: true, confirmed_at: '2026-08-13T00:00:00Z' },
    input: { type: 'text', content: 'test' },
    run_name: runName,
    image_count: images.length,
    images,
    execution: {
      mode: 'sequential',
      requested_parallelism: 1,
      max_parallelism: 5,
      commit_strategy: 'coordinator-serial',
    },
    budget: {
      per_image_candidates: 8,
      per_provider_candidates: 2,
      run_candidates: estimated,
      confirmed_over_24: estimated > 24,
    },
  }
}

/** The vendored character skill root, which is what a plan actually runs against. */
export const VENDORED_CHARACTER = join(
  import.meta.dirname, '..', '..', 'vendor', 'whalechan-image-character',
)

/** The oracle's own `manage-run.py`, used by suites that diff against it. */
export const CHARACTER_ORACLE_SCRIPT = oracleScript('manage-run.py')
