/**
 * swr.ts — `swr`, exported at "@itsy/corgi/swr".
 *
 * Opt-in: importing this module is the only way its bytes enter your bundle.
 *
 * Stale-while-revalidate for GETs, in memory: for `fresh` ms a stored response
 * is served with zero network; for the next `stale` ms the stored copy is still
 * served INSTANTLY while a detached background refresh updates the store; after
 * both windows the next call misses and blocks on the network again. Concurrent
 * misses for the same url share one in-flight request, so `swr({ fresh: 0 })`
 * degenerates to pure request dedupe. `stale: Infinity` is first-class: once
 * warm, calls never block again. A failing upstream can be rate-limited
 * (`errorBackoff`), gated (`accept`), and observed (`onError`).
 *
 * This is the CDN directive (`Cache-Control: stale-while-revalidate`) brought
 * in-process — a promise settles once, so the call that TRIGGERS a refresh gets
 * the stale copy and the fresh data lands for the NEXT call. It is not a
 * subscription layer: nothing re-renders and nothing revalidates on focus
 * (that's a state library's job). Where it earns its bytes: Node and edge
 * runtimes, whose `fetch` has NO HTTP cache — every call is a network round
 * trip — and browsers calling APIs whose cache headers you don't control.
 *
 * State note: the store lives in this plugin's closure, built once per client,
 * so the cache's scope IS the client (`extend()` re-composes and gets a fresh,
 * empty one). The key is the final URL alone. That makes module-scope sharing
 * on a server a decision, not a default: if responses differ per user (auth
 * headers, cookies), a shared cache serves user A's data to user B. Per-user
 * data ⇒ per-request (or per-user) clients; share at module scope only for
 * genuinely shared data (rates, catalogs, flags).
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
   * Grace window in ms, ADDED after `fresh` (mirroring how the header's
   * `stale-while-revalidate` extends `max-age`): a response older than `fresh`
   * but inside `fresh + stale` is still served instantly, and one detached
   * background refresh is fired to update the store. Default 0 (no grace: past
   * `fresh` the next call blocks on the network). `Infinity` means once warm,
   * calls never block again — the stale copy is always served while refreshes
   * happen in the background.
   */
  stale?: number;
  /**
   * After a failed refresh — rejected, or a response `accept` refused — don't
   * attempt another one for this many ms; the stale copy keeps being served
   * meanwhile. Protects a struggling upstream (and your logs) from one refresh
   * per stale hit, e.g. during a rolling deploy. A successful refresh clears
   * it. Default 0 (re-attempt on the next stale hit).
   */
  errorBackoff?: number;
  /**
   * Decide whether a response enters the store (default: `(res) => res.ok`).
   * Receives its OWN copy of the response, so it may read the body — e.g.
   * schema-validate it and refuse a garbage 200 so the last good response keeps
   * being served. A refusal (or a thrown `accept`) counts as a failed refresh
   * for `errorBackoff` and `onError`; the refused response still goes to a
   * foreground caller as usual.
   */
  accept?: (res: Response) => boolean | Promise<boolean>;
  /**
   * Called when a BACKGROUND refresh fails — the one failure mode no caller
   * ever sees (a foreground miss throws to its caller as usual). Exactly one of
   * `error` / `response` is present: `error` on a rejection, `response` when
   * `accept` (or the default `res.ok`) refused the result.
   */
  onError?: (info: { url: string; error?: unknown; response?: Response }) => void;
}

// Statuses whose Response must be minted with a null body — the constructor
// throws on ANY body for these, an empty ArrayBuffer included. (fetch itself
// guarantees such responses arrive bodyless, so there is nothing to drop.)
const NULL_BODY = new Set([204, 205, 304]);

/**
 * A settled response, snapshotted: the body is buffered ONCE (fully consuming
 * the origin response — no half-read `clone()` tee pinning memory) and a fresh
 * `Response` is minted from the buffer per serve. The shape deliberately
 * doubles as the `ResponseInit` for that mint.
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

const snapshot = async (res: Response): Promise<Entry> => ({
  at: Date.now(),
  status: res.status,
  statusText: res.statusText,
  headers: res.headers,
  body: NULL_BODY.has(res.status) ? null : await res.arrayBuffer(),
});

// Entry doubles as ResponseInit (extra keys are ignored), so a serve is one
// constructor call. Each caller gets its OWN Response: bodies are one-shot
// streams, so handing out the stored object would work exactly once.
const mint = (e: Entry): Response => new Response(e.body, e);

/**
 * Serve GETs from an in-memory store: fresh hits skip the network entirely,
 * stale hits are answered instantly while a detached refresh updates the store,
 * and concurrent misses for the same url share one request.
 *
 *   import { corgi } from '@itsy/corgi'
 *   import { swr } from '@itsy/corgi/swr'
 *
 *   // Plugins are client-level — build the client ONCE and reuse it.
 *   const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: 300_000 })] })
 *   await api.get('/rates')   // miss: network, response stored
 *   await api.get('/rates')   // < 60s later: served from memory, zero network
 *   await api.get('/rates')   // 60s–6min: stale served instantly + background refresh
 *
 * Tagged `ORDER.swr` — inside `cancel`, outside `retry`/`timeout` — which is
 * what makes the background refresh sound: it re-enters the pipeline at this
 * depth, so it INHERITS retry and per-attempt timeout, but never re-enters
 * `abortPrevious` (a refresh cannot cancel a live request). Its signal is
 * stripped too — by this depth `abortPrevious` has swapped in its own
 * controller, and inheriting it would let the NEXT call abort the refresh, so
 * under steady traffic the cache would never get fresher. Pair with
 * `withTimeout` on servers: without a deadline, a refresh that HANGS holds the
 * per-url single-flight slot forever and no further refresh can start.
 *
 * Only responses `accept` lets in are stored (default `res.ok`), and only GETs
 * are considered at all — everything else passes straight through. A failed
 * refresh keeps the old entry serving (`stale-if-error`, effectively), waits
 * out `errorBackoff` before re-attempting, and reports through `onError`.
 * Expired entries are deleted when a call touches them; distinct keys are
 * otherwise never evicted, so bound your url space or scope the client. This
 * plugin is STATEFUL — see the header for what that means on a server (short
 * version: URL-only keys + per-user responses ⇒ don't share a client across
 * users).
 */
export function swr(options: SwrOptions | number): Plugin {
  const {
    fresh,
    stale = 0,
    errorBackoff = 0,
    accept = (res: Response) => res.ok,
    onError,
  } = typeof options === 'number' ? { fresh: options } : options;

  return order(ORDER.swr, (next: Fetcher): Fetcher => {
    /** Settled snapshots by final url. */
    const store = new Map<string, Entry>();
    /** In-flight fetches by final url — misses AND refreshes share through here. */
    const inflight = new Map<string, Promise<Entry>>();

    // A failure NOBODY else sees: a stored entry at failure time means this was
    // a background refresh (a foreground miss never has one — the expired path
    // deletes before falling through), so its caller got a synthetic success
    // and the failure would otherwise vanish. Stamp the backoff and report it.
    // Without a stored entry the failure reached a real caller — stay out.
    const failed = (url: string, info: { error?: unknown; response?: Response }): void => {
      const cur = store.get(url);
      if (!cur) return;
      if (errorBackoff) cur.retryAt = Date.now() + errorBackoff;
      onError?.({ url, ...info });
    };

    // One shared network trip per url: the first caller creates it, everyone
    // else joins, and each gets a minted Response off the settled entry. The
    // shared request carries the FIRST caller's init (signal included) — same
    // tradeoff as classic dedupe: if that caller aborts, joiners reject too.
    const fetchEntry = (url: string, init?: RequestInit): Promise<Entry> => {
      let p = inflight.get(url);
      if (!p) {
        p = next(url, init)
          .then(async (res) => {
            const entry = await snapshot(res);
            // `accept` gets its own copy — reads can't consume the stored buffer.
            if (await accept(mint(entry))) store.set(url, entry);
            else failed(url, { response: mint(entry) });
            return entry;
          })
          .catch((error: unknown) => {
            failed(url, { error });
            throw error; // foreground callers still reject
          })
          .finally(() => inflight.delete(url));
        inflight.set(url, p);
      }
      return p;
    };

    return (url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') return next(url, init);

      const e = store.get(url);
      if (e) {
        const age = Date.now() - e.at;
        if (age < fresh) return Promise.resolve(mint(e));
        if (age < fresh + stale) {
          // Detached refresh: signal stripped (see the doc comment), rejection
          // swallowed (an unhandled rejection would take down Node), and
          // single-flighted for free — it lives in `inflight`, so concurrent
          // stale hits join it instead of stampeding, and a call that arrives
          // after expiry joins it instead of double-fetching. A recent failure
          // (`retryAt`) suppresses it entirely: serve stale, spare the upstream.
          if (!(e.retryAt && e.retryAt > Date.now()))
            void fetchEntry(url, { ...init, signal: undefined }).catch(() => {});
          return Promise.resolve(mint(e));
        }
        store.delete(url); // expired — cleanup on access
      }
      return fetchEntry(url, init).then(mint);
    };
  });
}
