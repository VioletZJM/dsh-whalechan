/**
 * dsh-whalechan — host half.
 *
 * The whole surface is one tool. `whalechan_image` either returns the exact prompt
 * that would be sent (free) or draws the picture (paid), and the plugin assembles
 * everything in between: form, identity anchor, canonical style, geometry, budget.
 *
 * That shape is a deliberate reduction. The measured first delivery (§68 of the
 * charter) spent 98 model steps and 11.9M tokens, of which the plugin's own code was
 * 6.7% of the wall clock and 1.1% of the conversation — and the single largest cost
 * was the *model* authoring a thirty-field assignment document that this plugin now
 * writes for itself, plus fourteen visual gates that failed a picture its owner
 * liked. So the gates are gone, the schema is internal, and what remains is the part
 * that was load-bearing all along: a plan a human can read before the money leaves.
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerDelivery } from './run/deliver.ts'
import { describeImagegen } from './run/imagegen.ts'
import { describeImagegenBase, hostAddressOf, type EndpointSources } from './run/endpoint.ts'
import { resolveDataRoot, writeLoadReceipt } from './run/state.ts'
import { STATUS_PATH, registerStatusRoute, type WebServerLike } from './routes.ts'
import { Config, type Config as WhalechanConfig } from './settings.ts'
import { IMAGE_TOOL_NAME, registerImageTool } from './tools/image.ts'
import { VERSION } from './version.ts'

export { Config } from './settings.ts'
export { VERSION } from './version.ts'

/** Stable cordis plugin name; matches `id: whalechan` in cordis.patch.yml. */
export const name = 'whalechan'

/** Services required before the tool surface can mount. */
export const inject = ['tools']

/**
 * Internals re-exported so the plugin can be inspected from outside the host
 * process — the same reason the status route exists. `lib/index.js` is a plain
 * ESM module: `import()` it and read the compiler's behaviour without a session.
 */
export { channelReport, deliverableRatios, geometryTable, ratioOf, resolveGeometry, type ChannelReport, type Geometry } from './domain/geometry.ts'
export { channelFamily, promptLimit, type ChannelFamily } from './domain/family.ts'
export { WhalechanError, classifyEndpointError, classifyHttp, SAFETY_HINTS, type ErrorCategory } from './domain/errors.ts'
export { identifyImage, readImageHeader, type ImageHeader } from './domain/image-header.ts'
export { formatGeneral, isClose, pythonFloatRepr, pythonJsonString, pythonRound } from './domain/python-compat.ts'
export {
  DEFAULT_BACKGROUND,
  DEFAULT_COSTUME,
  DEFAULT_STYLE,
  catalogPath,
  composeImages,
  loadCatalog,
  resolveForm,
  type Catalog,
  type CatalogForm,
  type Composed,
  type ComposedImage,
  type FormChoice,
} from './domain/compose.ts'
export {
  COSTUME_CANONICAL,
  DEFAULT_MAX_CHARS,
  FRAMING,
  HARD_MAX_CHARS,
  IDENTITY,
  NO_TEXT,
  PRESET_HEADS,
  PromptError,
  STYLE_CANONICAL,
  backgroundBlock,
  compileBlocks,
  compilePrompt,
  descriptionBlock,
  findImage,
  proportionBlock,
  propsBlock,
  render,
  requireSchemaVersion,
  sceneBlock,
  textBlock,
  type BlockSize,
  type CompiledPrompt,
} from './domain/prompt/character.ts'
export {
  DEFAULT_TIMEOUT_MS,
  decodeImage,
  extensionOf,
  imageDataUrl,
  mimeOfFormat,
  requestImage,
  writeImage,
  type ClientOptions,
  type GenerateWireImage,
  type GenerateWireRequest,
} from './run/client.ts'
export {
  IMAGEGEN_GENERATE_PATH,
  IMAGEGEN_SETTINGS_DESCRIBE_PATH,
  describeImagegenBase,
  hostAddressOf,
  joinUrl,
  normalizeBase,
  resolveImagegenBase,
  type EndpointSources,
  type ImagegenBaseSource,
} from './run/endpoint.ts'
export { describeImagegen, readSettingsView, resolveModel, resolveModelChoice, type ImagegenSettingsView, type ModelChoice, type ModelSource } from './run/imagegen.ts'
export { canonicalJson } from './run/plan.ts'
export { bootedProfile, type BootedProfile } from './run/profile.ts'
export { defaultDataRoot, resolveDataRoot, writeLoadReceipt, type HostEnv, type LoadReceipt } from './run/state.ts'
export {
  CHARACTER_SKILL_NAME,
  CHARACTER_SKILL_ROOT,
  PROVENANCE_PATH,
  REPO_ROOT,
  SKILL_VENDORS,
  VENDOR_ROOT,
  findPackageRoot,
  isVendoredPath,
  provenanceText,
  readProvenance,
  treeDigest,
  type SkillVendor,
  type TreeDigest,
  type VendorProvenance,
  type VendorRecord,
} from './run/vendor.ts'
export { STATUS_PATH, isLoopback, registerStatusRoute, type WebServerLike } from './routes.ts'
export {
  DEFAULT_RATIO,
  IMAGE_TOOL_NAME,
  imageRun,
  planDigest,
  registerImageTool,
  renderImage,
  type ImageToolDeps,
  type ImageToolValue,
} from './tools/image.ts'
export {
  createDelivery,
  registerDelivery,
  type DeliverableFile,
  type DeliverFiles,
  type DeliveryOutcome,
  type ProjectionsLike,
} from './run/deliver.ts'

/**
 * Mount the plugin.
 * @param ctx - host context; `tools` is guaranteed by {@link inject}.
 * @param config - validated composition-entry configuration.
 */
export function apply(ctx: Context, config?: WhalechanConfig): (() => void) | void {
  // Resolve configuration per call rather than once: a settings-backed source is
  // installed later, and the tool must always see the live value.
  const resolveConfig = (): WhalechanConfig => config ?? {}

  // Primary discovery source for the imagegen host: the web server's own listening
  // port. Measured fact — `DSH_WEB_URL` is injected into the shells the host *spawns*,
  // not into the host process, so inside a plugin it is empty even when the host is
  // serving on a port.
  let readHostAddress = (): string | undefined => undefined
  const endpointSources = (): EndpointSources => ({
    explicit: resolveConfig().imagegenBaseUrl,
    hostAddress: readHostAddress(),
    env: process.env,
  })

  /**
   * Whether the delivery seam bound to this mount.
   *
   * A mutable holder rather than the seam object itself, for a reason that has bitten
   * this file twice now: a cordis `inject` may call back **synchronously**, inside
   * `registerDelivery`, so the object it is about to return is still in its temporal
   * dead zone when the callback wants to write a receipt. The placeholder write at the
   * end of `apply` runs after the assignment, so the receipt a reader finds is always
   * the measured one.
   */
  let deliveryBound = (): boolean => false

  /**
   * Write the load receipt, best-effort; never a reason for `apply` to fail.
   *
   * Called **three times on purpose**: at mount, and again when each soft seam
   * settles. Before the listener binds, the only base URL available can be an
   * inherited `DSH_WEB_URL`, which may name a *different* host — that is not
   * hypothetical, it is what the first real run recorded (another host's port). The
   * later writes replace that with the measured address and add whether the delivery
   * seam bound, so the receipt records a measurement rather than an inherited claim.
   * Defined **before** the injections: a cordis `inject` may call back synchronously,
   * and a `const` declared below it is then still in its temporal dead zone — measured
   * twice, as `verify-bundle` failing with "Cannot access 'writeReceipt' before
   * initialization" and then "Cannot access 'delivery' before initialization".
   */
  const writeReceipt = (): void => {
    const described = describeImagegenBase(endpointSources())
    void writeLoadReceipt(resolveDataRoot(resolveConfig().dataRoot, process.env), {
      tools: [IMAGE_TOOL_NAME],
      webUrl: readHostAddress() ?? '',
      imagegenBase: described.base,
      imagegenBaseSource: described.source,
      delivery: deliveryBound(),
    })
  }

  /**
   * The delivery seam: how a drawn file reaches the user without the agent.
   *
   * A soft seam like the web server, and for the same reason — a host that composes
   * no `sessionProjections` must still get the tool. When nothing binds, the delivered
   * result says so and names the file, which is strictly better than a paid picture
   * nobody can find. Whether it bound is recorded in the load receipt and in the
   * status route, so "does this host deliver pictures by itself?" is a question a
   * reader can answer without spending anything.
   */
  const delivery = registerDelivery(ctx, () => { writeReceipt() })
  deliveryBound = delivery.bound

  const disposers: Array<() => void> = [
    registerImageTool(ctx, {
      resolveConfig,
      endpointSources,
      describe: sources => describeImagegen(sources),
      deliver: delivery.deliver,
    }),
  ]

  // Soft seam: a host with no web server still gets the tool, and reports
  // `unavailable` with instructions instead of failing to mount.
  ctx.inject(['webServer'], sctx => {
    const server = sctx.get('webServer') as WebServerLike | undefined
    readHostAddress = () => hostAddressOf(server?.port)
    writeReceipt()
    const disposeRoute =
      server === undefined
        ? (): void => {}
        : registerStatusRoute(server, {
            version: VERSION,
            tools: [IMAGE_TOOL_NAME],
            endpointSources,
            resolveConfig,
            describe: sources => describeImagegen(sources),
            delivery: () => delivery.bound(),
          })
    return () => {
      disposeRoute()
      readHostAddress = () => undefined
    }
  })

  // The placeholder receipt. On a host whose web server has not bound yet this
  // records an inherited `DSH_WEB_URL` and says so via `imagegenBaseSource`; the
  // injection above rewrites it with the measured address.
  writeReceipt()

  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

export { Config as WhalechanConfigSchema }
