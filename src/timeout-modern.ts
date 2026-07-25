/**
 * timeout-modern.ts — `withTimeout`, exported at "@itsy/corgi/timeout-modern".
 *
 * The smaller, builtin-based per-attempt deadline plugin — a drop-in for
 * '@itsy/corgi/timeout' (same `ORDER.timeout` slot, same `"TimeoutError"` name,
 * same options) at roughly 60% of the bytes. It uses `AbortSignal.timeout()` +
 * `AbortSignal.any()`, so it requires a **Baseline-2024** runtime:
 * Node 18.17+, Chrome 116+, Firefox 124+, Safari 17.4+, Deno 1.39+, Bun 1.1+.
 *
 * Trade-off vs the hand-rolled '@itsy/corgi/timeout': `AbortSignal.timeout()`'s
 * timer can't be cancelled, so it lingers (unref'd on Node) until it fires even
 * after the request settles. Negligible for clients; for very high-QPS servers
 * with long timeouts the hand-rolled version avoids the lingering timers.
 *
 * Opt-in: importing this module is the only way its bytes enter your bundle.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/**
 * Per-attempt request deadline — the smaller, builtin-based `withTimeout`
 * (`AbortSignal.timeout()` + `AbortSignal.any()`), ~60% of the bytes of
 * `@itsy/corgi/timeout`.
 *
 * Requires a **Baseline-2024** runtime for `AbortSignal.any`: Node 18.17+,
 * Chrome 116+, Firefox 124+, Safari 17.4+, Deno 1.39+, Bun 1.1+. On an older
 * runtime use `@itsy/corgi/timeout` instead — this build combines a caller
 * `signal` (including the recommended `AbortSignal.timeout(ms)` total budget) via
 * `AbortSignal.any`, which throws where that's missing. Trade-off: a native
 * `AbortSignal.timeout()` timer can't be cancelled, so it lingers (unref'd on
 * Node) until it fires even after the request settles — negligible for clients,
 * but the hand-rolled build avoids it for very high-QPS servers.
 *
 * Drop-in with `@itsy/corgi/timeout`: same `ORDER.timeout` slot, same `ms`
 * semantics (`0`/`Infinity` disable), same `"TimeoutError"` name. Combined with
 * `withRetry` each attempt gets a fresh deadline and a fired timeout is retried;
 * for a single TOTAL budget pass `signal: AbortSignal.timeout(totalMs)` instead.
 */
export function withTimeout(ms: number): Plugin {
  return order(
    ORDER.timeout,
    (next: Fetcher): Fetcher =>
      (url, init = {}) => {
        const caller = init.signal ?? undefined;

        // If the caller's signal is ALREADY aborted, fail now with its reason —
        // mirrors '@itsy/corgi/timeout' and avoids constructing timers/signals.
        if (caller?.aborted) return Promise.reject(caller.reason);

        // ms of 0 / Infinity means "no timeout" — forward untouched.
        if (!ms || ms === Infinity) return next(url, init);

        // `AbortSignal.timeout(ms)` aborts with a `TimeoutError` DOMException.
        // `AbortSignal.any` adopts the reason of whichever input aborts FIRST (by
        // identity), so a caller abort stays `AbortError` and a timeout stays
        // `TimeoutError` downstream — keeping isAbortError / isTimeoutError and
        // retry-on-timeout correct, exactly like the hand-rolled version.
        const deadline = AbortSignal.timeout(ms);
        const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
        return next(url, { ...init, signal });
      },
  );
}
