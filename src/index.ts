/**
 * @itsy/corgi — root entry.
 *
 * This barrel exposes the client (`corgi` + `corgi.create`), the composition
 * engine (`compose`, `order`, `ORDER`), and the error type. EVERY plugin —
 * including timeout — is opt-in on its own import path, so it costs nothing
 * unless you reach for it:
 *
 *   import { withRetry } from '@itsy/corgi/retry'
 *   import { abortPrevious } from '@itsy/corgi/abort-previous'
 *   import { withTimeout } from '@itsy/corgi/timeout'         // hand-rolled, 2022-safe
 *   import { withTimeout } from '@itsy/corgi/timeout-modern'  // smaller, Baseline-2024
 *   import { schema } from '@itsy/corgi/schema'
 *
 * Want everything wired with first-class options and don't care about bundle
 * size (Node, servers, scripts)? Use '@itsy/corgi/chonk'.
 */

// Composition engine
export { compose, order, ORDER } from './core.ts';
export type { Fetcher, Plugin } from './core.ts';

// Corgi: the one-off singleton `corgi` (+ `corgi.create()` for configured instances)
export { corgi } from './corgi.ts';
export type { Corgi, CorgiAPI, Call, CorgiOptions, RequestOptions, MappedResponse, HttpMethod } from './corgi.ts';
export type { ParseAs } from './parse.ts';
export type { Query, QueryValue } from './url.ts';

// Errors + guards. (`isTimeoutError` stays here — timeouts thrown by either
// timeout plugin carry the same `TimeoutError` name, so the guard is universal.)
export { HttpError, isHttpError, isTimeoutError, isAbortError } from './error.ts';
