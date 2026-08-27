import { defineConfig } from 'tsdown';

export default defineConfig({
  // One entry per public export path. Each becomes its own chunk so a consumer
  // who imports `@itsy/corgi/retry` never pulls in dedup/schema/etc.
  entry: {
    index: 'src/index.ts',
    retry: 'src/retry.ts',
    'abort-previous': 'src/abort-previous.ts',
    swr: 'src/swr.ts',
    timeout: 'src/timeout.ts',
    'timeout-modern': 'src/timeout-modern.ts',
    schema: 'src/schema.ts',
    // Test helpers (mockFetch + error factories). Dev-only, so it's exempt
    // from size-limit — but still a real entry so types/publint cover it.
    testing: 'src/testing.ts',
    // Batteries-included barrel. Pulls in every other entry on purpose (for
    // size-indifferent contexts), so it gets its own chunk. Published at `/chonk`.
    chonk: 'src/chonk.ts',
  },
  // ESM only — `require(esm)` is unflagged on every runtime we target in 2026,
  // and shipping a single format avoids the dual-package hazard (which would be
  // real here: a duplicated module = a split-brain abort-previous slot).
  format: ['esm'],
  // `neutral` = don't assume Node built-ins; only web-standard globals are used.
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  treeshake: true,
  minify: true,
  clean: true,
  // No content hashes on chunk filenames — this is an npm package, not a
  // long-cached web asset. Entries are never hashed regardless; this drops the
  // `-[hash]` from shared chunks, whose names are internal-only (not in `exports`).
  hash: false,
  // Prefix shared chunks (js + .d.ts) so they can never claim an entry's
  // filename: rolldown's dts chunk naming once handed the shared chunk the name
  // `index.d.ts`, demoting the real root entry to `index2.d.ts` and breaking
  // every `types` condition in `exports`.
  outputOptions: {
    chunkFileNames: 'chunk-[name].js',
  },
  // Validate the published package.json `exports`/types wiring on every build.
  publint: true,
});
