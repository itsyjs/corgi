/**
 * timeout.ts — `withTimeout`, exported at "@itsy/corgi/timeout".
 *
 * The per-attempt deadline plugin, hand-rolled from `setTimeout` +
 * `AbortController` to keep a DELIBERATE 2022-safe runtime floor — no
 * `AbortSignal.any()` (that's Baseline-2024). It also buys guaranteed timer
 * cleanup (native `AbortSignal.timeout()` can't be cancelled, so its timer
 * lingers until it fires even after the request settles) and a guaranteed
 * `"TimeoutError"` name on every runtime.
 *
 * Prefer the smaller builtin version if your runtimes are Baseline-2024+
 * (Node 18.17+, Chrome 116+, Firefox 124+, Safari 17.4+):
 *   import { withTimeout } from '@itsy/corgi/timeout-modern'
 * The two are behaviourally drop-in identical (same ORDER slot, same name).
 *
 * Opt-in: importing this module is the only way its bytes enter your bundle.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/**
 * Per-attempt request deadline — the hand-rolled `setTimeout` + `AbortController`
 * build of `withTimeout`.
 *
 * This is the **2022-safe** version: it avoids `AbortSignal.any()` so it runs on
 * any target, and it guarantees timer cleanup (`clearTimeout` on settle), which
 * matters for high-QPS servers with long timeouts. `@itsy/corgi/timeout-modern`
 * is a drop-in ~60%-smaller alternative for Baseline-2024 runtimes — same `ORDER`
 * slot, same `ms` semantics, same `"TimeoutError"` name (README has a table to choose).
 *
 * `ms` of `0` or `Infinity` disables the timeout (request forwarded untouched). A
 * fired deadline rejects with a `DOMException` named `"TimeoutError"` (detect via
 * `isTimeoutError`); a caller cancel keeps its `"AbortError"`.
 *
 * Tagged `ORDER.timeout` (innermost), so combined with `withRetry` each attempt
 * gets its own fresh deadline and a fired timeout is retried. For a single TOTAL
 * budget across all retries, don't use this — pass `signal: AbortSignal.timeout(totalMs)`
 * on the request; when it fires the retry loop sees `signal.aborted` and stops.
 */
export function withTimeout(ms: number): Plugin {
  return order(
    ORDER.timeout,
    (next: Fetcher): Fetcher =>
      (url, init = {}) => {
        const caller = init.signal ?? undefined;

        // If the caller's signal is ALREADY aborted, fail now. A one-shot 'abort'
        // listener (added below) would never fire for an already-aborted signal, so
        // without this check the request would proceed despite being cancelled.
        if (caller?.aborted) return Promise.reject(caller.reason);

        // ms of 0 / Infinity means "no timeout" — just forward untouched.
        if (!ms || ms === Infinity) return next(url, init);

        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new DOMException(`Request timed out after ${ms}ms`, 'TimeoutError')),
          ms,
        );

        // Forward a caller abort to our controller, carrying the caller's own reason
        // (e.g. an AbortError) so downstream code can tell a user-cancel apart from a
        // timeout. Done manually rather than via AbortSignal.any (see file header).
        const onAbort = () => controller.abort(caller!.reason);
        caller?.addEventListener('abort', onAbort, { once: true });

        return next(url, { ...init, signal: controller.signal }).finally(() => {
          clearTimeout(timer); // never leak the timer, even on success
          caller?.removeEventListener('abort', onAbort); // never leak the listener
        });
      },
  );
}
