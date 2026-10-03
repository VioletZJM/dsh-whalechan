/**
 * Verify the **built bundle**, not the sources.
 *
 * This file exists because of a failure that already happened here once: the test
 * suite runs `src/`, the host runs `lib/index.js`, and a change can be right in one
 * and wrong in the other. Every suite in `test/` passed while the packaged plugin was
 * broken, and the difference was invisible from inside the tests — the packaged build
 * resolved `vendor/` to a sibling directory that does not exist, because a fixed
 * `../..` is correct for `src/run/` and one level too high for `lib/`.
 *
 * v0.3 changed what "the whole loop" means. It used to mean manufacturing a candidate,
 * running fourteen visual gates, recording a verdict and promoting a file — all of
 * which is gone. What has to hold now is smaller and sharper:
 *
 *   1. the artifact mounts, and mounts **exactly one** tool;
 *   2. a dry run from the **bundled** code, against the **packaged** tree, compiles a
 *      prompt and produces a stable plan id — the packaging claim, since that is where
 *      the root-finding bug lived;
 *   3. the artifact carries **no** trace of the retired machinery, and the vendored
 *      tree ships only the subset v0.3 reads. Both are properties of *this* artifact,
 *      not of the repository, so this is the only place they can be checked.
 *
 * Deliberately free: nothing here sends a request or spends anything. The paid path is
 * exercised by the tool's own tests against a local server, and once, deliberately, by
 * a human.
 *
 * Usage (from the package root, after a build):
 *     node tools/verify-bundle.mjs
 *
 * Exits non-zero with a readable reason on the first failed check.
 */
import { readFileSync, readdirSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..')
const BUNDLE = join(PACKAGE_ROOT, 'lib', 'index.js')
const SKILL_ROOT = join(PACKAGE_ROOT, 'vendor', 'whalechan-image-character')

/** Fail with a readable reason. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** Every file under a directory, as posix-relative paths. */
function filesUnder(root, prefix = '') {
  const found = []
  const directory = prefix === '' ? root : join(root, ...prefix.split('/'))
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) found.push(...filesUnder(root, path))
    else found.push(path)
  }
  return found
}

async function main() {
  check(existsSync(BUNDLE), `no bundle at ${BUNDLE} — run the build first`)
  check(existsSync(SKILL_ROOT), `no vendored tree at ${SKILL_ROOT}`)

  const bundle = await import(new URL(`file://${BUNDLE.replace(/\\/g, '/')}`).href)

  // 1. Contract and mount. A cordis plugin is name / inject / Config / apply, and the
  //    surface is one tool — a second registration would be a different plugin.
  for (const name of ['apply', 'imageRun', 'planDigest', 'composeImages', 'loadCatalog']) {
    check(typeof bundle[name] === 'function', `the bundle does not export ${name}`)
  }
  check(bundle.name === 'whalechan', `the bundle reports the plugin name ${String(bundle.name)}`)
  check(Array.isArray(bundle.inject) && bundle.inject.includes('tools'), 'the bundle must inject tools')

  const definitions = []
  const ctx = {
    tools: { register: definition => { definitions.push(definition); return () => {} } },
    inject: (_names, callback) => { callback({ get: () => undefined }); return () => {} },
  }
  const dispose = bundle.apply(ctx, { dataRoot: join(mkdtempSync(join(tmpdir(), 'whalechan-bundle-')), 'data') })
  check(definitions.length === 1, `the bundle registered ${definitions.length} tools, expected exactly 1`)
  check(definitions[0].name === 'whalechan_image', `the tool is named ${String(definitions[0].name)}`)
  check(typeof definitions[0].execute === 'function', 'the registered tool has no execute')
  check(typeof definitions[0].parameters === 'object', 'the registered tool has no parameter schema')
  check(typeof definitions[0].output?.schema === 'object', 'the registered tool has no output schema')
  const properties = Object.keys(definitions[0].parameters.properties ?? {}).sort()
  check(
    properties.join(',') === 'confirm,count,form,model,plan_id,prompt,ratio',
    `the tool takes ${properties.join(', ')} — the surface is meant to be seven arguments and no more`,
  )
  // What the surface costs on **every** model call, in every session, forever. Measured
  // against the real request header: the host sends `name`, `description` and
  // `parameters` — not the output schema, which is host-side — so those three are what
  // is counted here. v0.2.x shipped six tools and 7.34 KB, which was 14% of the whole
  // tool prefix. The ceiling is a tripwire, not a target.
  const schemaBytes = definitions.reduce((sum, definition) => sum + Buffer.byteLength(
    JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters }),
    'utf8',
  ), 0)
  check(schemaBytes < 1700, `the tool surface costs ${schemaBytes} bytes on every request; the ceiling is 1700`)
  if (typeof dispose === 'function') dispose()

  // 2. A dry run from the packaged code against the packaged tree. This is the
  //    root-finding claim: `findPackageRoot` walks up from `lib/`, and the vendored
  //    engine has to be found from there or nothing works on a real host.
  const view = {
    defaultModel: '',
    defaultChannelId: 'bundle',
    models: [{ alias: 'qwen-image-3.0', channelId: 'bundle', channelName: 'aliyun' }],
  }
  const deps = {
    resolveConfig: () => ({ dataRoot: join(tmpdir(), 'whalechan-bundle-dry') }),
    endpointSources: () => ({ explicit: 'http://127.0.0.1:1' }),
    describe: async () => view,
  }
  const args = { prompt: 'sitting on the floor eating a bowl of white rice, smiling' }
  const plan = await bundle.imageRun(args, deps)
  check(plan.dry_run === true, 'the default must be a dry run')
  check(plan.images.length === 0, 'a dry run produced files')
  check(plan.plan_id.length === 64, `the plan id is ${plan.plan_id.length} characters`)
  check(plan.prompt.length > 0 && plan.prompt.includes('white rice'), 'the compiled prompt is missing the scene')
  check(plan.form === 'semi-chibi', `the default form resolved to ${plan.form}`)
  check(plan.deliverable_ratios.length === 5, `the channel report lists ${plan.deliverable_ratios.length} ratios`)
  const again = await bundle.imageRun(args, deps)
  check(again.plan_id === plan.plan_id, 'the same request planned to two different ids')
  check(bundle.planDigest({ model: 'a', size: 'b', ratio: 'c', count: 1, prompts: [] }).length === 64, 'planDigest is not a sha256')

  // 3a. The artifact carries no retired machinery. A comic-half or QA-gate string here
  //     would mean the build pulled it back in from somewhere.
  const bundleText = readFileSync(BUNDLE, 'utf8')
  const RETIRED = [
    'record-candidate', 'measure-form', 'validate-image', 'checkQa', 'promoteCandidate',
    'form_evidence', 'measurement_overlay', 'candidate_index', 'python-comic', 'punchline_peak',
  ]
  for (const marker of RETIRED) {
    check(!bundleText.includes(marker), `the bundle still carries retired machinery: ${marker}`)
  }

  // 3b. The vendored tree ships the runtime subset and nothing else. The engine and the
  //     prose with it are gone; what remains is one catalogue and the reference images.
  const vendored = filesUnder(SKILL_ROOT).sort()
  check(vendored.includes('references/reference-catalog.json'), 'the catalogue is not vendored')
  const unexpected = vendored.filter(path => !path.startsWith('assets/') && path !== 'references/reference-catalog.json')
  check(unexpected.length === 0, `the vendored tree carries files v0.3 does not read: ${unexpected.join(', ')}`)
  check(vendored.filter(path => path.endsWith('.webp')).length === 15, 'the reference images are incomplete')
  check(!existsSync(join(SKILL_ROOT, 'scripts')), 'the vendored Python engine is still present')
  check(!existsSync(join(SKILL_ROOT, 'SKILL.md')), 'SKILL.md is still vendored')

  process.stdout.write(
    `bundle verification passed\n`
      + `  bundle      ${BUNDLE}\n`
      + `  tools       ${definitions.map(definition => definition.name).join(', ')} (${schemaBytes} bytes on every request)\n`
      + `  plan        ${plan.plan_id.slice(0, 16)}… (${plan.prompt.length} characters, ${plan.form}, ${plan.size})\n`
      + `  vendored    ${vendored.length} files (${relative(PACKAGE_ROOT, SKILL_ROOT)}) — catalogue + 15 references\n`
      + `  retired     no QA, run-state or Python machinery in the artifact\n`,
  )
}

try {
  await main()
} catch (error) {
  process.stderr.write(`bundle verification FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
