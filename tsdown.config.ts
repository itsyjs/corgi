import { defineConfig } from 'tsdown';

export default defineConfig({
  // One entry per public export path. Each becomes its own chunk so a consumer
  // who imports `@itsy/corgi/retry` never pulls in dedup/schema/etc.
  entry: {
    index: 'src/index.ts',
    retry: 'src/retry.ts',
    'abort-previous': 'src/abort-previous.ts',
    timeout: 'src/timeout.ts',
    'timeout-modern': 'src/timeout-modern.ts',
    schema: 'src/schema.ts',
    // Batteries-included barrel. Pulls in every other entry on purpose (for
    // size-indifferent contexts), so it gets its own chunk. Published at `/chonk`.
    chonk: 'src/chonk.ts',
  },
  // ESM only — `require(esm)` is unflagged on every runtime we target in 2026,
  // and shipping a single format avoids the dual-package hazard (which would be
  // real here: a duplicated module = a split-brain abort-previous slot).
  format: ['esm'],
  // `neutral` = don't assume Node built-ins; we only use web-standard globals.
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  treeshake: true,
  minify: true,
  clean: true,
  // No content hashes on internal chunk filenames — this is an npm package, not a
  // long-cached web asset. Entry files (index.js, retry.js, …) are never hashed
  // regardless; this drops the `-[hash]` from shared chunks (js + .d.ts). Chunks
  // aren't in the `exports` map, so their names are internal-only.
  hash: false,
  // Validate the published package.json `exports`/types wiring on every build.
  publint: true,
});
