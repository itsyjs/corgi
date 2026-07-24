/**
 * retry.ts — `withRetry`, exported at "@itsy/corgi/retry".
 *
 * Opt-in: importing this module is the only way its bytes enter your bundle.
 *
 * It retries only *idempotent* requests with *replayable* bodies, on transient
 * statuses and network/timeout errors, using exponential backoff with full
 * jitter and honouring `Retry-After`. It never retries a caller-cancelled
 * request, and its backoff wait is itself abortable.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/** Options for {@link withRetry}. Pass a bare number as shorthand for `{ retries: n }`. */
export interface RetryOptions {
  /** Retries *after* the first attempt. Default 2 (so up to 3 total tries). */
  retries?: number;
  /** Base backoff in ms; the wait for attempt n is random in [0, base * 2**n). Default 300. */
  backoff?: number;
  /** Ceiling for any single wait, and the cap applied to `Retry-After`. Default 10_000. */
  maxDelay?: number;
  /** Methods eligible for retry. Default: the idempotent set (safe to repeat). */
  methods?: readonly string[];
  /** Response statuses that trigger a retry. Default: 408/429/500/502/503/504. */
  statuses?: readonly number[];
  /** Called right before each backoff wait — handy for logging/metrics. */
  onRetry?: (info: { attempt: number; delay: number; error?: unknown; response?: Response }) => void;
}

// Methods safe to send more than once (no additional side effects). POST and
// PATCH are intentionally excluded: replaying them can double-create/charge.
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']);

// Transient statuses where a later attempt has a real chance of succeeding.
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * A body can only be retried if it can be re-sent byte-for-byte. Value bodies
 * qualify; a `ReadableStream` is consumed by the first attempt and cannot be
 * replayed, so a request carrying one is never retried.
 */
function isReplayable(body: BodyInit | null | undefined): boolean {
  return (
    body == null ||
    typeof body === 'string' ||
    body instanceof URLSearchParams ||
    body instanceof Blob || // Blob covers File too
    body instanceof FormData ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) // typed arrays & DataView
  );
}

// A caller-initiated cancel (or a superseding abort-previous). Never retry these.
function isCallerAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// Deterministic bugs that surface as a network-looking TypeError — e.g. a
// detached fetch's "Illegal invocation" on Cloudflare Workers. Retrying them just
// burns attempts. (core.ts's bind-safe fetch prevents that specific case at the
// source; this is defense in depth so it's never mistaken for a transient error.)
function isProgrammerError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /illegal invocation|is not a function|not a constructor|cannot read/i.test(error.message)
  );
}

/**
 * Is a *thrown* error worth retrying?
 *   - `TimeoutError`: a per-attempt timeout fired -> try again.
 *   - genuine network `TypeError` (DNS/reset/offline) -> try again.
 *   - anything else (caller aborts handled separately) -> give up.
 */
function isRetryableError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'TimeoutError') ||
    (error instanceof TypeError && !isProgrammerError(error))
  );
}

// Exponential backoff with "full jitter": a random point in [0, window). The
// randomness scatters many clients so they don't retry in lockstep (thundering
// herd); the window doubles each attempt but is clamped to `cap`.
function fullJitter(base: number, attempt: number, cap: number): number {
  return Math.random() * Math.min(cap, base * 2 ** attempt);
}

/**
 * Prefer the server's `Retry-After` over computed backoff (it knows best). The
 * header is either a number of seconds or an HTTP-date — both handled — and the
 * result is capped at `maxDelay` so a broken "wait 2 hours" can't hang the client.
 */
function nextDelay(res: Response | undefined, attempt: number, base: number, cap: number): number {
  const header = res?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (ms > 0) return Math.min(ms, cap);
  }
  return fullJitter(base, attempt, cap);
}

/**
 * A promise-wrapped `setTimeout` that also rejects the instant `signal` aborts.
 * Without this, a cancelled request would still sit out the remaining backoff
 * before noticing. Always clears its timer and listener so nothing leaks.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry transient failures for idempotent requests.
 *
 * Ordering: tagged `ORDER.retry` (300) so it sits OUTSIDE `withTimeout` (400).
 * That means each attempt gets a fresh timeout and a fired timeout is retried.
 * A TOTAL deadline is the caller's job — pass `signal: AbortSignal.timeout(ms)`;
 * when it fires, `init.signal.aborted` is true and the loop stops instead of
 * retrying (even though a timeout technically threw).
 */
export function withRetry(options: RetryOptions | number = {}): Plugin {
  const opts = typeof options === 'number' ? { retries: options } : options;
  const retries = opts.retries ?? 2;
  const base = opts.backoff ?? 300;
  const cap = opts.maxDelay ?? 10_000;
  const methods = new Set((opts.methods ?? [...IDEMPOTENT]).map((m) => m.toUpperCase()));
  const statuses = new Set(opts.statuses ?? [...RETRY_STATUS]);

  return order(
    ORDER.retry,
    (next: Fetcher): Fetcher =>
      async (url, init = {}) => {
        const method = (init.method ?? 'GET').toUpperCase();
        const signal = init.signal ?? undefined;
        // Eligibility is fixed for the whole loop: right method AND a replayable body.
        const eligible = methods.has(method) && isReplayable(init.body);

        for (let attempt = 0; ; attempt++) {
          // If the caller cancelled — or a total-deadline AbortSignal.timeout fired —
          // between attempts, stop immediately; never start another try.
          if (signal?.aborted) throw signal.reason;

          let response: Response;
          try {
            response = await next(url, init);
          } catch (error) {
            // Give up when out of retries, ineligible, cancelled, or not transient.
            if (
              attempt >= retries ||
              !eligible ||
              isCallerAbort(error) ||
              signal?.aborted ||
              !isRetryableError(error)
            ) {
              throw error;
            }
            const delay = fullJitter(base, attempt, cap);
            opts.onRetry?.({ attempt: attempt + 1, error, delay });
            await abortableSleep(delay, signal);
            continue;
          }

          // Got a response: return it unless it's a retryable status with tries left.
          if (attempt >= retries || !eligible || !statuses.has(response.status)) return response;

          // We're discarding this response — cancel its body so the underlying
          // connection is released back to the pool instead of leaking.
          response.body?.cancel().catch(() => {});

          const delay = nextDelay(response, attempt, base, cap);
          opts.onRetry?.({ attempt: attempt + 1, response, delay });
          await abortableSleep(delay, signal);
        }
      },
  );
}
