/**
 * timeout-modern.ts — `withTimeout`, exported at "@itsy/corgi/timeout-modern".
 *
 * The smaller, builtin-based per-attempt deadline plugin — a drop-in for
 * '@itsy/corgi/timeout' at about two-thirds of the bytes, built on
 * `AbortSignal.timeout()` + `AbortSignal.any()` (Baseline-2024).
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/**
 * Per-attempt request deadline — the smaller, builtin-based `withTimeout`
 * (`AbortSignal.timeout()` + `AbortSignal.any()`), about two-thirds of the
 * bytes of `@itsy/corgi/timeout`.
 *
 * Requires a **Baseline-2024** runtime for `AbortSignal.any`: Node 18.17+,
 * Chrome 116+, Firefox 124+, Safari 17.4+, Deno 1.39+, Bun 1.1+; on an older
 * runtime use `@itsy/corgi/timeout` instead.
 *
 * Drop-in with `@itsy/corgi/timeout`: same `ORDER.timeout` slot, same `ms`
 * semantics (`0`/`Infinity` disable), same `"TimeoutError"` name. In both, the
 * deadline and a caller abort cover the body, and the timer stays armed
 * (unref'd) until it fires, even after the request has settled. Combined with
 * `withRetry` each attempt gets a fresh deadline and a fired timeout is
 * retried; for a single total budget pass `signal: AbortSignal.timeout(totalMs)`.
 */
export function withTimeout(ms: number): Plugin {
  return order(ORDER.timeout, (next: Fetcher): Fetcher => (url, init = {}) => {
    const callerSignal = init.signal ?? undefined;

    // An already-aborted caller signal fails now, before constructing timers/signals.
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);

    // ms of 0 / Infinity means "no timeout" — forward untouched.
    if (!ms || ms === Infinity) return next(url, init);

    // `AbortSignal.any` adopts the reason of whichever input aborts first, so a
    // caller abort stays `AbortError` and a fired deadline stays `TimeoutError`
    // downstream — keeping isAbortError/isTimeoutError and retry-on-timeout
    // correct, exactly like the hand-rolled version.
    const deadline = AbortSignal.timeout(ms);
    const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;
    return next(url, { ...init, signal });
  });
}
