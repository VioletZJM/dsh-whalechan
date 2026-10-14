/**
 * The reported plugin version.
 *
 * An installer resolves `package.json` while the host reports this constant, so
 * the value is **not** written here: the build injects the manifest's `version`
 * in its place (`__WHALECHAN_VERSION__`, see tsdown.config.ts). Two literals with
 * no guard name two different builds the first time one of them is bumped; one
 * literal written by the build cannot drift from the manifest it ships with.
 */
declare const __WHALECHAN_VERSION__: string

/** The version stamped in at build time. */
export const VERSION = __WHALECHAN_VERSION__
