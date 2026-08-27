/**
 * core.ts — the composable engine.
 *
 * Two tiny shapes build everything: a `Fetcher` is a function shaped exactly
 * like `fetch`; a `Plugin` is classic middleware over it
 * (`(next) => (url, init) => ...`) plus an optional `order` hint. `compose`
 * sorts plugins by hint (see {@link ORDER}) and folds them so the lowest-order
 * plugin ends up outermost — it sees the request first and the response last.
 * Plugins that share a hint, or have none, keep the order you listed them in,
 * so `compose(a, b, c)(fetch) === a(b(c(fetch)))` for untagged plugins.
 */

/** A `fetch`-shaped function: the unit every plugin enhances. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A plugin: middleware for `Fetcher`s — `(next) => (url, init) => Promise<Response>`
 * plus an optional `order` hint that lets {@link compose} (and `corgi`, built on
 * it) slot plugins sensibly no matter how you list them (see {@link ORDER}). No
 * hint sorts at 250, between `swr` (200) and `retry` (300); plugins sharing a
 * hint keep listed order.
 *
 * Authoring rules — a plugin is a pure `Response -> Response` layer:
 *   - Always resolve to a `Response`: call `next(url, init)` to continue, or
 *     skip it to short-circuit with a cached/synthetic one.
 *   - Don't consume the body of a `Response` you return — the client parses it
 *     once, after the pipeline. Clone to inspect; release a `Response` you
 *     discard with `response.body?.cancel()` so the connection is freed.
 *   - Treat `init` as immutable: pass a fresh object, never mutate the
 *     caller's. When you replace `signal`, forward the caller's abort + reason
 *     too, so `isAbortError`/`isTimeoutError` stay correct downstream.
 *   - A plugin receives the final url string and a serialized `RequestInit`.
 *     To map/validate the parsed value use a per-call `transform`, not a plugin.
 *
 *   // log every request/response. Untagged -> runs once per logical call.
 *   const withLog: Plugin = (next) => async (url, init) => {
 *     const response = await next(url, init)
 *     console.log(response.status, init?.method ?? 'GET', url)
 *     return response
 *   }
 */
export type Plugin = ((next: Fetcher) => Fetcher) & { readonly order?: number };

/**
 * Canonical ordering slots (lower number = further out, runs earlier on the
 * request):
 *
 *   cancel (100)  — outermost: a superseding call aborts the entire prior
 *                   chain, queued retries included.
 *   swr    (200)  — share results across identical callers: in-flight dedupe
 *                   and response caching.
 *   retry  (300)  — re-run the request; sits outside timeout so each attempt
 *                   gets its own fresh deadline.
 *   timeout (400) — innermost, right next to `fetch`: a per-attempt deadline
 *                   (a fired timeout is retried). For a single total deadline
 *                   across all retries, pass `signal: AbortSignal.timeout(ms)`
 *                   instead.
 */
export const ORDER = {
  cancel: 100,
  swr: 200,
  retry: 300,
  timeout: 400,
} as const;

/**
 * Attach an ordering hint to a plugin so `corgi` can slot it correctly:
 *
 *   const withAuth = order(ORDER.retry - 1, (next) => (url, init) => next(url, addToken(init)))
 *
 * `ORDER.retry - 1` puts auth just outside retry, so the token is applied once
 * per logical call rather than re-applied on every attempt.
 */
export function order<F extends (next: Fetcher) => Fetcher>(hint: number, plugin: F): Plugin {
  // Plain assignment (not Object.assign) — same own-enumerable-prop result, fewer
  // bytes, and no `Object.assign` literal for gzip to carry. Casts are erased.
  (plugin as unknown as { order: number }).order = hint;
  return plugin as unknown as Plugin;
}

/**
 * Resolve a base `Fetcher` from an optional custom `fetch` implementation.
 *
 * Never passes a *detached* `globalThis.fetch` down the pipeline: on Cloudflare
 * Workers `fetch` brand-checks its receiver, so a bare
 * `const f = globalThis.fetch; f(url)` throws "Illegal invocation". The arrow
 * wrapper keeps the receiver as `globalThis` on every runtime.
 */
export function resolveFetch(custom?: typeof fetch): Fetcher {
  // A custom fetch was already being called detached, so it passes through as-is.
  return custom ?? ((url, init) => globalThis.fetch(url, init));
}

/** Untagged plugins land between `swr` and `retry`. */
export const DEFAULT_ORDER = 250;

export const byOrder = (a: Plugin, b: Plugin): number => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER);

/**
 * Compose plugins into one: sort by `order` hint (stable, so equal/untagged
 * plugins keep listed order), then fold outermost-first:
 *
 *   compose(a, b, c)(base) === a(b(c(base)))   // when a, b, c share/omit order
 *
 * Call the result with a base `Fetcher` to get the final pipeline; omit the
 * base to use a bind-safe global `fetch` (receiver-correct on Cloudflare
 * Workers):
 *
 *   const call = compose(withRetry(), withTimeout(5000))()   // -> Fetcher
 *
 * Need a layering that fights the hints? A Plugin is just `(next) => Fetcher` —
 * nest by hand, `a(b(c(base)))`, and skip the sort.
 */
export function compose(...plugins: Plugin[]): (base?: Fetcher) => Fetcher {
  // The rest array is fresh, so the in-place sort touches nothing shared;
  // reduceRight puts the lowest-order plugin outermost.
  plugins.sort(byOrder);
  return (base) => plugins.reduceRight<Fetcher>((next, plugin) => plugin(next), base ?? resolveFetch());
}
