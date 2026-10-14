import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path, { dirname, isAbsolute, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { fileURLToPath } from "node:url";
//#region src/run/deliver.ts
/** A message from an unknown throwable. */
function reasonOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** A refusal, in the shape the tool renders. */
function refused(error) {
	return {
		delivered: 0,
		error
	};
}
/**
* Build the delivery seam.
*
* Bound once at mount and given to the tool, so the tool itself never touches a
* session, a projection or a call id: it hands over paths and gets back an outcome.
* @param projections - live getter for the host's projection service, which may bind
*   after this plugin mounts.
* @returns the seam, which never throws.
*/
function createDelivery(projections) {
	return async (files, exec) => {
		if (files.length === 0) return {
			delivered: 0,
			error: ""
		};
		const target = exec;
		const callId = target?.callId;
		if (typeof callId !== "string" || callId === "") return refused("this call has no id");
		const session = target?.agent?.session;
		if (session === void 0) return refused("this call has no session");
		const service = projections();
		if (service === void 0) return refused("this host has no session projections");
		let state;
		try {
			state = service.stateOf(session, "turnBoundary");
		} catch (error) {
			return refused(`the open turn could not be read: ${reasonOf(error)}`);
		}
		if (state === void 0) return refused("this session has no turn projection");
		if (state.openTurnStartSeq === null || state.openTurnStartSeq === void 0) return refused("this call is not inside an open turn");
		if (typeof state.lastTurn !== "number" || !Number.isInteger(state.lastTurn)) return refused("the open turn has no number");
		try {
			session.append("deliverables/presented", {
				turn: state.lastTurn,
				callId,
				files: files.map((file) => ({
					path: file.path,
					description: file.description
				}))
			});
		} catch (error) {
			return refused(reasonOf(error));
		}
		return {
			delivered: files.length,
			error: ""
		};
	};
}
/**
* Register the delivery seam against a host context.
*
* A **soft** injection: `sessionProjections` is what the built-in `present` tool uses,
* but a host that composes none must still get the tool — it degrades to naming the
* file. The value is read per delivery, never cached at mount.
* @param ctx - host context.
* @param onSettle - called when the injection settles, so the load receipt can record
*   whether this host delivers by itself.
* @returns the seam, plus a live answer to "did it bind?" for the status route.
*/
function registerDelivery(ctx, onSettle) {
	let service;
	ctx.inject(["sessionProjections"], (sctx) => {
		service = sctx.get("sessionProjections");
		onSettle?.();
		return () => {
			service = void 0;
		};
	});
	return {
		deliver: createDelivery(() => service),
		bound: () => service !== void 0
	};
}
//#endregion
//#region src/domain/errors.ts
/** One error type for everything this plugin throws at the model or the user. */
var WhalechanError = class extends Error {
	category;
	constructor(message, category = "service") {
		super(message);
		this.name = "WhalechanError";
		this.category = category;
	}
};
/** Map an HTTP status from the dsh-imagegen route family onto a category. */
function classifyHttp(status) {
	if (status === 401 || status === 403) return "authentication";
	if (status === 429) return "rate_limit";
	if (status >= 500) return "service";
	return "capability";
}
/** Substrings that mean "the upstream model refused this content". */
const SAFETY_HINTS = [
	"safety",
	"blocked",
	"moderation",
	"content policy",
	"敏感",
	"违规",
	"不安全"
];
/** Endpoint error codes the adapter maps to `capability` rather than `service`. */
const CAPABILITY_CODES = /* @__PURE__ */ new Set([
	"bad-request",
	"image-model-not-configured",
	"no-models-configured",
	"model-choice-required",
	"edit-unsupported",
	"no-channels",
	"edit-image-missing",
	"edit-image-invalid",
	"edit-image-too-large"
]);
/**
* Classify one `{ok:false, code, message}` body from the dsh-imagegen routes.
*
* The route family answers HTTP 200 even for failures, so the status code is
* useless here and the body carries the meaning.
*/
function classifyEndpointError(code, message) {
	const lowered = message.toLowerCase();
	for (const hint of SAFETY_HINTS) if (message.includes(hint) || lowered.includes(hint)) return "safety_rejection";
	if (CAPABILITY_CODES.has(code)) return "capability";
	if (code === "upstream-timeout") return "timeout";
	return "service";
}
//#endregion
//#region src/run/endpoint.ts
/**
* Where the dsh-imagegen route family lives.
*
* Discovery order (D4 of the rewrite charter): an explicit setting wins, then
* the address the host web server actually reports, then the host-injected
* `DSH_WEB_URL`. A missing answer is a *classified* `unavailable` failure with
* an actionable message — never a bare `Invalid URI` from deep inside `fetch`.
*/
/** Loopback-only route that turns one prompt into one candidate. */
const IMAGEGEN_GENERATE_PATH = "/api/dsh-imagegen/generate";
/** Loopback-only route that exposes the imagegen settings view. */
const IMAGEGEN_SETTINGS_DESCRIBE_PATH = "/api/dsh-imagegen/settings/describe";
/** Trim a configured base URL and drop trailing slashes. */
function normalizeBase(value) {
	if (typeof value !== "string") return "";
	return value.trim().replace(/\/+$/, "");
}
/**
* Resolve the imagegen base URL.
* @throws WhalechanError with category `unavailable` when nothing is configured.
*/
function resolveImagegenBase(sources = {}) {
	for (const [, value] of baseCandidates(sources)) if (value !== "") return value;
	throw new WhalechanError("The dsh-imagegen host could not be located: no imagegenBaseUrl setting, no host web server address, and DSH_WEB_URL is not set. Run this inside the DSH host, or set imagegenBaseUrl to that host's base URL (for example http://127.0.0.1:19387).", "unavailable");
}
/** The candidate sources, most specific first. */
function baseCandidates(sources) {
	return [
		["setting", normalizeBase(sources.explicit)],
		["host-web-server", normalizeBase(sources.hostAddress)],
		["DSH_WEB_URL", normalizeBase(sources.env?.["DSH_WEB_URL"])]
	];
}
/**
* Resolve the base URL **and say where it came from**.
*
* The source matters because the two are not equally trustworthy. A value from
* `host-web-server` was measured from this process's own listener; a value from
* `DSH_WEB_URL` is an inherited claim that may name an entirely different host —
* which is exactly what a receipt recorded the first time this plugin ran on a
* real 3080 host, where the launching shell carried another host's URL.
* @param sources - the same sources `resolveImagegenBase` reads.
* @returns the base URL (empty when none resolves) and the winning source.
*/
function describeImagegenBase(sources = {}) {
	for (const [source, value] of baseCandidates(sources)) if (value !== "") return {
		base: value,
		source
	};
	return {
		base: "",
		source: "unresolved"
	};
}
/** Join a normalized base URL with an absolute route path. */
function joinUrl(base, path) {
	return `${normalizeBase(base)}${path.startsWith("/") ? path : `/${path}`}`;
}
/**
* Loopback base URL for a host web server that reports its listening port.
*
* This is the primary discovery source, and it has to be: `DSH_WEB_URL` is
* injected into the shells the host *spawns*, not into the host process itself.
* A plugin reading `process.env.DSH_WEB_URL` inside the host gets nothing —
* measured on the local web profile, where the host process had neither
* `DSH_WEB_URL` nor `DSH_PROFILE` set.
*
* The port is 0 until the listener binds, so callers must resolve per request
* and treat `undefined` as "not ready yet" rather than as a hard failure.
*/
function hostAddressOf(port) {
	if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) return void 0;
	return `http://127.0.0.1:${port}`;
}
//#endregion
//#region src/run/imagegen.ts
/**
* The one boundary to the dsh-imagegen plugin: its published loopback route
* family. Nothing here imports that package's internals.
*/
/**
* Narrow the imagegen settings descriptor to what this plugin needs.
*
* The raw response also carries `channelSecrets` and a `secrets` index. Both are
* dropped here on purpose: nothing downstream — not a tool result, not a log,
* not the run directory — may ever hold an imagegen API key.
*/
function readSettingsView(body) {
	const namespaces = readPath(body, ["value", "namespaces"]);
	if (!Array.isArray(namespaces) || namespaces.length === 0) throw new WhalechanError("The dsh-imagegen settings view has no namespaces; is the plugin enabled?", "service");
	const namespace = namespaces[0];
	const value = readPath(namespace, ["value"]);
	if (!isRecord$1(value)) throw new WhalechanError("The dsh-imagegen settings view has no value block.", "service");
	const models = [];
	const channels = Array.isArray(value["channels"]) ? value["channels"] : [];
	for (const channel of channels) {
		if (!isRecord$1(channel)) continue;
		const channelId = typeof channel["id"] === "string" ? channel["id"] : "";
		const channelName = typeof channel["name"] === "string" ? channel["name"] : "";
		const catalog = Array.isArray(channel["models"]) ? channel["models"] : [];
		for (const model of catalog) {
			if (!isRecord$1(model)) continue;
			const alias = typeof model["alias"] === "string" ? model["alias"].trim() : "";
			if (alias !== "") models.push({
				alias,
				channelId,
				channelName
			});
		}
	}
	return {
		defaultModel: typeof value["defaultModel"] === "string" ? value["defaultModel"].trim() : "",
		defaultChannelId: typeof value["defaultChannelId"] === "string" ? value["defaultChannelId"].trim() : "",
		models
	};
}
/**
* Pick the model alias to use, and record why.
*
* Precedence: an explicit request, then the plugin setting, then the imagegen
* default model, then — only when the catalogue holds exactly one alias — that
* alias. Anything else asks the caller to choose, naming the options.
*/
function resolveModelChoice(view, requested, configured) {
	const asked = requested.trim();
	if (asked !== "") return {
		alias: asked,
		source: "request"
	};
	const setting = configured.trim();
	if (setting !== "") return {
		alias: setting,
		source: "setting"
	};
	if (view.defaultModel !== "") return {
		alias: view.defaultModel,
		source: "imagegen-default"
	};
	const aliases = [...new Set(view.models.map((model) => model.alias))];
	if (aliases.length === 1) return {
		alias: aliases[0],
		source: "sole-catalogue-entry"
	};
	if (aliases.length === 0) throw new WhalechanError("No image models are configured in dsh-imagegen. Add a channel with at least one image model first.", "capability");
	throw new WhalechanError(`dsh-imagegen has no default model set and ${aliases.length} aliases are available — ask the user which one to use, then pass it as \`model\`. Options: ${aliases.join(", ")}.`, "capability");
}
/** The alias only, for callers that do not need the provenance. */
function resolveModel(view, requested, configured) {
	return resolveModelChoice(view, requested, configured).alias;
}
/** Read the live imagegen settings view over the loopback route. */
async function describeImagegen(sources, options = {}) {
	const base = resolveImagegenBase(sources);
	const response = await (options.fetchImpl ?? fetch)(joinUrl(base, IMAGEGEN_SETTINGS_DESCRIBE_PATH), {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json"
		},
		body: "{}",
		signal: AbortSignal.timeout(options.timeoutMs ?? 15e3)
	});
	if (!response.ok) throw new WhalechanError(`dsh-imagegen answered ${response.status} for its settings view. Check that the imagegen plugin is installed and enabled on this host.`, classifyHttp(response.status));
	let body;
	try {
		body = await response.json();
	} catch {
		throw new WhalechanError("dsh-imagegen returned a settings view that is not JSON.", "service");
	}
	if (readPath(body, ["ok"]) !== true) {
		const code = typeof readPath(body, ["code"]) === "string" ? String(readPath(body, ["code"])) : "";
		const message = typeof readPath(body, ["message"]) === "string" ? String(readPath(body, ["message"])) : "unknown error";
		throw new WhalechanError(`dsh-imagegen refused the settings read: ${message}`, classifyEndpointError(code, message));
	}
	return readSettingsView(body);
}
/** Narrow `unknown` to a plain object. */
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read one nested key without trusting any level of the shape. */
function readPath(value, keys) {
	let cursor = value;
	for (const key of keys) {
		if (!isRecord$1(cursor)) return void 0;
		cursor = cursor[key];
	}
	return cursor;
}
//#endregion
//#region src/version.ts
/** The version stamped in at build time. */
const VERSION = "0.5.0";
//#endregion
//#region src/run/profile.ts
/** Flags whose *next* argument is a value rather than a positional. */
const VALUE_FLAGS = /* @__PURE__ */ new Set([
	"--import",
	"--profile",
	"--patch",
	"--from-default-profile",
	"--require",
	"-r"
]);
/** Does this token look like a path or a script rather than a profile name? */
function looksLikePath(token) {
	return token.includes("/") || token.includes("\\") || /\.(?:js|mjs|cjs|ts|exe)$/i.test(token);
}
/**
* Read the profile name out of an argv vector.
* @param argv - the process's own `argv`.
* @returns the name, or an empty one with source `default`.
*/
function bootedProfile(argv) {
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index] ?? "";
		if (token === "--profile") {
			const name = (argv[index + 1] ?? "").trim();
			return name === "" ? {
				profile: "",
				source: "default"
			} : {
				profile: name,
				source: "argv"
			};
		}
		if (VALUE_FLAGS.has(token)) {
			index += 1;
			continue;
		}
		if (token.startsWith("-")) continue;
		if (index === 0 || looksLikePath(token)) continue;
		return {
			profile: token,
			source: "argv"
		};
	}
	return {
		profile: "",
		source: "default"
	};
}
//#endregion
//#region src/run/state.ts
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
/** Default data root: `<DSH_HOME>/dsh-whalechan`, then the user home. */
function defaultDataRoot(env) {
	const home = env.DSH_HOME?.trim() !== void 0 && env.DSH_HOME.trim() !== "" ? env.DSH_HOME.trim() : path.join(homedir(), ".dsh");
	return path.join(home, "dsh-whalechan");
}
/** Resolve a configured data root, falling back to the default. */
function resolveDataRoot(configured, env) {
	const value = typeof configured === "string" ? configured.trim() : "";
	return value !== "" ? value : defaultDataRoot(env);
}
/**
* Write the load receipt, best-effort.
* @returns the receipt path, whether or not the write succeeded.
*/
async function writeLoadReceipt(root, input) {
	const target = path.join(root, "state", "loaded.json");
	const receipt = {
		plugin: "dsh-whalechan",
		version: VERSION,
		appliedAt: (/* @__PURE__ */ new Date()).toISOString(),
		pid: process.pid,
		profile: bootedProfile(process.argv).profile,
		webUrl: input.webUrl,
		imagegenBase: input.imagegenBase,
		imagegenBaseSource: input.imagegenBaseSource,
		delivery: input.delivery,
		tools: [...input.tools]
	};
	try {
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	} catch {}
	return target;
}
//#endregion
//#region src/domain/family.ts
/** Detection order matters — keep it identical to the plugin's own list. */
const FAMILY_RULES = [
	{
		family: "gpt-image",
		pattern: /^gpt-image/i
	},
	{
		family: "dall-e",
		pattern: /^dall-e/i
	},
	{
		family: "grok",
		pattern: /^grok-imagine(?:-|$)/i
	},
	{
		family: "nanobanana",
		pattern: /^nanobanana|^(?:gemini-3-pro-image|gemini-3-pro-image-preview|gemini-3\.1-flash-image|gemini-3\.1-flash-image-preview|gemini-3\.1-flash-lite-image|gemini-2\.5-flash-image)$/i
	},
	{
		family: "seedream",
		pattern: /^(?:doubao-)?seedream/i
	},
	{
		family: "zhipu",
		pattern: /^(?:glm-image|cogview)(?:-|$)/i
	},
	{
		family: "qwen",
		pattern: /^qwen-image(?:[-_.]|$)/i
	},
	{
		family: "minimax",
		pattern: /^(?:minimax[-_/])?image-\d+/i
	}
];
/** Documented upstream prompt ceilings, in characters, per family. */
const PROMPT_LIMITS = {
	zhipu: 800,
	minimax: 1500
};
/** The plugin's protocol family for one model alias, or `unknown`. */
function channelFamily(model) {
	const trimmed = model.trim();
	for (const rule of FAMILY_RULES) if (rule.pattern.test(trimmed)) return rule.family;
	return "unknown";
}
/** Qwen-Image ships two geometry tiers; only the dotted ids are the new one. */
function isVersionedQwen(model) {
	return /^qwen-image-\d+\.\d/i.test(model.trim());
}
/** Prompt character ceiling for one family. */
function promptLimit(family) {
	return PROMPT_LIMITS[family] ?? 4e3;
}
/** Only the 智谱 image models are text-to-image-only in this plugin. */
function referencesSupported(family) {
	return family !== "zhipu";
}
/** Only the gpt-image family has a verified native transparent-output contract. */
function transparencySupported(family) {
	return family === "gpt-image";
}
//#endregion
//#region src/domain/geometry.ts
/**
* Aspect-ratio → deliverable-geometry resolution.
*
* The single most important idea here: **trust the pixels, never the panel key
* name.** The dsh-imagegen plugin's own ratio keys are sloppy — its `3:4` key
* maps to 1024×1536, which is actually 2:3 (an 11 % deviation) — so a driver
* that freezes "3:4" because the key says so records a ratio the channel never
* delivered. Labels below are always derived from the mapped pixel geometry.
*/
/** How far a channel's mapped geometry may sit from the frozen ratio. */
const RATIO_DEVIATION_LIMIT = .005;
/**
* Panel-ratio → pixels for OpenAI-shaped channels. 智谱 and the OpenAI families
* all fall through to this table in the plugin.
*/
const OPENAI_SIZE_BY_RATIO = {
	"1:1": "1024x1024",
	"3:4": "1024x1536",
	"4:3": "1536x1024",
	"9:16": "1024x1792",
	"2:3": "1024x1536",
	"3:2": "1536x1024",
	"16:9": "1792x1024",
	"21:9": "1792x1024"
};
/** DashScope size vocabulary for the classic Qwen-Image tier. */
const QWEN_CLASSIC_SIZES = {
	"16:9": "1664*928",
	"21:9": "1664*928",
	"4:3": "1472*1104",
	"3:2": "1472*1104",
	"1:1": "1328*1328",
	"3:4": "1104*1472",
	"2:3": "1104*1472",
	"9:16": "928*1664"
};
/** DashScope size vocabulary for the versioned Qwen-Image tier. */
const QWEN_HD_SIZES = {
	"16:9": "2688*1536",
	"21:9": "2688*1536",
	"4:3": "2368*1728",
	"3:2": "2368*1728",
	"1:1": "2048*2048",
	"3:4": "1728*2368",
	"2:3": "1728*2368",
	"9:16": "1536*2688"
};
/** Families that dial the ratio natively and let the provider choose pixels. */
const NATIVE_RATIO_FAMILIES = /* @__PURE__ */ new Set([
	"grok",
	"nanobanana",
	"minimax"
]);
/** The only ratios MiniMax's native API accepts. */
const MINIMAX_RATIOS = [
	"1:1",
	"16:9",
	"4:3",
	"3:2",
	"2:3",
	"3:4",
	"9:16",
	"21:9"
];
/** Greatest common divisor; used to reduce a pixel pair to a `W:H` label. */
function gcd(a, b) {
	let x = Math.abs(a);
	let y = Math.abs(b);
	while (y !== 0) {
		const next = x % y;
		x = y;
		y = next;
	}
	return x;
}
/** Split a `W:H` key or a `WxH` / `W*H` pixel string into two positive numbers. */
function pairOf(value) {
	const parts = value.trim().split(/[x*:]/);
	const width = Number(parts[0]);
	const height = Number(parts[1]);
	if (parts.length !== 2 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new WhalechanError(`cannot read a WIDTH:HEIGHT ratio from ${JSON.stringify(value)}`, "capability");
	return [width, height];
}
/** Aspect ratio of either a `W:H` key or a `WxH` / `W*H` pixel string. */
function ratioOf(value) {
	const [width, height] = pairOf(value);
	return width / height;
}
/** The exact aspect ratio of a pixel string, as a reduced `W:H` label. */
function ratioLabel(pixels) {
	const [width, height] = pairOf(pixels);
	const divisor = gcd(width, height) || 1;
	return `${width / divisor}:${height / divisor}`;
}
/** Ratio → pixels for families whose plugin path sends explicit pixels. */
function geometryTable(family, model) {
	if (family === "zhipu" || family === "gpt-image" || family === "dall-e" || family === "unknown") return OPENAI_SIZE_BY_RATIO;
	if (family === "qwen") return isVersionedQwen(model) ? QWEN_HD_SIZES : QWEN_CLASSIC_SIZES;
	return null;
}
/**
* Every ratio this channel delivers exactly, or `null` when the channel does
* not choose geometry at all.
*
* `null` means either "the provider decides" (Seedream's resolution tiers) or
* "the panel ratio passes through untouched" (the native-dial families).
*/
function deliverableRatios(family, model) {
	if (family === "minimax") return [...MINIMAX_RATIOS];
	if (NATIVE_RATIO_FAMILIES.has(family)) return null;
	const table = geometryTable(family, model);
	if (table === null) return null;
	const labels = [];
	for (const pixels of Object.values(table)) {
		const label = ratioLabel(pixels);
		if (!labels.includes(label)) labels.push(label);
	}
	return labels;
}
/** Human-readable list of the ratios a table can honour, plus its nearest entry. */
function describeDeliverables(table, requested) {
	if (table === null) return "any positive WIDTH:HEIGHT ratio (the provider picks the pixels)";
	const labels = [];
	for (const pixels of Object.values(table)) {
		const label = ratioLabel(pixels);
		if (!labels.includes(label)) labels.push(label);
	}
	const wanted = ratioOf(requested);
	let nearest = "";
	let nearestDeviation = Number.POSITIVE_INFINITY;
	for (const pixels of Object.values(table)) {
		const deviation = Math.abs(ratioOf(pixels) - wanted);
		if (deviation < nearestDeviation) {
			nearestDeviation = deviation;
			nearest = pixels;
		}
	}
	return `${labels.join(", ")} (nearest mapped geometry: ${nearest.replace("*", "x")})`;
}
/**
* Resolve a frozen ratio into the geometry to request.
* @throws WhalechanError with category `capability` when the channel cannot
*   deliver that ratio within {@link RATIO_DEVIATION_LIMIT}.
*/
function resolveGeometry(family, model, ratio) {
	if (NATIVE_RATIO_FAMILIES.has(family)) {
		if (family === "minimax" && !MINIMAX_RATIOS.includes(ratio)) throw new WhalechanError(`minimax accepts only ${MINIMAX_RATIOS.join(", ")}; ${ratio} is not one of them`, "capability");
		return {
			sizeKey: ratio,
			expectedPixels: null,
			ratioControl: true,
			note: "the provider dials this ratio natively and chooses the pixel size"
		};
	}
	if (family === "seedream") return {
		sizeKey: null,
		expectedPixels: null,
		ratioControl: false,
		note: "seedream receives a resolution tier only: the output ratio is provider-decided"
	};
	const table = geometryTable(family, model);
	if (table === null) throw new WhalechanError(`aspect_ratio ${ratio} cannot be resolved for the ${family} channel`, "capability");
	const wanted = ratioOf(ratio);
	let bestPixels = null;
	let bestDeviation = Number.POSITIVE_INFINITY;
	for (const pixels of Object.values(table)) {
		const deviation = Math.abs(ratioOf(pixels) - wanted) / wanted;
		if (deviation <= .005 && deviation < bestDeviation) {
			bestDeviation = deviation;
			bestPixels = pixels;
		}
	}
	if (bestPixels === null) throw new WhalechanError(`aspect_ratio ${ratio} cannot be delivered exactly by dsh-imagegen on ${family}: no entry of the channel's geometry table matches it. Freeze one of these instead — ${describeDeliverables(table, ratio)}`, "capability");
	const pixels = bestPixels.replace("*", "x");
	const candidates = Object.keys(table).filter((key) => table[key] === bestPixels);
	const exactNamed = candidates.filter((key) => Math.abs(ratioOf(key) - wanted) / wanted <= RATIO_DEVIATION_LIMIT);
	const sizeKey = (exactNamed.length > 0 ? exactNamed : candidates)[0] ?? "";
	if (family === "zhipu" && wanted === 1) return {
		sizeKey: "auto",
		expectedPixels: "1280x1280",
		ratioControl: true,
		note: "sent as `auto`: upstream applies its own 1280x1280 default"
	};
	return {
		sizeKey,
		expectedPixels: pixels,
		ratioControl: true,
		note: `the plugin maps panel key ${sizeKey} onto ${pixels} for this family`
	};
}
/**
* Capability probe: free, offline, and identical in meaning to the old
* `generate-dsh-imagegen.py --print-family` report.
* @throws WhalechanError when the alias matches no known family.
*/
function channelReport(model, capabilities = {
	channelFamily,
	promptLimit,
	referencesSupported,
	transparencySupported
}) {
	const family = capabilities.channelFamily(model);
	if (family === "unknown") throw new WhalechanError(`cannot route model alias ${JSON.stringify(model)}: it matches no known protocol family. Use a real model id — never an \`ep-...\` endpoint id.`, "capability");
	const ratios = deliverableRatios(family, model);
	return {
		ok: true,
		provider: "dsh-imagegen",
		model,
		channel_family: family,
		references_supported: capabilities.referencesSupported(family),
		transparency_supported: capabilities.transparencySupported(family),
		prompt_limit_chars: capabilities.promptLimit(family),
		ratio_control: ratios !== null || NATIVE_RATIO_FAMILIES.has(family),
		deliverable_ratios: ratios,
		recommended_reference_policy: capabilities.referencesSupported(family) ? "provider-edit" : "agent-visual-only"
	};
}
//#endregion
//#region src/routes.ts
/** Absolute pathname of the status route. */
const STATUS_PATH = "/api/dsh-whalechan/status";
/** Is this request from the loopback interface? */
function isLoopback(req) {
	const address = req.socket.remoteAddress ?? "";
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
/** Write one JSON response. */
function writeJson(res, status, body) {
	const text = `${JSON.stringify(body, null, 2)}\n`;
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(text),
		"cache-control": "no-store"
	});
	res.end(text);
}
/** The in-memory half of the report, which cannot fail. */
function baseReport(deps) {
	let base = "";
	let baseError = null;
	const booted = bootedProfile(process.argv);
	try {
		base = resolveImagegenBase(deps.endpointSources());
	} catch (error) {
		baseError = error instanceof Error ? error.message : String(error);
	}
	return {
		plugin: "dsh-whalechan",
		version: deps.version,
		pid: process.pid,
		profile: booted.profile,
		profileSource: booted.source,
		tools: [...deps.tools],
		delivery: deps.delivery(),
		imagegenBase: base,
		imagegenBaseError: baseError
	};
}
/**
* Register the status route.
* @returns the disposer cordis needs.
*/
function registerStatusRoute(server, deps) {
	return server.register({
		kind: "exact",
		path: STATUS_PATH,
		handler: async (req, res) => {
			if (!isLoopback(req)) {
				writeJson(res, 403, { error: "forbidden: loopback-only" });
				return;
			}
			if (req.method !== "GET" && req.method !== "HEAD") {
				writeJson(res, 405, { error: `method not allowed: ${req.method ?? ""}` });
				return;
			}
			const report = baseReport(deps);
			if (new URL(req.url ?? "/api/dsh-whalechan/status", "http://dsh.invalid").searchParams.get("probe") === "1" && report["imagegenBaseError"] === null) try {
				const view = await deps.describe(deps.endpointSources());
				const choice = resolveModelChoice(view, "", deps.resolveConfig().defaultModel ?? "");
				report["imagegen"] = {
					ok: true,
					model: choice.alias,
					modelSource: choice.source,
					catalogue: [...new Set(view.models.map((model) => model.alias))],
					channel: channelReport(choice.alias)
				};
			} catch (error) {
				report["imagegen"] = {
					ok: false,
					category: error instanceof WhalechanError ? error.category : "service",
					message: error instanceof Error ? error.message : String(error)
				};
			}
			writeJson(res, 200, report);
		}
	});
}
/** Validated configuration, read by cordis before `apply` runs. */
const Config = z.object({
	enabled: z.boolean().default(true),
	imagegenBaseUrl: z.string().default(""),
	defaultModel: z.string().default(""),
	dataRoot: z.string().default("")
});
//#endregion
//#region src/domain/python-compat.ts
/**
* The places JavaScript and Python disagree about numbers and strings.
*
* Every function here exists because a naive JavaScript spelling produces a
* *plausible* value that is not the one Python produces. In this project those
* values are baked into frozen assignments and digests, so the drift does not
* surface where the mistake is — it surfaces later, in another file, as a
* mismatch against a frozen assignment.
*
* Three separate Python number spellings are involved and they are not
* interchangeable:
*
* | Python | Here | `2.8` | `4.0` | `2800000.0` |
* | --- | --- | --- | --- | --- |
* | `repr(x)` | {@link pythonFloatRepr} | `2.8` | `4.0` | `2800000.0` |
* | `f"{x:g}"` | {@link formatGeneral} | `2.8` | `4` | `2.8e+06` |
* | `round(x)` | {@link pythonRound} | `3` | `4` | `2800000` |
*/
/**
* Python's `repr(float)`, restricted to the band where it stays positional.
*
* Python writes `4.0` for an integral float and JavaScript writes `4`, which
* alone would change every digest whose mean or bound happens to be integral —
* and head ratios like 4.0 and 5.0 are ordinary values here, not edge cases.
*
* Outside `1e-4 <= |value| < 1e16` Python switches to exponent notation
* (`1e+16`, `1e-05`), where reproducing it exactly is a different problem. Head
* ratios never reach that band, so this refuses rather than emits a digest it
* cannot vouch for.
* @param value - the number to render.
* @returns Python's positional `repr`, including the trailing `.0`.
*/
function pythonFloatRepr(value) {
	if (!Number.isFinite(value)) throw new RangeError(`cannot hash a non-finite number: ${String(value)}`);
	if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
	const magnitude = Math.abs(value);
	if (magnitude < 1e-4 || magnitude >= 0x2386f26fc10000) throw new RangeError(`cannot hash ${String(value)}: Python renders it in exponent form, outside the positional range this port reproduces`);
	const rendered = String(value);
	return rendered.includes(".") ? rendered : `${rendered}.0`;
}
/** Drop a fractional part that is only zeros. */
function stripTrailingZeros(text) {
	return text.includes(".") ? text.replace(/\.?0+$/, "") : text;
}
/**
* Format a number the way Python's `%g` does at its default precision of 6.
*
* This matters more than it looks: `f"{heads:g}"` is how the heads value enters
* the prompt, so a naive `String(value)` would emit `2.8000000000000003` for a
* value that Python prints as `2.8` — one character of drift, silently.
*/
function formatGeneral(value) {
	if (!Number.isFinite(value)) return String(value);
	if (value === 0) return "0";
	const exponent = Math.floor(Math.log10(Math.abs(value)));
	if (exponent < -4 || exponent >= 6) {
		const [mantissa = "", rawExponent = ""] = value.toExponential(5).split("e");
		return `${stripTrailingZeros(mantissa)}e${rawExponent.startsWith("-") ? "-" : "+"}${rawExponent.replace(/^[+-]/, "").padStart(2, "0")}`;
	}
	return stripTrailingZeros(value.toPrecision(6));
}
/**
* Round the way Python's built-in `round` does: half-to-even.
*
* `Math.round` is half-away-from-zero, so `Math.round(2.5) === 3` while
* `round(2.5) == 2`. The difference is invisible for the five built-in presets
* and visible for a custom ratio that lands exactly on a half — exactly the
* kind of drift a byte-identical port cannot afford.
* @param value - the number to round.
* @returns the nearest integer, ties to even.
*/
function pythonRound(value) {
	const floor = Math.floor(value);
	const fraction = value - floor;
	if (fraction > .5) return floor + 1;
	if (fraction < .5) return floor;
	return floor % 2 === 0 ? floor : floor + 1;
}
/** Lowercase, zero-padded, four hex digits — Python's `\u` form. */
function hex4(code) {
	return code.toString(16).padStart(4, "0");
}
/**
* JSON string escaping as `json.dumps` does it with its default
* `ensure_ascii=True`: everything outside `0x20`–`0x7E` becomes `\uXXXX`, and
* astral code points become a surrogate pair.
* @param value - the string to escape.
* @returns the quoted, escaped JSON string.
*/
function pythonJsonString(value) {
	let out = "\"";
	for (const character of value) {
		switch (character) {
			case "\"":
				out += "\\\"";
				continue;
			case "\\":
				out += "\\\\";
				continue;
			case "\n":
				out += "\\n";
				continue;
			case "\r":
				out += "\\r";
				continue;
			case "	":
				out += "\\t";
				continue;
			case "\b":
				out += "\\b";
				continue;
			case "\f":
				out += "\\f";
				continue;
			default: break;
		}
		const code = character.codePointAt(0) ?? 0;
		if (code >= 32 && code < 127) out += character;
		else if (code > 65535) {
			const offset = code - 65536;
			out += `\\u${hex4(55296 + (offset >> 10))}\\u${hex4(56320 + (offset & 1023))}`;
		} else out += `\\u${hex4(code)}`;
	}
	return `${out}"`;
}
/**
* Python's `math.isclose(a, b, rel_tol, abs_tol)`.
*
* Python's spelling is `abs(a-b) <= max(rel_tol * max(|a|,|b|), abs_tol)`, which
* is not JavaScript's usual epsilon comparison. Note that the two tolerances are
* used differently by different callers: the catalog check passes only
* `abs_tol=0.0005`, while the output-geometry check passes only `rel_tol=0.02`
* and leaves `abs_tol` at zero.
* @param left - one value.
* @param right - the other value.
* @param absoluteTolerance - the `abs_tol` argument.
* @param relativeTolerance - the `rel_tol` argument.
* @returns whether Python would call the two close.
*/
function isClose(left, right, absoluteTolerance = 0, relativeTolerance = 1e-9) {
	return Math.abs(left - right) <= Math.max(relativeTolerance * Math.max(Math.abs(left), Math.abs(right)), absoluteTolerance);
}
/** Label prefixed to every block except the identity block. */
const LABELS = {
	proportion: "Proportion: ",
	style: "Style: ",
	costume: "Costume: ",
	scene: "Scene: ",
	props: "Props: ",
	background: "Background: "
};
/** Canonical head-to-body ratios per form preset. */
const PRESET_HEADS = {
	standard: 4,
	compact: 3.3,
	"semi-chibi": 2.8,
	chibi: 2.5,
	"super-deformed": 2.1
};
/**
* Permanent identity. Constant on purpose.
*
* The proper name is deliberately absent: measured twice on this channel, the
* moment "DeepSeek Whale-chan" appears the model renders it as a poster title
* or bottom caption, which fails the X1/S1 gates. The physical description
* carries the identity instead.
*/
const IDENTITY = "Anime girl, ageless humanoid whale mascot: round face, big blue eyes, deep-blue hair, cyan tips, whale-fin ears sticking out sideways from her head (fins, not bows), a forward-curving ahoge, a single small whale tail at her lower back, correct anatomy.";
/** The no-text contract; explicit and early. */
const NO_TEXT = "NO TEXT: no title, caption, lettering, logo, signature, watermark.";
/**
* Measured on 3 of the first 6 candidates: without an explicit framing
* constraint the model crops the figure at the knees, losing the frozen
* full-body composition and every sole landmark.
*/
const FRAMING = "entire figure in frame, feet visible";
/** Canonical style, used when `image.style.mode` is `canonical`. */
const STYLE_CANONICAL = "clean rounded cel shading, navy/cyan palette.";
/** Canonical costume, used when `image.costume.mode` is `canonical`. */
const COSTUME_CANONICAL = "navy-white frilled maid dress, white apron with a blue whale emblem, white headpiece, socks, blue shoes.";
/** The channel truncates past this, so no budget may exceed it. */
const HARD_MAX_CHARS = 800;
/** Default budget: the documented 800 minus a safety margin. */
const DEFAULT_MAX_CHARS = 780;
/** A prompt that cannot be compiled within the frozen budget. */
var PromptError = class extends WhalechanError {
	/** Per-block sizes, present when the failure was a budget overflow. */
	blocks;
	constructor(message, category = "capability", blocks = []) {
		super(message, category);
		this.name = "PromptError";
		this.blocks = blocks;
	}
};
/** Narrow an unknown to a plain object. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read one image object from an assignment by name. */
function findImage(assignment, name) {
	const images = assignment["images"];
	if (!Array.isArray(images) || images.length === 0) throw new PromptError("assignment has no images");
	for (const image of images) if (isRecord(image) && image["name"] === name) return image;
	const available = images.filter(isRecord).map((item) => String(item["name"])).join(", ");
	throw new PromptError(`unknown image name ${JSON.stringify(name)}; assignment contains: ${available}`);
}
/** Render `image.text` when present, else the no-text directive. */
function textBlock(image) {
	const contract = image["text"];
	if (contract === void 0 || contract === null) return NO_TEXT;
	if (!isRecord(contract)) throw new PromptError("image.text must be null or an object");
	const content = contract["content"];
	if (typeof content !== "string" || content === "") throw new PromptError("image.text.content must be a non-empty string");
	const pieces = [`Text: exactly ${jsonString(content)}`];
	const languages = contract["languages"];
	if (Array.isArray(languages) && languages.length > 0) pieces.push(`in ${languages.map((item) => String(item)).join("/")}`);
	const direction = contract["direction"];
	if (typeof direction === "string" && direction !== "") pieces.push(direction);
	const placement = contract["placement"];
	if (typeof placement === "string" && placement.trim() !== "") pieces.push(placement.trim());
	const style = contract["style"];
	if (typeof style === "string" && style.trim() !== "") pieces.push(style.trim());
	pieces.push("nothing else");
	return `${pieces.join(", ")}.`;
}
/** JSON-encode like Python's `json.dumps(..., ensure_ascii=False)`. */
function jsonString(value) {
	return JSON.stringify(value);
}
/** Render `image.proportion`. */
function proportionBlock(image) {
	const proportion = image["proportion"];
	if (!isRecord(proportion)) throw new PromptError("image.proportion must be an object");
	const mode = proportion["mode"];
	if (mode === "preset") {
		const preset = proportion["preset"];
		const heads = typeof preset === "string" ? PRESET_HEADS[preset] : void 0;
		if (heads === void 0) throw new PromptError(`unknown proportion preset ${JSON.stringify(preset)}`);
		return `${formatGeneral(heads)} heads tall total (head ~${pythonRound(100 / heads)}% tall); age unchanged.`;
	}
	if (mode === "custom") {
		const target = proportion["target_head_ratio"];
		if (typeof target !== "number" || !Number.isFinite(target) || target <= 1) throw new PromptError("custom proportion needs a target_head_ratio greater than 1.0");
		return `${formatGeneral(target)} heads tall total (head ~${pythonRound(100 / target)}% tall); keep apparent age unchanged.`;
	}
	throw new PromptError("image.proportion.mode must be preset or custom");
}
/** Render one canonical-or-custom description field (`style`, `costume`). */
function descriptionBlock(image, field, canonical) {
	const value = image[field];
	if (!isRecord(value)) throw new PromptError(`image.${field} must be an object`);
	const mode = value["mode"];
	const description = value["description"];
	if (mode === "canonical") return canonical;
	if (mode === "custom") {
		if (typeof description !== "string" || description.trim() === "") throw new PromptError(`custom ${field} needs a description`);
		return description.trim();
	}
	throw new PromptError(`image.${field}.mode must be canonical or custom`);
}
/** Render the scene line, always ending with the framing constraint. */
function sceneBlock(image) {
	const parts = [];
	for (const field of [
		"expression",
		"action",
		"composition"
	]) {
		const value = image[field];
		if (typeof value === "string" && value.trim() !== "") parts.push(value.trim().replace(/\.+$/, ""));
	}
	if (parts.length === 0) throw new PromptError("image needs at least one of expression, action or composition");
	parts.push(FRAMING);
	return `${parts.join(", ")}.`;
}
/** Render `props` + `objects`, or the empty string when there are none. */
function propsBlock(image) {
	const entries = [];
	for (const field of ["props", "objects"]) {
		const value = image[field];
		if (value === void 0 || value === null) continue;
		if (!Array.isArray(value)) throw new PromptError(`image.${field} must be a list`);
		for (const item of value) {
			const text = itemText(item).trim().replace(/\.+$/, "");
			if (text !== "") entries.push(text);
		}
	}
	return entries.length > 0 ? `${entries.join(", ")}.` : "";
}
/** Stringify one prop entry; the schema says string, so other shapes are defensive. */
function itemText(item) {
	if (typeof item === "string") return item;
	if (typeof item === "number" || typeof item === "boolean") return String(item);
	if (item === null || item === void 0) return "";
	return JSON.stringify(item) ?? "";
}
/** Render `image.background`, refusing the transparency this channel cannot honour. */
function backgroundBlock(image) {
	const background = image["background"];
	if (!isRecord(background)) throw new PromptError("image.background must be an object");
	const mode = background["mode"];
	const description = background["description"];
	if (mode === "transparent") throw new PromptError("background.mode=transparent cannot be satisfied here: 智谱 glm-image returns an opaque JPEG payload with no transparency contract. Freeze a solid or custom background.");
	if (mode !== "solid" && mode !== "custom") throw new PromptError("image.background.mode must be solid, custom or transparent");
	if (typeof description !== "string" || description.trim() === "") throw new PromptError("image.background needs a description");
	return description.trim();
}
/** Assemble the ordered blocks for one image. */
function compileBlocks(image) {
	const blocks = [
		["identity", IDENTITY],
		["proportion", proportionBlock(image)],
		["style", descriptionBlock(image, "style", STYLE_CANONICAL)],
		["costume", descriptionBlock(image, "costume", COSTUME_CANONICAL)],
		["scene", sceneBlock(image)]
	];
	const props = propsBlock(image);
	if (props !== "") blocks.push(["props", props]);
	blocks.push(["background", backgroundBlock(image)]);
	blocks.push(["text", textBlock(image)]);
	return blocks;
}
/** Join blocks into the final prompt; only the identity block goes unlabelled. */
function render(blocks) {
	return blocks.map(([name, value]) => name === "identity" ? value : `${LABELS[name] ?? ""}${value}`).join("\n");
}
/**
* Compile one image of a frozen assignment into a budget-checked prompt.
* @throws PromptError with category `capability` when the prompt exceeds the budget.
*/
function compilePrompt(assignment, imageName, maxChars = 780) {
	if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > 800) throw new PromptError(`max_chars must be between 200 and 800 (upstream truncates past 800)`);
	const blocks = compileBlocks(findImage(assignment, imageName));
	const prompt = render(blocks);
	const sizes = blocks.map(([name, value]) => ({
		name,
		chars: `${LABELS[name] ?? ""}${value}`.length
	}));
	if (prompt.length > maxChars) {
		const over = prompt.length - maxChars;
		const detail = [...sizes].sort((left, right) => right.chars - left.chars).map((item) => `${item.name}=${item.chars}`).join(", ");
		throw new PromptError(`compiled prompt is ${prompt.length} characters, ${over} over the ${maxChars}-character budget (${detail}). Shorten the scene text (it owns whatever the constant blocks leave) — the identity block is fixed on purpose.`, "capability", sizes);
	}
	return {
		prompt,
		blocks: sizes,
		promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex")
	};
}
/**
* Validate the schema version of a parsed assignment object.
* @throws PromptError when the version is not {@link SCHEMA_VERSION}.
*/
function requireSchemaVersion(assignment) {
	const found = assignment["schema_version"];
	if (found !== 4) throw new PromptError(`assignment schema_version must be 4, found ${JSON.stringify(found)}`);
}
//#endregion
//#region src/domain/compose.ts
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
/**
* The canonical strings, moved here from the retired assignment validator.
*
* They are what the frozen engine wrote into every prompt, so they are quoted
* rather than composed: `canonical clean rounded cel-shaded Whale-chan style` is a
* prompt fragment the channel has been calibrated on, not a description of one.
*/
const DEFAULT_STYLE = "canonical clean rounded cel-shaded Whale-chan style";
/** The canonical costume fragment. */
const DEFAULT_COSTUME = "canonical navy-and-white ornate maid outfit";
/** The canonical background. The comic half used pure white; this half does not. */
const DEFAULT_BACKGROUND = "warm ivory-beige #F5EADD";
/** Path of the catalogue inside the package. */
function catalogPath(skillRoot) {
	return join(skillRoot, "references", "reference-catalog.json");
}
/**
* Read and check the catalogue.
* @param skillRoot - absolute path of the vendored skill tree.
* @throws WhalechanError when the file is missing or does not describe forms.
*/
function loadCatalog(skillRoot) {
	const path = catalogPath(skillRoot);
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new WhalechanError(`cannot read the reference catalogue at ${path}: ${error instanceof Error ? error.message : String(error)}. The vendored tree is part of the package, so this build is incomplete.`, "unavailable");
	}
	const catalog = parsed;
	const forms = catalog.forms;
	if (typeof forms !== "object" || forms === null || Object.keys(forms).length === 0) throw new WhalechanError(`${path} describes no forms`, "unavailable");
	if (typeof catalog.default_form !== "string" || !(catalog.default_form in forms)) throw new WhalechanError(`${path} names a default form it does not define`, "unavailable");
	for (const name of Object.keys(forms)) if (!(name in PRESET_HEADS)) throw new WhalechanError(`the catalogue defines the form ${JSON.stringify(name)}, but the prompt compiler has no head count for it (it knows ${Object.keys(PRESET_HEADS).join(", ")}). The two tables must agree.`, "service");
	return catalog;
}
/** Parse a head count out of free text such as `3`, `3.0`, `3 heads`, `3头身`. */
function headCountIn(requested) {
	const match = /(\d+(?:\.\d+)?)/.exec(requested);
	if (match === null) return void 0;
	const value = Number(match[1]);
	return Number.isFinite(value) && value > 1 ? value : void 0;
}
/** The nearest catalogue form to a head count, ties going to the shorter figure. */
function nearestForm(catalog, heads) {
	return Object.keys(catalog.forms).map((name) => ({
		name,
		distance: Math.abs(catalog.forms[name].mean_head_ratio - heads)
	})).sort((left, right) => left.distance - right.distance || catalog.forms[left.name].mean_head_ratio - catalog.forms[right.name].mean_head_ratio)[0].name;
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
function resolveForm(catalog, requested) {
	const trimmed = (requested ?? "").trim();
	const names = Object.keys(catalog.forms).join(", ");
	if (trimmed === "") {
		const name = catalog.default_form;
		return {
			anchor: name,
			anchorHeads: catalog.forms[name].mean_head_ratio,
			proportion: {
				mode: "preset",
				preset: name
			},
			because: `no form was named, so the catalogue default ${name} (${catalog.forms[name].mean_head_ratio} heads) was used.`
		};
	}
	if (trimmed in catalog.forms) return {
		anchor: trimmed,
		anchorHeads: catalog.forms[trimmed].mean_head_ratio,
		proportion: {
			mode: "preset",
			preset: trimmed
		},
		because: `form ${trimmed} was named, and its counted ratio is ${catalog.forms[trimmed].mean_head_ratio} heads.`
	};
	const heads = headCountIn(trimmed);
	if (heads !== void 0) {
		const anchor = nearestForm(catalog, heads);
		return {
			anchor,
			anchorHeads: catalog.forms[anchor].mean_head_ratio,
			proportion: {
				mode: "custom",
				target_head_ratio: heads
			},
			because: `${heads} heads was taken literally, so the prompt states ${heads}; the identity anchor comes from the nearest catalogue form ${anchor} (${catalog.forms[anchor].mean_head_ratio} heads).`
		};
	}
	throw new WhalechanError(`form ${JSON.stringify(requested)} is neither a catalogue form nor a head count. Known forms: ${names}; a head count is any number greater than 1, e.g. 3 or "2.5头身".`, "capability");
}
/** The scene line the compiler will render, ending with the framing constraint. */
function sceneOf(prompt) {
	const scene = prompt.trim().replace(/[\s.。]+$/, "");
	if (scene === "") throw new WhalechanError("prompt must be a non-empty description of the scene", "capability");
	return scene;
}
/**
* Compose `count` images from one description.
* @param request - the scene and the optional form.
* @param catalog - the loaded catalogue.
* @param count - how many images, at least one.
* @param skillRoot - absolute path of the vendored tree, to resolve the anchor.
* @returns the compiler's input plus what was decided, so a caller can show it.
*/
function composeImages(request, catalog, count, skillRoot) {
	if (!Number.isInteger(count) || count < 1) throw new WhalechanError(`count must be a positive integer, not ${JSON.stringify(count)}`, "capability");
	const scene = sceneOf(request.prompt);
	const form = resolveForm(catalog, request.form);
	const anchorPath = join(skillRoot, ...catalog.forms[form.anchor].primary.split("/"));
	if (!isAbsolute(anchorPath)) throw new WhalechanError(`the catalogue's anchor for ${form.anchor} is not a rooted path`, "service");
	const names = Array.from({ length: count }, (_, index) => `image-${String(index + 1).padStart(2, "0")}`);
	return {
		assignment: {
			schema_version: 4,
			images: names.map((name) => ({
				name,
				expression: "",
				action: "",
				composition: scene,
				props: [],
				objects: [],
				style: { mode: "canonical" },
				costume: { mode: "canonical" },
				background: {
					mode: "solid",
					description: DEFAULT_BACKGROUND
				},
				text: null,
				proportion: form.proportion
			}))
		},
		form,
		anchorPath,
		names
	};
}
//#endregion
//#region src/run/plan.ts
/**
* Canonical JSON: the serialization every digest in this plugin is taken over.
*
* The digest has to be stable across processes and platforms, so it cannot rely on
* `JSON.stringify`'s key order or on how it spells a number. Both are real risks
* here: Python wrote the frozen artefacts, so `4.0` must not become `4`, and a key
* order that followed insertion order would make the same plan hash differently
* depending on how it was built.
*
* This used to live beside a whole plan compiler. That compiler is gone — v0.3 draws
* from a description rather than from a frozen assignment document — and the
* serialization is the part that had to survive: `whalechan_image`'s `plan_id` is
* taken over it.
*/
/**
* Render a JSON value the way Python's `json.dumps(..., sort_keys=True)` renders it,
* with numbers spelled as Python spells them.
* @param value - any JSON value.
* @returns the canonical text.
* @throws WhalechanError when a value cannot be canonicalized at all.
*/
function canonicalJson(value) {
	if (value === null || value === void 0) return "null";
	if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value;
		return `{${Object.keys(record).sort().map((key) => `${pythonJsonString(key)}:${canonicalJson(record[key])}`).join(",")}}`;
	}
	if (typeof value === "string") return pythonJsonString(value);
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "number") return Number.isInteger(value) ? String(value) : pythonFloatRepr(value);
	throw new WhalechanError(`cannot canonicalize a ${typeof value}`, "service");
}
//#endregion
//#region src/domain/image-header.ts
/**
* Image headers, read directly.
*
* The plugin needs one thing from a reference image before spending: its format,
* its pixel size, and its colour space. The oracle got those by shelling out to
* ImageMagick, which DSH does not ship and which is therefore the one binary a
* user would have to install themselves.
*
* Reading a header is not an image operation — nothing is decoded, resampled, or
* measured — so doing it here removes that dependency from the plan path without
* weakening the rule that pixel work belongs to Pillow (D1).
*
* Only the container headers are parsed: PNG `IHDR`, JPEG `SOF`, the three WEBP
* chunk layouts, and the GIF screen descriptor. Everything else is refused by
* name rather than guessed at.
*/
/** How much of the file to read; JPEG metadata can push `SOF` a long way in. */
const HEADER_BYTES = 1024 * 1024;
/** Read up to {@link HEADER_BYTES} from the file. */
function readHead(path) {
	const handle = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(HEADER_BYTES);
		const read = readSync(handle, buffer, 0, HEADER_BYTES, 0);
		return buffer.subarray(0, read);
	} finally {
		closeSync(handle);
	}
}
/** Refuse a file whose container we do not parse. */
function unsupported(path, detail) {
	throw new WhalechanError(`${path} could not be read as an image header: ${detail}. dsh-whalechan reads PNG, JPEG, WebP and GIF headers directly; convert the reference to one of those formats.`, "capability");
}
/** The colour space ImageMagick reports for a PNG colour type. */
function pngColorspace(colorType) {
	if (colorType === 0 || colorType === 4) return "Gray";
	return "sRGB";
}
/** Parse a PNG `IHDR`. */
function readPng(head, path) {
	if (head.length < 26) unsupported(path, "the PNG is too short to hold an IHDR");
	if (head.toString("latin1", 12, 16) !== "IHDR") unsupported(path, "the first PNG chunk is not IHDR");
	return {
		format: "PNG",
		width: head.readUInt32BE(16),
		height: head.readUInt32BE(20),
		colorspace: pngColorspace(head.readUInt8(25))
	};
}
/** JPEG start-of-frame markers, whose payload carries the dimensions. */
const JPEG_SOF = /* @__PURE__ */ new Set([
	192,
	193,
	194,
	195,
	197,
	198,
	199,
	201,
	202,
	203,
	205,
	206,
	207
]);
/** Walk JPEG segments to the first start-of-frame. */
function readJpeg(head, path) {
	let offset = 2;
	while (offset + 4 <= head.length) {
		if (head.readUInt8(offset) !== 255) {
			offset += 1;
			continue;
		}
		const marker = head.readUInt8(offset + 1);
		if (marker === 255 || marker === 0) {
			offset += 1;
			continue;
		}
		if (marker === 216 || marker >= 208 && marker <= 217) {
			offset += 2;
			continue;
		}
		const length = head.readUInt16BE(offset + 2);
		if (length < 2) unsupported(path, "a JPEG segment declares an impossible length");
		if (JPEG_SOF.has(marker)) {
			if (offset + 9 > head.length) unsupported(path, "the JPEG start-of-frame is truncated");
			const components = head.readUInt8(offset + 9);
			return {
				format: "JPEG",
				height: head.readUInt16BE(offset + 5),
				width: head.readUInt16BE(offset + 7),
				colorspace: components === 1 ? "Gray" : components === 4 ? "CMYK" : "sRGB"
			};
		}
		offset += 2 + length;
	}
	unsupported(path, "the JPEG has no start-of-frame before the header window ends");
}
/** The first WEBP chunk after the RIFF header. */
function readWebp(head, path) {
	if (head.length < 30) unsupported(path, "the WebP is too short");
	const fourCc = head.toString("latin1", 12, 16);
	if (fourCc === "VP8X") return {
		format: "WEBP",
		width: (head.readUInt8(24) | head.readUInt8(25) << 8 | head.readUInt8(26) << 16) + 1,
		height: (head.readUInt8(27) | head.readUInt8(28) << 8 | head.readUInt8(29) << 16) + 1,
		colorspace: "sRGB"
	};
	if (fourCc === "VP8 ") {
		if (head.readUInt8(23) !== 157 || head.readUInt8(24) !== 1 || head.readUInt8(25) !== 42) unsupported(path, "the WebP lossy frame header is missing its start code");
		return {
			format: "WEBP",
			width: head.readUInt16LE(26) & 16383,
			height: head.readUInt16LE(28) & 16383,
			colorspace: "sRGB"
		};
	}
	if (fourCc === "VP8L") {
		if (head.readUInt8(20) !== 47) unsupported(path, "the WebP lossless stream has no signature");
		const bits = head.readUInt32LE(21);
		return {
			format: "WEBP",
			width: (bits & 16383) + 1,
			height: (bits >> 14 & 16383) + 1,
			colorspace: "sRGB"
		};
	}
	unsupported(path, `unrecognised WebP chunk ${JSON.stringify(fourCc)}`);
}
/** Parse the GIF logical screen descriptor. */
function readGif(head, path) {
	if (head.length < 10) unsupported(path, "the GIF is too short to hold a screen descriptor");
	return {
		format: "GIF",
		width: head.readUInt16LE(6),
		height: head.readUInt16LE(8),
		colorspace: "sRGB"
	};
}
/**
* Read one image's header.
* @param path - absolute path of the image.
* @returns the format, pixel size, and colour space ImageMagick would report.
*/
function readImageHeader(path) {
	let head;
	try {
		head = readHead(path);
	} catch (error) {
		throw new WhalechanError(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`, "unavailable");
	}
	if (head.length < 12) unsupported(path, "the file is too short to identify");
	if (head.readUInt32BE(0) === 2303741511) return readPng(head, path);
	if (head.readUInt16BE(0) === 65496) return readJpeg(head, path);
	if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP") return readWebp(head, path);
	const gif = head.toString("latin1", 0, 6);
	if (gif === "GIF87a" || gif === "GIF89a") return readGif(head, path);
	unsupported(path, "the signature matches no supported container");
}
/**
* {@link readImageHeader} shaped as the assignment validator's `identify` dependency.
*
* Async only to match the seam; nothing here awaits. Passing this to
* `validateAssignment` is what lets a plan run with no Python process and no
* ImageMagick.
* @param path - absolute path of the reference image.
* @returns the format, pixel size, and colour space.
*/
async function identifyImage(path) {
	return readImageHeader(path);
}
//#endregion
//#region src/run/client.ts
/**
* The wire: one prompt in, one image out, from this process.
*
* Until v0.3 this went through the vendored `generate-dsh-imagegen.py` — a Python
* interpreter, a subprocess, a Pillow stand-in and an encoding dance to do what the
* adapter itself does in thirty lines: POST a JSON body and decode a base64 image.
* The spawn was not the measured cost (§68: 55.7 s was the provider, and the whole
* plugin was 6.7% of the run), but it was the reason the plugin could not stand on
* its own, and the reason a 1.7 MB engine had to ship with it.
*
* The protocol is taken from that adapter, which is the frozen record of it:
*
* ```
* POST {base}/api/dsh-imagegen/generate
*   { prompt, model, size, n, mode: 'text' | 'edit', image?, images? }
*   -> { ok: true, images: [{ b64, mime }] }
*   -> { ok: false, code, message }
* ```
*
* Two details the route family makes easy to get wrong, both inherited deliberately:
* a failure is answered with **HTTP 200** and `ok: false`, so the status code alone
* says nothing; and the references travel as data URLs, so a file that cannot be read
* is a failure before anything is spent.
*/
/** The default timeout: a provider round trip is tens of seconds, not minutes. */
const DEFAULT_TIMEOUT_MS = 18e4;
/**
* Read a reference image as a data URL.
*
* The media type comes from the file's own header rather than its extension: the
* vendored anchors are `.webp`, but a caller-supplied reference can be anything, and
* a mislabelled data URL is refused by the provider with a message about the image
* rather than about the label.
* @param path - absolute path of the reference.
* @returns `data:<mime>;base64,<payload>`.
* @throws WhalechanError with category `capability` when the file cannot be read.
*/
function imageDataUrl(path) {
	let bytes;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		throw new WhalechanError(`cannot read the reference image ${path}: ${error instanceof Error ? error.message : String(error)}`, "capability");
	}
	let mime = "application/octet-stream";
	try {
		mime = mimeOfFormat(readImageHeader(path).format);
	} catch {}
	return `data:${mime};base64,${bytes.toString("base64")}`;
}
/** Map a header's format name onto a media type. */
function mimeOfFormat(format) {
	switch (format.trim().toUpperCase()) {
		case "PNG": return "image/png";
		case "JPEG":
		case "JPG": return "image/jpeg";
		case "WEBP": return "image/webp";
		case "GIF": return "image/gif";
		default: return "application/octet-stream";
	}
}
/** Decode the base64 a response carries. */
function decodeImage(image) {
	const bytes = Buffer.from(image.b64, "base64");
	if (bytes.byteLength === 0) throw new WhalechanError("the image endpoint reported an image with an empty payload", "service");
	return bytes;
}
/**
* Choose a file extension from the bytes, not from the declared media type.
*
* The provider's own label has been wrong before, and a `.png` file holding a WebP
* is the kind of thing that is discovered much later.
* @param bytes - the decoded payload.
* @returns the extension without a dot.
*/
function extensionOf(bytes) {
	if (bytes.subarray(0, 8).equals(Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]))) return "png";
	if (bytes.subarray(0, 3).equals(Buffer.from([
		255,
		216,
		255
	]))) return "jpg";
	if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
	if (bytes.subarray(0, 3).toString("ascii") === "GIF") return "gif";
	return "bin";
}
/** Write one decoded image, refusing to clobber a file that is already there. */
function writeImage(path, bytes) {
	try {
		writeFileSync(path, bytes, { flag: "wx" });
	} catch (error) {
		if (error.code === "EEXIST") throw new WhalechanError(`refusing to overwrite an existing image: ${path}`, "capability");
		throw new WhalechanError(`cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`, "service");
	}
}
/**
* Ask the host for one image.
* @param body - the request, already shaped.
* @param options - the resolved base URL and timeout.
* @returns the decoded-able image payload.
* @throws WhalechanError classified from the status, the body, or the transport.
*/
async function requestImage(body, options) {
	const base = options.base.trim().replace(/\/+$/, "");
	if (base === "") throw new WhalechanError("Refusing to generate: the dsh-imagegen host could not be located from this process, and falling back to DSH_WEB_URL could send the request to a different host's channel and spend its quota. Start the run inside the DSH host, or set imagegenBaseUrl.", "unavailable");
	const endpoint = joinUrl(base, IMAGEGEN_GENERATE_PATH);
	const doFetch = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 18e4;
	let response;
	try {
		response = await doFetch(endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				accept: "application/json"
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
	} catch (error) {
		const name = error.name;
		if (name === "TimeoutError" || name === "AbortError") throw new WhalechanError(`the image endpoint timed out after ${timeoutMs}ms`, "timeout");
		throw new WhalechanError(`cannot reach the image endpoint ${endpoint}: ${error instanceof Error ? error.message : String(error)}. The host may have stopped, or imagegenBaseUrl may name the wrong port.`, "unavailable");
	}
	const text = await response.text();
	if (!response.ok) throw new WhalechanError(`the image endpoint returned HTTP ${response.status}${text === "" ? "" : `: ${text.slice(0, 300)}`}`, classifyHttp(response.status));
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new WhalechanError(`the image endpoint returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`, "service");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new WhalechanError("the image endpoint returned a non-object payload", "service");
	const record = parsed;
	if (record["ok"] !== true) {
		const code = typeof record["code"] === "string" ? record["code"] : "";
		const message = typeof record["message"] === "string" ? record["message"] : "the image endpoint refused the request";
		throw new WhalechanError(message, classifyEndpointError(code, message));
	}
	const images = record["images"];
	if (!Array.isArray(images) || images.length === 0) throw new WhalechanError("the image endpoint reported success without any image", "service");
	const first = images[0];
	if (typeof first !== "object" || first === null || typeof first["b64"] !== "string") throw new WhalechanError("the image endpoint returned a malformed image payload", "service");
	return {
		b64: first["b64"],
		mime: typeof first["mime"] === "string" ? first["mime"] : ""
	};
}
//#endregion
//#region src/run/vendor.ts
/**
* Vendored engine trees: what ships with the plugin, and proof of where it came from.
*
* The charter freezes the patched skill trees into the package rather than
* reading them from `~/.dsh/skills`, because a discovery location is not a
* dependency: the tree can be moved, edited, or removed without the plugin
* noticing until a run fails.
*
* Freezing a copy creates its own hazard, though — the copy can silently drift
* from the original. So every vendor tree carries a **digest over its exact file
* set and contents**, recorded in `vendor/PROVENANCE.json` and, per file, in
* `THIRD-PARTY-NOTICES.md`. `treeDigest` below recomputes it, so editing a
* vendored file by hand, or re-vendoring from a different source, is a thing a
* reader can detect rather than a thing we promise does not happen.
*/
/** The marker that identifies the package root, and only the package root. */
const PACKAGE_MARKER = join("vendor", "PROVENANCE.json");
/**
* Find the package root by walking up from this module.
*
* A fixed `../..` is correct for the **source** layout (`src/run/vendor.ts`) and
* wrong for the **bundled** one (`lib/index.js`, one directory shallower) — and
* the bundled one is what the host loads. That mistake is invisible until a real
* host calls a tool: the live plan probe passed only because it imported `src/`
* directly, while the packaged build resolved the engine to a sibling directory
* that does not exist.
*
* So the root is *found*, not computed: the first ancestor holding the engine is
* the package, in either layout.
* @param from - the directory to start walking up from.
* @returns the package root.
* @throws when no ancestor holds the vendored engine, because a plugin without it
*   cannot serve any of its tools and should say so rather than mount quietly.
*/
function findPackageRoot(from) {
	let current = resolve(from);
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(join(current, PACKAGE_MARKER))) return current;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`dsh-whalechan could not find its own package root: no ancestor of ${resolve(from)} contains ${PACKAGE_MARKER}. The vendored engine is part of the package, so this build is incomplete.`);
}
/** Repository root, found rather than assumed. */
const REPO_ROOT = findPackageRoot(fileURLToPath(new URL(".", import.meta.url)));
/** Where frozen engine trees live inside the package. */
const VENDOR_ROOT = join(REPO_ROOT, "vendor");
/** Directory name of the vendored skill, both under `vendor/` and upstream. */
const CHARACTER_SKILL_NAME = "whalechan-image-character";
/**
* The engine tree, and where it is frozen from.
*
* The source is kept **relative** so the provenance file stays meaningful on
* another checkout instead of recording one machine's absolute path.
*/
const SKILL_VENDORS = [{
	name: CHARACTER_SKILL_NAME,
	source: `../dsh-whalechan/.dsh/skills/${CHARACTER_SKILL_NAME}`
}];
/** Absolute path of the vendored engine every tool runs. */
const CHARACTER_SKILL_ROOT = join(VENDOR_ROOT, CHARACTER_SKILL_NAME);
/**
* The runtime subset: **the catalogue and the reference images, nothing else**.
*
* This used to ship the whole skill tree — the Python engine under `scripts/`, the
* specification Markdown under `references/`, and `SKILL.md`. v0.3 needs none of it:
* the prompt compiler and the assignment shape are ours (upstream has no character-side
* compiler to port), the images go out over HTTP, and the only file read at runtime is
* `reference-catalog.json`.
*
* Shrinking it is not only tidiness. The prose files are CC-BY-NC-SA 4.0 and the
* reference images carry third-party rights, so every file dropped here is a file
* that no longer has to be licensed for redistribution (§66.7).
*/
const VENDOR_FILES = ["references/reference-catalog.json"];
/** Directories whose whole contents are part of the runtime subset. */
const VENDOR_DIRECTORIES = ["assets"];
/** Is this path part of the vendored runtime? */
function isVendoredPath(relativePosix) {
	const segments = relativePosix.split("/");
	if (segments.some((segment) => segment === "__pycache__")) return false;
	if (relativePosix.endsWith(".pyc")) return false;
	if (VENDOR_FILES.includes(relativePosix)) return true;
	const [head] = segments;
	if (head === void 0) return false;
	if (VENDOR_DIRECTORIES.includes(head)) return true;
	return VENDOR_FILES.some((file) => file.startsWith(`${relativePosix}/`));
}
/** List every file under `root` as a posix-relative path. */
function listFiles(root, prefix = "") {
	let entries;
	try {
		entries = readdirSync(join(root, prefix));
	} catch {
		return [];
	}
	const found = [];
	for (const entry of entries) {
		const relativePath = prefix === "" ? entry : `${prefix}/${entry}`;
		if (statSync(join(root, relativePath)).isDirectory()) found.push(...listFiles(root, relativePath));
		else found.push(relativePath);
	}
	return found;
}
/**
* Compute a tree's digest over its file set and contents.
*
* The digest covers `path\0content-digest` per file, in sorted path order, so it
* changes when a file is added, removed, renamed, or edited — and it does **not**
* depend on directory iteration order or on file timestamps.
* @param root - absolute path of the tree.
* @param filter - which relative paths count; defaults to {@link isVendoredPath}.
* @returns the file count, byte count, and digest.
*/
function treeDigest(root, filter = isVendoredPath) {
	const paths = listFiles(root).filter(filter).sort();
	const accumulator = createHash("sha256");
	let bytes = 0;
	for (const path of paths) {
		const content = readFileSync(join(root, ...path.split("/")));
		bytes += content.byteLength;
		accumulator.update(`${path}\0`);
		accumulator.update(createHash("sha256").update(content).digest("hex"));
		accumulator.update("\n");
	}
	return {
		files: paths.length,
		bytes,
		digest: accumulator.digest("hex")
	};
}
/** The path of the provenance file. */
const PROVENANCE_PATH = join(VENDOR_ROOT, "PROVENANCE.json");
/** Canonical text of the vendor records, the input to the provenance digest. */
function provenanceText(vendors) {
	return Object.keys(vendors).sort().map((name) => {
		const record = vendors[name];
		return `${name}\0${record.source}\0${record.files}\0${record.bytes}\0${record.digest}\n`;
	}).join("");
}
/** Read the recorded provenance. */
function readProvenance(path = PROVENANCE_PATH) {
	return JSON.parse(readFileSync(path, "utf8"));
}
//#endregion
//#region src/tools/image.ts
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
/** Stable tool name; the whole plugin surface is prefixed `whalechan_`. */
const IMAGE_TOOL_NAME = "whalechan_image";
/** The ratio a caller gets when they do not name one. */
const DEFAULT_RATIO = "1:1";
/** Output schema of {@link IMAGE_TOOL_NAME}. */
const imageSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		dry_run: {
			type: "boolean",
			required: true
		},
		plan_id: {
			type: "string",
			required: true
		},
		model: {
			type: "string",
			required: true
		},
		model_source: {
			type: "string",
			required: true
		},
		channel_family: {
			type: "string",
			required: true
		},
		prompt_ceiling: {
			type: "integer",
			required: true
		},
		ratio: {
			type: "string",
			required: true
		},
		size: {
			type: "string",
			required: true
		},
		expected_pixels: {
			type: "string",
			required: true
		},
		deliverable_ratios: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		form: {
			type: "string",
			required: true
		},
		form_because: {
			type: "string",
			required: true
		},
		count: {
			type: "integer",
			required: true
		},
		prompt: {
			type: "string",
			required: true
		},
		prompt_chars: {
			type: "integer",
			required: true
		},
		blocks: {
			required: true,
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: {
						type: "string",
						required: true
					},
					chars: {
						type: "integer",
						required: true
					}
				}
			}
		},
		confirmation: {
			type: "array",
			items: { type: "string" },
			required: true
		},
		images: {
			required: true,
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: {
						type: "string",
						required: true
					},
					path: {
						type: "string",
						required: true
					},
					media_type: {
						type: "string",
						required: true
					},
					bytes: {
						type: "integer",
						required: true
					},
					sha256: {
						type: "string",
						required: true
					}
				}
			}
		},
		delivered: {
			type: "integer",
			required: true
		},
		delivery_error: {
			type: "string",
			required: true
		}
	}
};
/** One phrase per model-source, for the audit line. */
function describeModelSource(source) {
	switch (source) {
		case "request": return "the tool call";
		case "setting": return "the plugin setting defaultModel";
		case "imagegen-default": return "dsh-imagegen's own defaultModel";
		case "sole-catalogue-entry": return "the only model alias in the catalogue";
	}
}
/** A compact timestamp for a file name: `20261003-1812`. */
function stamp(now) {
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
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
function planDigest(parts) {
	return createHash("sha256").update(canonicalJson(parts), "utf8").digest("hex");
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
function renderPlan(value) {
	return [
		`Plan for ${value.count} image(s) on ${value.model} (${value.model_source}), channel family "${value.channel_family}".`,
		`Form: ${value.form} — ${value.form_because}`,
		`Geometry: the panel key ${value.size} is sent for ${value.ratio}` + (value.expected_pixels === "" ? "; the channel chooses the pixel size." : `; about ${value.expected_pixels} comes back.`) + ` The channel delivers exactly ${value.deliverable_ratios.join(", ")}.`,
		`Prompt: ${value.prompt_chars} characters (the compiler's ceiling is ${value.prompt_ceiling}).`,
		"",
		value.prompt,
		"",
		`Plan id ${value.plan_id}`,
		"",
		"Before approving:",
		...value.confirmation.map((item) => `  - ${item}`),
		"",
		"Nothing has been spent. Pass confirm: true together with this plan_id to draw it."
	].join("\n");
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
function renderDelivery(value) {
	const plural = value.count === 1 ? "image" : "images";
	const it = value.count === 1 ? "it" : "them";
	const pixels = value.expected_pixels === "" ? "" : ` (${value.expected_pixels})`;
	const lines = [`Drew ${value.count} ${plural} on ${value.model}${pixels}.`];
	if (value.delivered >= value.images.length) {
		lines.push(`Delivered to this turn — judge ${it} yourself; do not read, measure or re-check ${it}.`);
		return lines.join("\n");
	}
	const why = value.delivery_error === "" ? "the session did not take it" : value.delivery_error;
	lines.push(`Could not declare ${it} as a deliverable (${why}), so ${it} is on disk here:`);
	for (const image of value.images) lines.push(`  ${image.path}`);
	lines.push(`Judge ${it} yourself; nothing here checked ${it}.`);
	return lines.join("\n");
}
/** Human-readable rendering of a plan or a delivery. */
function renderImage(value) {
	return value.dry_run ? renderPlan(value) : renderDelivery(value);
}
/**
* Draw, or plan to draw, one or more images.
* @param args - the tool call's arguments.
* @param deps - injected host access.
* @param exec - the executing call, handed to the delivery seam untouched; omitted
*   (as a dry run, or under a host with no delivery seam) it simply means nothing
*   can be delivered.
* @returns the plan, or the delivered files.
*/
async function imageRun(args, deps, exec) {
	const config = deps.resolveConfig();
	if (config.enabled === false) throw new WhalechanError("dsh-whalechan is disabled in its settings.", "capability");
	const choice = resolveModelChoice(await deps.describe(deps.endpointSources()), args.model ?? "", config.defaultModel ?? "");
	const family = channelFamily(choice.alias);
	const ratio = (args.ratio ?? "1:1").trim();
	const count = args.count ?? 1;
	const catalog = loadCatalog(CHARACTER_SKILL_ROOT);
	const composed = composeImages({
		prompt: args.prompt,
		...args.form === void 0 ? {} : { form: args.form }
	}, catalog, count, CHARACTER_SKILL_ROOT);
	const geometry = resolveGeometry(family, choice.alias, ratio);
	const size = geometry.sizeKey ?? "auto";
	const deliverable = deliverableRatios(family, choice.alias) ?? [];
	const compiled = composed.names.map((name) => {
		const result = compilePrompt(composed.assignment, name, 800);
		return {
			name,
			prompt: result.prompt,
			blocks: result.blocks
		};
	});
	const digest = planDigest({
		model: choice.alias,
		size,
		ratio,
		count,
		prompts: compiled.map((entry) => ({
			name: entry.name,
			prompt: entry.prompt
		}))
	});
	const first = compiled[0];
	const confirmation = [
		`${count} image(s) will be drawn on ${choice.alias} at ${ratio} (${size}); each one costs whatever your channel charges per image.`,
		`The prompt below is sent verbatim. Its identity, style and costume blocks are constant; the scene line is your description. It is ${first.prompt.length} characters, inside the compiler's 800.`,
		`Plan id ${digest} binds the compiled prompt(s), the model and the size. Pass it back with confirm: true, and it is checked before anything is sent — if the plan changed, the call is refused and nothing is spent.`
	];
	const base = {
		plan_id: digest,
		model: choice.alias,
		model_source: describeModelSource(choice.source),
		channel_family: family,
		prompt_ceiling: 800,
		ratio,
		size,
		expected_pixels: geometry.expectedPixels ?? "",
		deliverable_ratios: deliverable,
		form: composed.form.anchor,
		form_because: composed.form.because,
		count,
		prompt: first.prompt,
		prompt_chars: first.prompt.length,
		blocks: first.blocks.map((block) => ({
			name: block.name,
			chars: block.chars
		})),
		confirmation
	};
	if (args.confirm !== true) return {
		...base,
		dry_run: true,
		images: [],
		delivered: 0,
		delivery_error: ""
	};
	if (args.plan_id === void 0 || args.plan_id.trim() === "") throw new WhalechanError(`Refusing to draw without the plan id. Nothing has been spent, and nothing will be until the plan is carried back: the plan id for this request is ${digest}. Call again with confirm: true and that plan_id (it changes if the prompt, the model, the ratio or the count changes).`, "capability");
	if (args.plan_id.trim() !== digest) throw new WhalechanError(`Refusing to draw: plan_id ${JSON.stringify(args.plan_id)} does not match the request that would be sent (${digest}). The plan this call compiles is not the one that was approved, so nothing was spent. Take the plan again (omit confirm) and approve what you actually see.`, "capability");
	const baseUrl = resolveImagegenBase(deps.endpointSources());
	const anchor = imageDataUrl(composed.anchorPath);
	const now = /* @__PURE__ */ new Date();
	const directory = join(resolveDataRoot(config.dataRoot, process.env), "images");
	const written = [];
	const drawn = [];
	for (const [index, entry] of compiled.entries()) {
		const image = await requestImage({
			prompt: entry.prompt,
			model: choice.alias,
			size,
			n: 1,
			mode: "edit",
			image: anchor
		}, { base: baseUrl });
		const bytes = decodeImage(image);
		const mediaType = image.mime === "" ? "image/png" : image.mime;
		const name = `${stamp(now)}-${composed.form.anchor}-${String(index + 1).padStart(2, "0")}`;
		const path = join(directory, `${name}.${extensionOf(bytes)}`);
		mkdirSync(directory, { recursive: true });
		writeImage(path, bytes);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
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
			created: now.toISOString()
		}, null, 2)}\n`, "utf8");
		written.push({
			name,
			path,
			media_type: mediaType,
			bytes: bytes.byteLength,
			sha256
		});
		drawn.push({
			path,
			description: `whale-chan · ${composed.form.anchor} · ${ratio} · ${choice.alias}`
		});
	}
	const outcome = await deliverQuietly(deps.deliver, drawn, exec);
	return {
		...base,
		dry_run: false,
		images: written,
		delivered: outcome.delivered,
		delivery_error: outcome.error
	};
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
async function deliverQuietly(deliver, files, exec) {
	if (files.length === 0) return {
		delivered: 0,
		error: ""
	};
	if (deliver === void 0) return {
		delivered: 0,
		error: "this host has no delivery seam"
	};
	if (exec === void 0) return {
		delivered: 0,
		error: "this call cannot be delivered from"
	};
	try {
		const outcome = await deliver(files, exec);
		return {
			delivered: Math.max(0, Math.trunc(outcome.delivered)),
			error: outcome.error
		};
	} catch (error) {
		return {
			delivered: 0,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}
/** Register the image tool; returns the disposer cordis needs. */
function registerImageTool(ctx, deps) {
	return ctx.tools.register(defineTool({
		name: IMAGE_TOOL_NAME,
		description: "Draw a Whale-chan illustration from a plain description of the scene. Free unless confirmed: without confirm it returns the exact prompt, the model, the geometry and a plan_id — show that to the user first. With confirm: true and a matching plan_id it draws the images and declares them as this turn's deliverables, so the user sees them at once: do not read, measure, re-present or re-check them, and reply in one line — the user judges the picture. The prompt is compiled by the plugin: say the scene, not the style.",
		parameters: {
			prompt: {
				type: "string",
				required: true,
				description: "The scene in your own words, e.g. \"sitting on the floor eating a bowl of white rice, smiling\". It becomes the scene line verbatim."
			},
			form: {
				type: "string",
				description: "Form name (standard, compact, semi-chibi, chibi, super-deformed) or a head count such as 3. A head count is stated literally; only the identity anchor snaps to the nearest form. Default semi-chibi."
			},
			ratio: {
				type: "string",
				description: "Aspect ratio the channel delivers exactly, e.g. 1:1 (default) or 4:7. The plan lists them."
			},
			count: {
				type: "integer",
				description: "How many images, 1 or more. Each is a separate paid generation."
			},
			model: {
				type: "string",
				description: "Image model alias as configured in dsh-imagegen. Omit for the usual chain."
			},
			plan_id: {
				type: "string",
				description: "The plan_id the dry run returned. Required with confirm: true."
			},
			confirm: {
				type: "boolean",
				description: "True spends real quota. Only after the user has agreed to the prompt and the cost."
			}
		},
		output: {
			schema: imageSchema,
			render: (_args, value) => [{
				type: "text",
				text: renderImage(value)
			}]
		},
		async execute(args, exec) {
			return imageRun(args, deps, exec);
		}
	}));
}
//#endregion
//#region src/index.ts
/** Stable cordis plugin name; matches `id: whalechan` in cordis.patch.yml. */
const name = "whalechan";
/** Services required before the tool surface can mount. */
const inject = ["tools"];
/**
* Mount the plugin.
* @param ctx - host context; `tools` is guaranteed by {@link inject}.
* @param config - validated composition-entry configuration.
*/
function apply(ctx, config) {
	const resolveConfig = () => config ?? {};
	let readHostAddress = () => void 0;
	const endpointSources = () => ({
		explicit: resolveConfig().imagegenBaseUrl,
		hostAddress: readHostAddress(),
		env: process.env
	});
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
	let deliveryBound = () => false;
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
	const writeReceipt = () => {
		const described = describeImagegenBase(endpointSources());
		writeLoadReceipt(resolveDataRoot(resolveConfig().dataRoot, process.env), {
			tools: [IMAGE_TOOL_NAME],
			webUrl: readHostAddress() ?? "",
			imagegenBase: described.base,
			imagegenBaseSource: described.source,
			delivery: deliveryBound()
		});
	};
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
	const delivery = registerDelivery(ctx, () => {
		writeReceipt();
	});
	deliveryBound = delivery.bound;
	const disposers = [registerImageTool(ctx, {
		resolveConfig,
		endpointSources,
		describe: (sources) => describeImagegen(sources),
		deliver: delivery.deliver
	})];
	ctx.inject(["webServer"], (sctx) => {
		const server = sctx.get("webServer");
		readHostAddress = () => hostAddressOf(server?.port);
		writeReceipt();
		const disposeRoute = server === void 0 ? () => {} : registerStatusRoute(server, {
			version: VERSION,
			tools: [IMAGE_TOOL_NAME],
			endpointSources,
			resolveConfig,
			describe: (sources) => describeImagegen(sources),
			delivery: () => delivery.bound()
		});
		return () => {
			disposeRoute();
			readHostAddress = () => void 0;
		};
	});
	writeReceipt();
	return () => {
		for (const dispose of disposers.splice(0)) dispose();
	};
}
//#endregion
export { CHARACTER_SKILL_NAME, CHARACTER_SKILL_ROOT, COSTUME_CANONICAL, Config, Config as WhalechanConfigSchema, DEFAULT_BACKGROUND, DEFAULT_COSTUME, DEFAULT_MAX_CHARS, DEFAULT_RATIO, DEFAULT_STYLE, DEFAULT_TIMEOUT_MS, FRAMING, HARD_MAX_CHARS, IDENTITY, IMAGEGEN_GENERATE_PATH, IMAGEGEN_SETTINGS_DESCRIBE_PATH, IMAGE_TOOL_NAME, NO_TEXT, PRESET_HEADS, PROVENANCE_PATH, PromptError, REPO_ROOT, SAFETY_HINTS, SKILL_VENDORS, STATUS_PATH, STYLE_CANONICAL, VENDOR_ROOT, VERSION, WhalechanError, apply, backgroundBlock, bootedProfile, canonicalJson, catalogPath, channelFamily, channelReport, classifyEndpointError, classifyHttp, compileBlocks, compilePrompt, composeImages, createDelivery, decodeImage, defaultDataRoot, deliverableRatios, describeImagegen, describeImagegenBase, descriptionBlock, extensionOf, findImage, findPackageRoot, formatGeneral, geometryTable, hostAddressOf, identifyImage, imageDataUrl, imageRun, inject, isClose, isLoopback, isVendoredPath, joinUrl, loadCatalog, mimeOfFormat, name, normalizeBase, planDigest, promptLimit, proportionBlock, propsBlock, provenanceText, pythonFloatRepr, pythonJsonString, pythonRound, ratioOf, readImageHeader, readProvenance, readSettingsView, registerDelivery, registerImageTool, registerStatusRoute, render, renderImage, requestImage, requireSchemaVersion, resolveDataRoot, resolveForm, resolveGeometry, resolveImagegenBase, resolveModel, resolveModelChoice, sceneBlock, textBlock, treeDigest, writeImage, writeLoadReceipt };
