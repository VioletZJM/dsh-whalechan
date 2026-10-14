/**
 * Build for dsh-whalechan.
 *
 * Mirrors the dsh plugin-node contract used by @dickpy/dsh-imagegen: plain ESM
 * in lib/, with every host-shared package left bare so module identity stays
 * the host runtime's own copy (bundling them would duplicate cordis Services).
 *
 * The build is also the **only** thing that writes the reported version: the
 * manifest's `version` is injected as `__WHALECHAN_VERSION__`, so `src/version.ts`
 * and `package.json` cannot disagree. Two literals with no guard used to name two
 * different builds the first time one of them was bumped.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UserConfig } from 'tsdown'

/** Plugin id stamped into the loader roster (must match cordis.patch.yml). */
const ID = 'dsh-whalechan'

/** The manifest, the single source of truth for the reported version. */
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8')) as {
  version: string
}

const config: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  define: {
    __WHALECHAN_VERSION__: JSON.stringify(manifest.version),
  },
  outputOptions: {
    entryFileNames: '[name].js',
  },
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-tools',
      '@deepseek-ai/schemastery',
    ],
  },
}

export default config
