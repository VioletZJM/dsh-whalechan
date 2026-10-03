/**
 * Build for dsh-whalechan (host half only; the client half arrives in Phase 4).
 *
 * Mirrors the dsh plugin-node contract used by @dickpy/dsh-imagegen: plain ESM
 * in lib/, with every host-shared package left bare so module identity stays
 * the host runtime's own copy (bundling them would duplicate cordis Services).
 */
import type { UserConfig } from 'tsdown'

/** Plugin id stamped into the loader roster (must match cordis.patch.yml). */
const ID = 'dsh-whalechan'

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
