/**
 * retry.ts — `withRetry`, exported at "@itsy/corgi/retry".
 *
 * Retries only *idempotent* requests with *replayable* bodies, on transient
 * statuses and network/timeout errors, using exponential backoff with full
 * jitter and honouring `Retry-After`. Never retries a caller-cancelled request;
 * the backoff wait is itself abortable.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/** Options for {@link withRetry}. Pass a bare number as shorthand for `{ retries: n }`. */
export interface RetryOptions {
  /** Retries *after* the first attempt. Default 2 (so up to 3 total tries). */
  retries?: number;
  /**
   * Base backoff in ms (default 300). Exponential with full jitter: the wait
   * before the k-th retry (k >= 1) is random in
   * `[0, min(maxDelay, backoff * 2 ** (k - 1)))`. The randomness scatters clients so
   * they don't retry in lockstep (thundering herd). A `Retry-After` overrides it.
   */
  backoff?: number;
  /** Ceiling for any single wait, and the cap applied to `Retry-After`. Default 10_000. */
  maxDelay?: number;
  /**
   * Methods eligible for retry. Default: the idempotent methods
   * `GET, HEAD, PUT, DELETE, OPTIONS, TRACE`. `POST` and `PATCH` are excluded —
   * replaying them can double-create/charge; opt one in only if you know it's safe.
   */
  methods?: readonly string[];
  /**
   * Response statuses that trigger a retry. Default: 408/429/500/502/503/504.
   * A `Retry-After` header (seconds or an HTTP-date) on a retried response is
   * honored in place of computed backoff, capped at `maxDelay` — fractional
   * seconds included (`Retry-After: 0.001` waits 1ms). That's contract, not an
   * accident of parsing: it's the documented lever for exercising retry against
   * a client whose config a test can't touch (see "@itsy/corgi/testing").
   */
  statuses?: readonly number[];
  /**
   * Called right before each backoff wait — handy for logging/metrics. `attempt`
   * is 1-based (1 = the first retry). Exactly one of `error` / `response` is
   * present: `error` on a thrown failure, `response` on a retryable status.
   */
  onRetry?: (info: { attempt: number; delay: number; error?: unknown; response?: Response }) => void;
}

// Safe to send more than once. POST/PATCH excluded: replaying can double-create/charge.
const IDEMPOTENT = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE']);

// Transient statuses where a later attempt has a real chance of succeeding.
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// A body qualifies only if it can be re-sent byte-for-byte; a ReadableStream
// is consumed by the first attempt and can't be replayed.
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
// detached fetch's "Illegal invocation" on Cloudflare Workers. Retrying them
// just burns attempts; core.ts prevents that case, this is defense in depth.
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

// Full jitter: a random point in [0, window), the window doubling per attempt
// and clamped to `maxDelay` — scatters clients so they don't retry in lockstep.
function fullJitter(baseDelay: number, attempt: number, maxDelay: number): number {
  return Math.random() * Math.min(maxDelay, baseDelay * 2 ** attempt);
}

// Prefer the server's `Retry-After` (seconds or an HTTP-date) over computed
// backoff, capped at `maxDelay` so a broken "wait 2 hours" can't hang the
// client. `Number()` (not `parseInt`) is deliberate: fractional seconds are
// kept, which `@itsy/corgi/testing` documents as the way to drive retry in
// ~1ms. A parse-to-spec "cleanup" here would break those suites.
function nextDelay(response: Response | undefined, attempt: number, baseDelay: number, maxDelay: number): number {
  const header = response?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const delayMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (delayMs > 0) return Math.min(delayMs, maxDelay);
  }
  return fullJitter(baseDelay, attempt, maxDelay);
}

// A promise-wrapped `setTimeout` that rejects the instant `signal` aborts —
// otherwise a cancelled request would sit out the remaining backoff. Always
// clears its timer and listener.
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
 * Retry transient failures for idempotent requests, with exponential backoff +
 * full jitter and `Retry-After` support.
 *
 * Eligibility is fixed once per call: the method must be in `methods` (default
 * idempotent set) and the body must be replayable. Value bodies (none, string,
 * `URLSearchParams`, `Blob`/`File`, `FormData`, `ArrayBuffer`/typed arrays)
 * qualify; a `ReadableStream` body is consumed by the first attempt and is
 * never retried, even on an idempotent method.
 *
 * A retry is triggered by a status in `statuses`, a thrown per-attempt
 * `TimeoutError`, or a genuine network `TypeError` — never by a caller
 * `AbortError` (or a fired total-deadline signal) or a programmer-error
 * `TypeError` ("is not a function", "Illegal invocation").
 *
 * Tagged `ORDER.retry` (300), outside `withTimeout` (400): each attempt gets a
 * fresh timeout and a fired timeout is retried. A total deadline is the
 * caller's job — pass `signal: AbortSignal.timeout(ms)`; when it fires, the
 * loop stops instead of retrying.
 */
export function withRetry(options: RetryOptions | number = {}): Plugin {
  const {
    retries = 2,
    backoff: baseDelay = 300,
    maxDelay = 10_000,
    methods = [...IDEMPOTENT],
    statuses = [...RETRY_STATUS],
    onRetry,
  } = typeof options === 'number' ? { retries: options } : options;

  const retryableMethods = new Set(methods.map((method) => method.toUpperCase()));
  const retryableStatuses = new Set(statuses);

  return order(ORDER.retry, (next: Fetcher): Fetcher => async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const signal = init.signal ?? undefined;
    const eligible = retryableMethods.has(method) && isReplayable(init.body);

    for (let attempt = 0; ; attempt++) {
      // Cancelled between attempts (caller or total deadline) — never start another try.
      if (signal?.aborted) throw signal.reason;

      let response: Response;
      try {
        response = await next(url, init);
      } catch (error) {
        // Give up when out of retries, ineligible, cancelled, or not transient.
        if (attempt >= retries || !eligible || isCallerAbort(error) || signal?.aborted || !isRetryableError(error)) {
          throw error;
        }
        const delay = fullJitter(baseDelay, attempt, maxDelay);
        onRetry?.({ attempt: attempt + 1, error, delay });
        await abortableSleep(delay, signal);
        continue;
      }

      if (attempt >= retries || !eligible || !retryableStatuses.has(response.status)) return response;

      // Discarded — cancel the body so the connection returns to the pool.
      response.body?.cancel().catch(() => {});

      const delay = nextDelay(response, attempt, baseDelay, maxDelay);
      onRetry?.({ attempt: attempt + 1, response, delay });
      await abortableSleep(delay, signal);
    }
  });
}
