import type { UserConfig } from 'tsdown'

/**
 * Node ESM entries for the DSH Host adapter and its dependency-free OpenCode
 * companion. Neither entry needs a browser half or `dsh.client` declaration.
 */
const config: UserConfig = {
  name: 'dsh-deep-opencode',
  entry: { index: 'src/index.ts', 'opencode/index': 'src/opencode-plugin.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  outputOptions: { entryFileNames: '[name].js' },
}

export default config
