#!/usr/bin/env node
/**
 * Verify the **installed** copy inside the profile that will load it.
 *
 * `verify-bundle.mjs` answers "is this artifact correct". This answers a different
 * question, and it is the one that has actually burned this project twice:
 *
 *   - a `link:` install made the plugin resolve `@deepseek-ai/dsh-tools` from the
 *     *development checkout* instead of the host, putting two copies of the framework
 *     in one process;
 *   - a rebuilt tarball under the same name left `pnpm` saying "Already up to date",
 *     so the host kept loading the previous build while every local gate was green.
 *
 * Both were invisible to every check that ran from the repository. So this one starts
 * at `<profile>/node_modules/dsh-whalechan` and asks the questions the host will ask:
 * which framework copy does this resolve, does it mount, does a dry run compile, and
 * does the plan gate refuse a confirmed call that carries no plan id.
 *
 * Free and offline: nothing here sends a request. The paid path is exercised once, by
 * a human, on purpose.
 *
 * The framework packages are the host's (they are peer dependencies, and on the desktop
 * host they live inside `app.asar`). When plain Node cannot reach them, this gate
 * supplies this repository's own pinned copy through `tools/framework-supply.mjs` and
 * says so in its output, rather than reporting a broken install that does not exist.
 *
 * Usage:
 *     node tools/verify-install.mjs [profile]      # default profile: desktop
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROFILE = process.argv[2] ?? 'desktop'
const PROFILE_DIR = join(homedir(), '.dsh', 'profiles', PROFILE)
const INSTALLED = join(PROFILE_DIR, 'node_modules', 'dsh-whalechan')
const ENTRY = join(INSTALLED, 'lib', 'index.js')
const REPO_ROOT = join(import.meta.dirname, '..')

/** Fail with a readable reason. */
function check(condition, message) {
  if (!condition) throw new Error(message)
}

/** The version a package.json declares. */
function versionOf(manifest) {
  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

/** sha256 of a file, as the platform reports it. */
function sha256(path) {
  const { createHash } = require('node:crypto')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const require = createRequire(import.meta.url)

/** Every file under a directory, posix-relative. */
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
  check(existsSync(ENTRY), `no installed plugin at ${ENTRY} — is dsh-whalechan in the "${PROFILE}" profile?`)

  // 1. The installed build is the build that passed the gates. This is the assertion
  //    that would have caught "Already up to date".
  const installedSha = sha256(ENTRY)
  const builtSha = sha256(join(REPO_ROOT, 'lib', 'index.js'))
  const installedVersion = versionOf(join(INSTALLED, 'package.json'))
  const builtVersion = versionOf(join(REPO_ROOT, 'package.json'))
  check(
    installedSha === builtSha,
    `the installed lib/index.js (${installedSha.slice(0, 16)}…) is not this checkout's build `
      + `(${builtSha.slice(0, 16)}…). Re-pack and \`dsh plugin --profile ${PROFILE} add\` the new tarball; `
      + 'a changed file under an unchanged spec is not a changed install.',
  )
  check(installedVersion === builtVersion, `installed v${installedVersion} vs checkout v${builtVersion}`)

  // 2. Which framework copy does the installed plugin resolve? A plugin must never
  //    carry its own copy of the framework: a `link:` install made it resolve
  //    `@deepseek-ai/dsh-tools` from the development checkout, putting two copies of
  //    the framework in one host process.
  //
  //    Measured 2026-10-10, and the reason this is not a one-line assertion any more:
  //    when the host supplies the peer framework itself, plain Node **cannot** resolve
  //    the specifier at all — the desktop runtime owns it, the installed plugin has no
  //    `node_modules`, and the copies under `~/.dsh/profiles/node_modules` are stale
  //    junctions into a development tree that has since been deleted. The plugin still
  //    mounts, with `delivery: true`, in the live host. So "unresolvable" is the
  //    host-provided case, not a broken install; the previous version of this gate
  //    passed only because that development tree happened to still exist, and turned
  //    red the moment it was cleaned — a failure with no defect behind it.
  //
  //    Both branches therefore assert something real:
  //      - resolvable   -> it must not live inside the plugin (the `link:` signature);
  //      - unresolvable -> the manifest must declare the peer, and the plugin must not
  //        ship a nested `node_modules` that could shadow it.
  const resolveFrom = createRequire(ENTRY)
  let framework = ''
  try {
    framework = resolveFrom.resolve('@deepseek-ai/dsh-tools')
  } catch {
    framework = ''
  }
  const installedManifest = JSON.parse(readFileSync(join(INSTALLED, 'package.json'), 'utf8'))
  const nestedModules = join(INSTALLED, 'node_modules')
  let frameworkNote
  if (framework !== '') {
    check(
      !framework.startsWith(INSTALLED),
      `the installed plugin resolves @deepseek-ai/dsh-tools from inside itself (${framework}). That is what a `
        + '`link:` install does, and it puts two copies of the framework in one host process.',
    )
    frameworkNote = `@deepseek-ai/dsh-tools ${versionOf(join(dirname(framework), '..', 'package.json'))} `
      + `resolved from ${framework}, not from inside the plugin`
  } else {
    check(
      installedManifest.peerDependencies?.['@deepseek-ai/dsh-tools'] !== undefined,
      'the installed plugin neither resolves @deepseek-ai/dsh-tools nor declares it as a peer dependency: '
        + 'nothing supplies it, so every import of it fails',
    )
    check(
      !existsSync(nestedModules),
      `the installed plugin ships its own node_modules (${nestedModules}) at the same time as the framework is `
        + 'unresolvable from Node — that nested copy is what a `link:` install shadows the host with',
    )
    // Supply the host-owned peer ourselves, so the mount and dry-run assertions below
    // still run. See tools/framework-supply.mjs for why this is not a workaround.
    const supply = join(REPO_ROOT, 'tools', 'framework-supply.mjs')
    check(
      existsSync(supply),
      `the framework is unresolvable from Node and ${supply} is missing, so this gate cannot import the `
        + 'installed bundle at all',
    )
    const { register } = await import('node:module')
    register('./framework-supply.mjs', import.meta.url)
    frameworkNote = '@deepseek-ai/dsh-tools is the host\'s; this gate supplies this repository\'s '
      + 'devDependency copy via tools/framework-supply.mjs (the host copy lives inside app.asar, '
      + 'which plain Node cannot read)'
  }

  // 3. Mount it, the way the host mounts it, and count what it registers.
  const bundle = await import(pathToFileURL(ENTRY).href)
  check(bundle.name === 'whalechan', `the installed bundle reports the plugin name ${String(bundle.name)}`)
  const definitions = []
  const ctx = {
    tools: { register: definition => { definitions.push(definition); return () => {} } },
    inject: (_names, callback) => { callback({ get: () => undefined }); return () => {} },
  }
  const dispose = bundle.apply(ctx, { dataRoot: join(process.env['TEMP'] ?? PROFILE_DIR, 'whalechan-verify-install') })
  check(definitions.length === 1, `the installed bundle registered ${definitions.length} tools, expected exactly 1`)
  check(definitions[0].name === 'whalechan_image', `the installed tool is named ${String(definitions[0].name)}`)
  const schemaBytes = Buffer.byteLength(JSON.stringify({
    name: definitions[0].name,
    description: definitions[0].description,
    parameters: definitions[0].parameters,
  }), 'utf8')
  if (typeof dispose === 'function') dispose()

  // 4. A dry run against the **installed** vendored tree: the packaging claim the host
  //    depends on, and the one that would fail if the tree were incomplete.
  const plan = await bundle.imageRun(
    { prompt: 'sitting on the floor eating a bowl of white rice, smiling' },
    {
      resolveConfig: () => ({ dataRoot: join(process.env['TEMP'] ?? PROFILE_DIR, 'whalechan-verify-install') }),
      endpointSources: () => ({ explicit: 'http://127.0.0.1:1' }),
      describe: async () => ({
        defaultModel: '',
        defaultChannelId: 'verify',
        models: [{ alias: 'qwen-image-3.0', channelId: 'verify', channelName: 'aliyun' }],
      }),
    },
  )
  check(plan.dry_run === true, 'the default must be a dry run')
  check(plan.images.length === 0, 'the dry run wrote files')
  check(plan.plan_id.length === 64, `the plan id is ${plan.plan_id.length} characters`)
  check(plan.prompt.includes('white rice'), 'the compiled prompt is missing the scene')
  check(plan.deliverable_ratios.length === 5, `the channel report lists ${plan.deliverable_ratios.length} ratios`)

  // 4b. …and the same again with a **head count**, because that is the input a human
  //     actually types and the one every other check ignored. `form: "3头身"` compiles
  //     through a different branch than the default preset; the branch shipped with a
  //     field name only the compiler knew about, and the first real request died with
  //     the compiler's own refusal while all six gates were green. A gate that only
  //     exercises the default has a hole shaped exactly like the other paths.
  const counted = await bundle.imageRun(
    { prompt: 'sitting on the floor eating a bowl of white rice, smiling', form: '3头身', ratio: '1:1' },
    {
      resolveConfig: () => ({ dataRoot: join(process.env['TEMP'] ?? PROFILE_DIR, 'whalechan-verify-install') }),
      endpointSources: () => ({ explicit: 'http://127.0.0.1:1' }),
      describe: async () => ({
        defaultModel: '',
        defaultChannelId: 'verify',
        models: [{ alias: 'qwen-image-3.0', channelId: 'verify', channelName: 'aliyun' }],
      }),
    },
  )
  check(
    /Proportion: 3 heads tall total/.test(counted.prompt),
    'a head count did not compile to the number the caller gave, which is the whole point of the mode',
  )

  // 4c. The delivery is one line, and the plugin hands the file over itself (§73).
  //     Checked on the **installed** bundle because it is the shape the host reads on
  //     every completed call, and because the version that shipped before this leg
  //     printed the whole compiled prompt, the plan id and the file path on the
  //     delivery line — a markdown document arriving after the picture, which is
  //     exactly what the user reported. A gate that only checks the dry run has a hole
  //     shaped like the path a human actually takes.
  const delivered = {
    dry_run: false,
    plan_id: 'f'.repeat(64),
    model: 'qwen-image-3.0',
    model_source: 'the plugin setting defaultModel',
    channel_family: 'qwen',
    prompt_ceiling: 800,
    ratio: '1:1',
    size: '1:1',
    expected_pixels: '2048x2048',
    deliverable_ratios: ['1:1'],
    form: 'semi-chibi',
    form_because: 'no form was named.',
    count: 1,
    prompt: 'PROMPT-TEXT-THAT-MUST-NOT-BE-REPEATED',
    prompt_chars: 33,
    blocks: [],
    confirmation: [],
    images: [{
      name: '20261003-1839-semi-chibi-01',
      path: 'C:\\somewhere\\images\\20261003-1839-semi-chibi-01.png',
      media_type: 'image/png',
      bytes: 2856297,
      sha256: 'b'.repeat(64),
    }],
    delivered: 1,
    delivery_error: '',
  }
  const deliveryText = bundle.renderImage(delivered)
  check(
    deliveryText.length <= 220,
    `the delivered tool result is ${deliveryText.length} characters; it is supposed to be one line, not a report`,
  )
  for (const [what, needle] of [
    ['the compiled prompt', 'PROMPT-TEXT-THAT-MUST-NOT-BE-REPEATED'],
    ['the file path', '.png'],
    ['the plan id', 'f'.repeat(64)],
  ]) {
    check(!deliveryText.includes(needle), `the delivered result still repeats ${what}: ${deliveryText}`)
  }
  check(!/present/i.test(deliveryText), 'the delivered result still tells the agent to hand the image over by hand')
  const fallbackText = bundle.renderImage({ ...delivered, delivered: 0, delivery_error: 'this host has no session projections' })
  check(
    fallbackText.includes(delivered.images[0].path),
    'when the delivery is refused the result has to name the file — it is already paid for',
  )

  // 4d. …and the seam that does the handing over exists and appends the host's own
  //     event. Offline: a fake session and a fake projection, so nothing is spent.
  const appended = []
  const fakeSession = { append: (type, data) => { appended.push({ type, data }) } }
  const seam = bundle.createDelivery(() => ({ stateOf: () => ({ lastTurn: 12, openTurnStartSeq: 90 }) }))
  const outcome = await seam(
    [{ path: delivered.images[0].path, description: 'whale-chan · semi-chibi · 1:1' }],
    { callId: 'verify-call', agent: { session: fakeSession } },
  )
  check(outcome.delivered === 1 && outcome.error === '', `the delivery seam refused: ${JSON.stringify(outcome)}`)
  check(
    appended.length === 1 && appended[0].type === 'deliverables/presented' && appended[0].data.turn === 12,
    'the delivery seam did not append the host’s own deliverables/presented event',
  )
  const refusedDelivery = await seam(
    [{ path: delivered.images[0].path, description: 'x' }],
    { callId: 'verify-call', agent: { session: { append: () => { throw new Error('refused') } } } },
  )
  check(
    refusedDelivery.delivered === 0 && refusedDelivery.error.length > 0,
    'a refused delivery must come back with a reason, not thrown and not silently accepted',
  )

  // 5. The money gate, offline: a confirmed call with no plan id must be refused, and
  //    the refusal must hand the id back so the retry is one step.
  let refused = ''
  try {
    await bundle.imageRun(
      { prompt: 'sitting on the floor eating a bowl of white rice, smiling', confirm: true },
      {
        resolveConfig: () => ({ dataRoot: join(process.env['TEMP'] ?? PROFILE_DIR, 'whalechan-verify-install') }),
        endpointSources: () => ({ explicit: 'http://127.0.0.1:1' }),
        describe: async () => ({
          defaultModel: '',
          defaultChannelId: 'verify',
          models: [{ alias: 'qwen-image-3.0', channelId: 'verify', channelName: 'aliyun' }],
        }),
      },
    )
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }
  check(refused.includes(plan.plan_id), 'a confirmed call without a plan id was not refused with the id in hand')

  // 6. The installed vendored tree is the runtime subset.
  const vendor = join(INSTALLED, 'vendor', 'whalechan-image-character')
  const vendored = filesUnder(vendor)
  check(vendored.includes('references/reference-catalog.json'), 'the installed tree has no catalogue')
  check(vendored.filter(path => path.endsWith('.webp')).length === 15, 'the installed tree is missing reference images')
  check(!existsSync(join(vendor, 'scripts')), 'the installed tree still ships the Python engine')

  process.stdout.write(
    `install verification passed (profile "${PROFILE}")\n`
      + `  installed   ${INSTALLED}\n`
      + `  build       v${installedVersion}, lib ${installedSha.slice(0, 16)}… (identical to this checkout)\n`
      + `  framework   ${frameworkNote}\n`
      + `  surface     ${definitions[0].name} (${schemaBytes} bytes on every request)\n`
      + `  dry run     ${plan.plan_id.slice(0, 16)}… (${plan.prompt.length} characters, ${plan.form}, ${plan.size})\n`
      + `  head count  "3头身" compiles to ${/Proportion: [\d.]+ heads/.exec(counted.prompt)?.[0] ?? '(missing)'}\n`
      + `  delivery    ${deliveryText.length} characters, names no file; the seam declares the drawn file\n`
      + `  plan gate   a confirmed call with no plan id is refused, and names the id\n`
      + `  vendored    ${vendored.length} files — catalogue + 15 references\n`,
  )
}

try {
  await main()
} catch (error) {
  process.stderr.write(`install verification FAILED: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
