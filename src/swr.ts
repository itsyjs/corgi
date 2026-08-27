/**
 * swr.ts — `swr`, exported at "@itsy/corgi/swr".
 *
 * Stale-while-revalidate for GETs, in memory: the CDN directive
 * (`Cache-Control: stale-while-revalidate`) brought in-process. Not a
 * subscription layer — nothing re-renders and nothing revalidates on focus
 * (that's a state library's job). It earns its bytes on Node and edge runtimes,
 * whose `fetch` has no HTTP cache, and against APIs whose cache headers you
 * don't control. `swr({ fresh: 0 })` degenerates to pure request dedupe.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/** Options for {@link swr}. Pass a bare number as shorthand for `{ fresh: n }`. */
export interface SwrOptions {
  /**
   * Fresh window in ms: a stored response younger than this is served from
   * memory with no request at all. `0` disables serving from the store, leaving
   * only in-flight sharing — the pure-dedupe recipe.
   */
  fresh: number;
  /**
   * Grace window in ms, added after `fresh` (as the header's
   * `stale-while-revalidate` extends `max-age`): a response inside
   * `fresh + stale` is still served instantly while one detached background
   * refresh updates the store. Default 0 (past `fresh` the next call blocks).
   * `Infinity` means once warm, calls never block again.
   */
  stale?: number;
  /**
   * After a failed refresh — rejected, or refused by `accept` — don't attempt
   * another for this many ms; the stale copy keeps serving meanwhile. Protects
   * a struggling upstream from one refresh per stale hit. A successful refresh
   * clears it. Default 0.
   */
  errorBackoff?: number;
  /**
   * Decide whether a response enters the store (default `response.ok`).
   * Receives its own copy, so it may read the body — e.g. schema-validate and
   * refuse a garbage 200 so the last good response keeps serving. A refusal or
   * throw counts as a failed refresh for `errorBackoff`/`onError`; a
   * foreground caller still gets the refused response as usual.
   */
  accept?: (response: Response) => boolean | Promise<boolean>;
  /**
   * Called when a background refresh fails — the one failure mode no caller
   * ever sees (a foreground miss throws as usual). Exactly one of `error` /
   * `response` is present: `error` on a rejection, `response` when `accept`
   * refused the result.
   */
  onError?: (info: { url: string; error?: unknown; response?: Response }) => void;
}

// The Response constructor throws on any body for these, an empty ArrayBuffer
// included — and fetch guarantees such responses arrive bodyless anyway.
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * A settled response, snapshotted: the body is buffered once (no half-read
 * `clone()` tee pinning memory) and a fresh `Response` is minted from the
 * buffer per serve. The shape doubles as the `ResponseInit` for that mint.
 */
interface Entry {
  /** `Date.now()` at snapshot — the zero point both windows age from. */
  at: number;
  status: number;
  statusText: string;
  headers: Headers;
  body: ArrayBuffer | null;
  /** Set by a failed refresh when `errorBackoff` is on: no re-attempt before
   * this. A successful refresh replaces the whole entry, clearing it. */
  retryAt?: number;
}

const snapshot = async (response: Response): Promise<Entry> => ({
  at: Date.now(),
  status: response.status,
  statusText: response.statusText,
  headers: response.headers,
  body: NULL_BODY_STATUS.has(response.status) ? null : await response.arrayBuffer(),
});

// Entry doubles as ResponseInit (extra keys are ignored). Each caller gets its
// own Response: bodies are one-shot streams.
const mint = (entry: Entry): Response => new Response(entry.body, entry);

/**
 * Serve GETs from an in-memory store: fresh hits skip the network entirely,
 * stale hits are answered instantly while a detached refresh updates the store
 * (the fresh data lands for the next call), and concurrent misses for the same
 * url share one request.
 *
 *   import { corgi } from '@itsy/corgi'
 *   import { swr } from '@itsy/corgi/swr'
 *
 *   const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: 300_000 })] })
 *   await api.get('/rates')   // miss: network, response stored
 *   await api.get('/rates')   // < 60s later: served from memory, zero network
 *   await api.get('/rates')   // 60s–6min: stale served instantly + background refresh
 *
 * Tagged `ORDER.swr` — inside `cancel`, outside `retry`/`timeout` — so a
 * background refresh inherits retry and per-attempt timeout but never re-enters
 * `abortPrevious`. Its signal is stripped too: by this depth `abortPrevious`
 * has swapped in its own controller, and inheriting it would let the next call
 * abort the refresh. Pair with `withTimeout` on servers — a refresh that hangs
 * holds the per-url single-flight slot forever.
 *
 * Only responses `accept` lets in are stored (default `response.ok`); non-GETs
 * pass straight through. A failed refresh keeps the old entry serving
 * (effectively `stale-if-error`), waits out `errorBackoff`, and reports through
 * `onError`. Expired entries are deleted on access; distinct keys are never
 * evicted, so bound your url space or scope the client. Stateful, keyed by the
 * final url alone: if responses differ per user (auth headers, cookies), a
 * shared cache serves user A's data to user B — per-user data means per-user
 * clients.
 */
export function swr(options: SwrOptions | number): Plugin {
  const {
    fresh,
    stale = 0,
    errorBackoff = 0,
    accept = (response: Response) => response.ok,
    onError,
  } = typeof options === 'number' ? { fresh: options } : options;

  return order(ORDER.swr, (next: Fetcher): Fetcher => {
    // Settled snapshots by final url.
    const store = new Map<string, Entry>();
    // In-flight fetches by final url — misses and refreshes share through here.
    const inFlight = new Map<string, Promise<Entry>>();

    // A stored entry at failure time means this was a background refresh (a
    // foreground miss deletes the expired entry before falling through), so its
    // caller saw a synthetic success — stamp the backoff and report. No stored
    // entry: the failure reached a real caller, stay out.
    const failed = (url: string, info: { error?: unknown; response?: Response }): void => {
      const stored = store.get(url);
      if (!stored) return;
      if (errorBackoff) stored.retryAt = Date.now() + errorBackoff;
      onError?.({ url, ...info });
    };

    // One shared network trip per url: the first caller creates it, everyone
    // else joins. The shared request carries the first caller's init (signal
    // included) — classic dedupe tradeoff: if that caller aborts, joiners
    // reject too.
    const fetchEntry = (url: string, init?: RequestInit): Promise<Entry> => {
      let pending = inFlight.get(url);
      if (!pending) {
        pending = next(url, init)
          .then(async (response) => {
            const entry = await snapshot(response);
            // `accept` gets its own copy — reads can't consume the stored buffer.
            if (await accept(mint(entry))) store.set(url, entry);
            else failed(url, { response: mint(entry) });
            return entry;
          })
          .catch((error: unknown) => {
            failed(url, { error });
            throw error; // foreground callers still reject
          })
          .finally(() => inFlight.delete(url));
        inFlight.set(url, pending);
      }
      return pending;
    };

    return (url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return next(url, init);

      const stored = store.get(url);
      if (stored) {
        const age = Date.now() - stored.at;
        if (age < fresh) return Promise.resolve(mint(stored));
        if (age < fresh + stale) {
          // Detached refresh: signal stripped (see the JSDoc), rejection
          // swallowed (an unhandled rejection would take down Node), and
          // single-flighted via `inFlight` so concurrent stale hits join it
          // instead of stampeding. A recent failure (`retryAt`) suppresses it:
          // serve stale, spare the upstream.
          if (!(stored.retryAt && stored.retryAt > Date.now()))
            void fetchEntry(url, { ...init, signal: undefined }).catch(() => {});
          return Promise.resolve(mint(stored));
        }
        store.delete(url); // expired — cleanup on access
      }
      return fetchEntry(url, init).then(mint);
    };
  });
}
