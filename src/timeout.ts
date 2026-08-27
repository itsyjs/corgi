/**
 * timeout.ts — `withTimeout`, exported at "@itsy/corgi/timeout".
 *
 * The per-attempt deadline plugin, hand-rolled from `setTimeout` +
 * `AbortController` for a deliberate 2022-safe runtime floor — no
 * `AbortSignal.any()`, which is Baseline-2024. The drop-in
 * '@itsy/corgi/timeout-modern' is smaller if your runtimes allow it.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/**
 * Per-attempt request deadline — the hand-rolled `setTimeout` + `AbortController`
 * build of `withTimeout`.
 *
 * The **2022-safe** version: it avoids `AbortSignal.any()` so it runs on any
 * target, and it guarantees timer cleanup (`clearTimeout` on settle), which
 * matters for high-QPS servers with long timeouts. `@itsy/corgi/timeout-modern`
 * is a drop-in ~60%-smaller alternative for Baseline-2024 runtimes — same
 * `ORDER` slot, same `ms` semantics, same `"TimeoutError"` name.
 *
 * `ms` of `0` or `Infinity` disables the timeout. A fired deadline rejects with
 * a `DOMException` named `"TimeoutError"` (detect via `isTimeoutError`); a
 * caller cancel keeps its `"AbortError"`.
 *
 * Tagged `ORDER.timeout` (innermost): combined with `withRetry`, each attempt
 * gets its own fresh deadline and a fired timeout is retried. For a single
 * total budget across all retries, pass `signal: AbortSignal.timeout(totalMs)`
 * instead — when it fires, the retry loop sees `signal.aborted` and stops.
 */
export function withTimeout(ms: number): Plugin {
  return order(ORDER.timeout, (next: Fetcher): Fetcher => (url, init = {}) => {
    const callerSignal = init.signal ?? undefined;

    // An already-aborted caller signal fails now — the one-shot 'abort'
    // listener below would never fire for it.
    if (callerSignal?.aborted) return Promise.reject(callerSignal.reason);

    // ms of 0 / Infinity means "no timeout" — forward untouched.
    if (!ms || ms === Infinity) return next(url, init);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`Request timed out after ${ms}ms`, 'TimeoutError')),
      ms,
    );

    // Forward a caller abort with its own reason, so downstream can tell a
    // user-cancel from a timeout. Manual rather than AbortSignal.any (2022 floor).
    const onAbort = () => controller.abort(callerSignal!.reason);
    callerSignal?.addEventListener('abort', onAbort, { once: true });

    return next(url, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer); // never leak the timer, even on success
      callerSignal?.removeEventListener('abort', onAbort); // never leak the listener
    });
  });
}
