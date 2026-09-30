import type { UserConfig } from 'tsdown'

/**
 * Host-only build: one Node ESM entry at `lib/index.js`. The plugin registers a
 * Host-side `ctx.llm` adapter, so it has no browser half and no `dsh.client`
 * declaration in package.json.
 */
const config: UserConfig = {
  name: 'dsh-deep-opencode',
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: true,
  outputOptions: { entryFileNames: 'index.js' },
}

export default config
