/**
 * Supply the framework packages that the **host** owns, so a gate can import an
 * installed plugin bundle under plain Node.
 *
 * Why this file exists — measured on 2026-10-10, after `verify:install` went red with
 * no defect behind it:
 *
 *   - A plugin declares `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` as **peer**
 *     dependencies. The host owns them; the plugin must not ship its own copy.
 *   - On the desktop host those packages live **inside `app.asar`**, which plain Node
 *     cannot read. The framework copy that used to satisfy a bare import from the
 *     profile was a set of junctions into a *development checkout*
 *     (`~/.dsh/profiles/node_modules/@deepseek-ai/*` →
 *     `E:\deepseek harness\deepseek-harness\apps\cli\node_modules\…`, created
 *     2026-09-11). Deleting that checkout left every junction dangling, so nothing
 *     resolved — while the plugin itself kept mounting in the live host, which is the
 *     thing that actually matters, and which writes a mount receipt
 *     (`~/.dsh/dsh-whalechan/state/loaded.json`) every time it does.
 *
 * So "the framework does not resolve from Node" is the *normal* case on a host that
 * supplies its own peers, not a broken install. A gate that imports the bundle has to
 * supply the peer itself; otherwise the gate is measuring an accident of whoever's
 * machine ran it.
 *
 * The copy used is this repository's own devDependency — pinned in `package.json`,
 * installed by `pnpm install`, and required by `pnpm verify:bundle` to be the same
 * major line the host publishes. Which copy was used is printed, never implied.
 *
 * Registered with `module.register()`, so it applies to the dynamic `import()` that
 * follows and to nothing else in the process.
 */
const REPO_PACKAGE = new URL('../package.json', import.meta.url)

/** The packages the host owns and a plugin only ever imports. */
const HOST_OWNED = ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis']

/**
 * Re-anchor a host-owned specifier so Node resolves it from this repository.
 * @param specifier - the requested specifier.
 * @param context - the import context Node passes in.
 * @param next - the default hook.
 * @returns the resolved module.
 */
export async function resolve(specifier, context, next) {
  if (HOST_OWNED.includes(specifier)) {
    return next(specifier, { ...context, parentURL: REPO_PACKAGE.href })
  }
  return next(specifier, context)
}
