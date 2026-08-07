/**
 * chonk.ts — batteries-included entry, exported at "@itsy/corgi/chonk".
 *
 * For contexts where bundle size doesn't matter (Node, servers, scripts, tests):
 * it re-exports the whole library AND upgrades `corgi` so the built-in
 * plugins become first-class options instead of a hand-composed `plugins` array:
 *
 *   import { corgi } from '@itsy/corgi/chonk'
 *   const api = corgi.create({
 *     baseURL: 'https://api.example.com',
 *     timeout: 5000,        // -> withTimeout(5000)   (hand-rolled, 2022-safe)
 *     retry: 3,             // -> withRetry(3)
 *     abortPrevious: true,  // -> abortPrevious()
 *   })
 *
 * `extend` takes them too, and they OVERRIDE the parent's rather than stacking:
 *
 *   const searchApi = api.extend({ abortPrevious: true })  // its own cancel slot
 *
 * Note `schema` is NOT a client option — validation is per-call (each endpoint has
 * its own shape), so it stays a `transform` exactly like in core: `schema` is
 * re-exported here, used as `client.get(url, { transform: schema(User) })`.
 *
 * For a minimal browser/edge bundle, import the client from '@itsy/corgi' and pull
 * only the plugins you need from their subpaths — none of this entry ships then.
 *
 * (This entry deliberately defeats tree-shaking for its importer — that's the
 * point. It adds no bloat to the other entries.)
 */

import { createCorgi as createCoreCorgi, mergeCorgiOptions } from './corgi.ts';
import type { Corgi, CorgiAPI, CorgiOptions } from './corgi.ts';
import { withRetry, type RetryOptions } from './retry.ts';
import { abortPrevious } from './abort-previous.ts';
import { withTimeout } from './timeout.ts';

/**
 * {@link CorgiOptions} plus first-class options for the built-in plugins. Note
 * `schema` is deliberately NOT an option here — validation is per-call (each
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
}

/** A chonk client: a {@link Corgi} whose `extend` also takes {@link CorgiChonkOptions}. */
export interface CorgiChonk extends Corgi {
  /** Derive a new client. Same rules as core — scalars override, `headers` merge,
   * `plugins` concatenate — plus `retry` / `timeout` / `abortPrevious`, which
   * OVERRIDE the parent's rather than stacking a second layer:
   *
   *   const api = corgi.create({ baseURL: 'https://foo.bar' })
   *   const searchApi = api.extend({ abortPrevious: true })
   */
  extend: (defaults?: CorgiChonkOptions) => CorgiChonk;
}

/** The `/chonk` root export: like {@link CorgiAPI}, but `create` accepts {@link CorgiChonkOptions}. */
export interface CorgiChonkAPI extends CorgiChonk {
  /** Create a fresh `CorgiChonk`, with `retry` / `timeout` / `abortPrevious` as options. */
  create: (defaults?: CorgiChonkOptions) => CorgiChonk;
}

/**
 * Like the core factory, but with `retry` / `timeout` / `abortPrevious` as
 * options. They're translated to plugins and merged with any you pass in
 * `plugins`; the core client order-sorts everything, so the sequence here is
 * irrelevant. Everything else behaves exactly like `@itsy/corgi`'s `corgi.create`.
 */
export function createCorgi(options: CorgiChonkOptions = {}): CorgiChonk {
  const { retry, timeout, abortPrevious: cancel, ...rest } = options;
  const plugins = [...(rest.plugins ?? [])];
  if (cancel) plugins.push(abortPrevious());
  if (retry != null) plugins.push(withRetry(retry));
  if (timeout) plugins.push(withTimeout(timeout));

  // Core's `extend` re-enters the CORE factory, so it would drop the options
  // above. Override it to re-enter this one, merging the raw (untranslated)
  // option bag: re-translating is what lets a child override `timeout`/`retry`
  // instead of stacking a second layer, and switch `abortPrevious` back off.
  // Nothing is lost by minting fresh plugins — a plugin's state lives in the
  // closure `compose` builds per client, so a derived client never shared the
  // parent's anyway (see abort-previous.ts).
  return Object.assign(createCoreCorgi({ ...rest, plugins }), {
    extend: (extra?: CorgiChonkOptions): CorgiChonk => createCorgi(mergeCorgiOptions(options, extra)),
  }) as CorgiChonk;
}

/**
 * The enhanced root export: a zero-config singleton plus `corgi.create(...)` whose
 * options include `retry` / `timeout` / `abortPrevious`. Mirrors `@itsy/corgi`'s
 * `corgi`, but batteries-included.
 */
export const corgi: CorgiChonkAPI = Object.assign(createCorgi(), { create: createCorgi });

/* ---- re-export the rest of the public surface ---------------------------- */
/* `corgi` is intentionally the enhanced version above, so we can't `export *`  */
/* from './index.ts' (that would clash on the name).                            */

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
export type { Corgi, CorgiAPI, CorgiOptions, RetryOptions };

// Plugins: the ones used above are re-exported from their local bindings; the
// modern timeout is aliased so both timeout impls are reachable from `/chonk`.
export { withRetry, abortPrevious, withTimeout };
export { withTimeout as withTimeoutModern } from './timeout-modern.ts';

// Schema (Standard Schema transform + validation error).
export { schema, parseWith, ValidationError, isValidationError } from './schema.ts';
export type { StandardSchemaV1 } from './schema.ts';
