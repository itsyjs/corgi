/**
 * chonk.ts — batteries-included entry, exported at "@itsy/corgi/chonk".
 *
 * For contexts where bundle size doesn't matter (Node, servers, scripts,
 * tests): re-exports the whole library and upgrades `corgi` so the built-in
 * plugins become first-class options instead of a hand-composed `plugins` array:
 *
 *   import { corgi } from '@itsy/corgi/chonk'
 *   const api = corgi.create({
 *     baseURL: 'https://api.example.com',
 *     timeout: 5000,        // -> withTimeout(5000)
 *     retry: 3,             // -> withRetry(3)
 *     abortPrevious: true,  // -> abortPrevious()
 *     swr: 60_000,          // -> swr(60_000)
 *   })
 *
 * For a minimal browser/edge bundle, import from '@itsy/corgi' and the plugin
 * subpaths instead — none of this entry ships then. (Defeating tree-shaking
 * for its importer is the point; it adds no bloat to the other entries.)
 */

import { createCorgi as createCoreCorgi, mergeCorgiOptions } from './corgi.ts';
import type { Corgi, CorgiAPI, CorgiOptions } from './corgi.ts';
import { withRetry, type RetryOptions } from './retry.ts';
import { abortPrevious } from './abort-previous.ts';
import { withTimeout } from './timeout.ts';
import { swr, type SwrOptions } from './swr.ts';

/**
 * {@link CorgiOptions} plus first-class options for the built-in plugins.
 * `schema` is deliberately not an option here — validation is per-call (each
 * endpoint has its own shape), so use it as a `transform`:
 * `client.get(url, { transform: schema(User) })`.
 */
export interface CorgiChonkOptions extends CorgiOptions {
  /** Retry transient failures. A bare number is shorthand for `{ retries: n }`
   * (`0` = no retries). Omit to add no retry plugin at all. */
  retry?: RetryOptions | number;
  /** Per-attempt deadline in ms (uses the hand-rolled 2022-safe `withTimeout`;
   * import from `/chonk` as `withTimeoutModern` if you want the builtin one). */
  timeout?: number;
  /** Abort the previous in-flight request whenever a new one starts. */
  abortPrevious?: boolean;
  /** Serve GETs stale-while-revalidate from an in-memory store: `{ fresh, stale }`
   * windows in ms. A bare number is shorthand for `{ fresh: n }` (`0` = pure
   * in-flight dedupe). Omit to add no cache at all. */
  swr?: SwrOptions | number;
}

/** A chonk client: a {@link Corgi} whose `extend` also takes {@link CorgiChonkOptions}. */
export interface CorgiChonk extends Corgi {
  /** Derive a new client. Same rules as core — scalars override, `headers`
   * merge, `plugins` concatenate — plus `retry` / `timeout` / `abortPrevious` /
   * `swr`, which override the parent's rather than stacking a second layer:
   *
   *   const api = corgi.create({ baseURL: 'https://foo.bar' })
   *   const searchApi = api.extend({ abortPrevious: true })
   */
  extend: (defaults?: CorgiChonkOptions) => CorgiChonk;
}

/** The `/chonk` root export: like {@link CorgiAPI}, but `create` accepts {@link CorgiChonkOptions}. */
export interface CorgiChonkAPI extends CorgiChonk {
  /** Create a fresh `CorgiChonk`, with `retry` / `timeout` / `abortPrevious` / `swr` as options. */
  create: (defaults?: CorgiChonkOptions) => CorgiChonk;
}

/**
 * Like the core factory, but with `retry` / `timeout` / `abortPrevious` / `swr`
 * as options. They're translated to plugins and merged with any you pass in
 * `plugins`; the core client order-sorts everything. Otherwise behaves exactly
 * like `@itsy/corgi`'s `corgi.create`.
 */
export function createCorgi(options: CorgiChonkOptions = {}): CorgiChonk {
  const { retry, timeout, abortPrevious: cancel, swr: cache, ...rest } = options;
  const plugins = [...(rest.plugins ?? [])];
  if (cancel) plugins.push(abortPrevious());
  if (cache != null) plugins.push(swr(cache));
  if (retry != null) plugins.push(withRetry(retry));
  if (timeout) plugins.push(withTimeout(timeout));

  // Core's `extend` re-enters the core factory and would drop these options.
  // Re-enter this one instead, merging the raw option bag: re-translating is
  // what lets a child override `timeout`/`retry` rather than stack a second
  // layer. Minting fresh plugins loses nothing — plugin state lives in the
  // closure `compose` builds per client, so a child never shared it anyway.
  return Object.assign(createCoreCorgi({ ...rest, plugins }), {
    extend: (extra?: CorgiChonkOptions): CorgiChonk => createCorgi(mergeCorgiOptions(options, extra)),
  }) as CorgiChonk;
}

/**
 * The enhanced root export: mirrors `@itsy/corgi`'s `corgi`, but `create`
 * accepts `retry` / `timeout` / `abortPrevious` / `swr`.
 */
export const corgi: CorgiChonkAPI = Object.assign(createCorgi(), { create: createCorgi });

// `corgi` here is the enhanced version, so `export *` from './index.ts' would
// clash on the name — re-export the rest explicitly.
export { compose, order, ORDER, HttpError, isHttpError, isTimeoutError, isAbortError } from './index.ts';
export type {
  Fetcher,
  Plugin,
  Call,
  RequestOptions,
  MappedResponse,
  ParseAs,
  Query,
  QueryValue,
  HttpMethod,
} from './index.ts';
export type { Corgi, CorgiAPI, CorgiOptions, RetryOptions, SwrOptions };

// The modern timeout is aliased so both timeout impls are reachable from `/chonk`.
export { withRetry, abortPrevious, withTimeout, swr };
export { withTimeout as withTimeoutModern } from './timeout-modern.ts';

export { schema, parseWith, ValidationError, isValidationError } from './schema.ts';
export type { StandardSchemaV1 } from './schema.ts';
