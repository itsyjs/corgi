/**
 * core.ts — the composable engine.
 *
 * Everything in Corgi is built from two tiny shapes:
 *
 *   Fetcher  — a function that looks exactly like `fetch`: give it a url (+ init)
 *              and it resolves to a `Response`.
 *   Plugin   — a function that takes a `Fetcher` and returns an enhanced one.
 *              This is the classic middleware shape (`(next) => (url, init) => ...`);
 *              a Plugin is that middleware plus an optional `order` hint.
 *
 * You build a pipeline by wrapping a base fetcher in layers, from the outside in.
 * `compose` sorts plugins by their `order` hint (see {@link ORDER}) and folds them
 * outermost-first, so the LOWEST-order plugin ends up outermost (it sees the
 * request first and the response last) and the highest sits closest to the real
 * `fetch`. Plugins that share a hint — or have none — keep the order you listed
 * them in, so `compose(a, b, c)(fetch) === a(b(c(fetch)))` for untagged plugins.
 */

/** A `fetch`-shaped function: the unit every plugin enhances. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A plugin: middleware for `Fetcher`s — `(next) => (url, init) => Promise<Response>`.
 * The optional `order` hint lets {@link compose} (and `corgi`, built on it) place
 * plugins in a sensible sequence no matter what order you list them in (see
 * {@link ORDER}). A plugin with NO hint sorts at 250 — between `dedupe` (200) and
 * `retry` (300); plugins that share a hint keep the order you listed them in.
 *
 * Authoring rules — a plugin is a pure `Response -> Response` layer:
 *   - Always resolve to a `Response`. Call `next(url, init)` to continue, or skip
 *     it to short-circuit (serve a cached/synthetic `Response` without hitting fetch).
 *   - Do NOT consume the body of a `Response` you return — the client parses it once,
 *     after the pipeline. Clone to inspect (`res.clone()`) and return the original.
 *     Release a `Response` you DISCARD with `res.body?.cancel()` so the connection
 *     is freed.
 *   - Treat `init` as immutable: pass a fresh object — `next(url, { ...init, headers })`
 *     — never mutate the caller's. When you replace `signal`, forward the caller's
 *     abort + reason too (so `isAbortError`/`isTimeoutError` stay correct downstream).
 *   - A plugin receives the FINAL url string and a `RequestInit`: `query` is already
 *     merged into the url and `body` already serialized. To map/validate the PARSED
 *     value use a per-call `transform`, not a plugin.
 *
 *   // log every request/response. Untagged -> runs once per logical call.
 *   const withLog: Plugin = (next) => async (url, init) => {
 *     const res = await next(url, init)
 *     console.log(res.status, init?.method ?? 'GET', url)
 *     return res
 *   }
 */
export type Plugin = ((next: Fetcher) => Fetcher) & { readonly order?: number };

/**
 * Canonical ordering slots (lower number = further OUT, runs earlier on the
 * request). The defaults are chosen so behaviour is correct out of the box:
 *
 *   cancel (100)  — outermost: a superseding call aborts the ENTIRE prior chain,
 *                   including any retries it had queued.
 *   dedupe (200)  — share one in-flight request across identical callers.
 *   retry  (300)  — re-run the request; sits OUTSIDE timeout so each attempt
 *                   gets its own fresh deadline.
 *   timeout (400) — innermost plugin, right next to `fetch`: combined with retry
 *                   this gives each attempt its own PER-ATTEMPT deadline (and a
 *                   fired timeout is retried). For a single TOTAL deadline across
 *                   all retries, pass `signal: AbortSignal.timeout(ms)` instead.
 *                   (Timeout is opt-in: `@itsy/corgi/timeout[-modern]`.)
 */
export const ORDER = {
  cancel: 100,
  dedupe: 200,
  retry: 300,
  timeout: 400,
} as const;

/**
 * Attach an ordering hint to a plugin so `corgi` can slot it correctly.
 * Built-in plugins use this internally; reach for it when writing your own:
 *
 *   const withAuth = order(ORDER.retry - 1, (next) => (url, init) => next(url, addToken(init)))
 *
 * Here `ORDER.retry - 1` puts auth just OUTSIDE retry, so the token is applied
 * once per logical call rather than re-applied on every retry attempt.
 */
export function order<F extends (next: Fetcher) => Fetcher>(n: number, plugin: F): Plugin {
  // Plain assignment (not Object.assign) — same own-enumerable-prop result, fewer
  // bytes, and no `Object.assign` literal for gzip to carry. Casts are erased.
  (plugin as unknown as { order: number }).order = n;
  return plugin as unknown as Plugin;
}

/**
 * Resolve a base `Fetcher` from an optional custom `fetch` implementation.
 *
 * IMPORTANT: we never pass a *detached* `globalThis.fetch` down the pipeline.
 * On Cloudflare Workers `fetch` brand-checks its receiver, so a bare
 * `const f = globalThis.fetch; f(url)` throws "Illegal invocation". Wrapping the
 * call in an arrow keeps the receiver as `globalThis` on every runtime.
 */
export function resolveFetch(custom?: typeof fetch): Fetcher {
  // A custom fetch is returned as-is (it was already called detached before, so
  // this is behaviourally identical). The global path stays wrapped in an arrow
  // so the receiver remains `globalThis` — see the header note.
  return custom ?? ((url, init) => globalThis.fetch(url, init));
}

/** Untagged plugins land between `dedupe` and `retry` — a sane middle ground. */
export const DEFAULT_ORDER = 250;

/** Comparator that orders plugins by their `order` hint (untagged -> DEFAULT_ORDER). */
export const byOrder = (a: Plugin, b: Plugin): number => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER);

/**
 * Compose plugins into a single plugin: sort by their `order` hint, then fold
 * outermost-first (lower `order` = further out). The sort is stable, so plugins
 * that share a hint — or have none — keep the order you listed them in:
 *
 *   compose(a, b, c)(base) === a(b(c(base)))   // when a, b, c share/omit order
 *
 * Call the result with a base `Fetcher` to get the final pipeline. If you omit
 * the base, a bind-safe global `fetch` is used (an arrow wrapper around
 * `globalThis.fetch`, so the receiver stays correct on Cloudflare Workers):
 *
 *   const call = compose(withRetry(), withTimeout(5000))()   // -> Fetcher
 *
 * Need a layering that fights the hints? A Plugin is just `(next) => Fetcher`, so
 * nest them by hand — `a(b(c(base)))` — and skip the sort entirely.
 */
export function compose(...plugins: Plugin[]): (base?: Fetcher) => Fetcher {
  // `plugins` is a fresh rest array, so the in-place sort touches nothing shared.
  // Stable sort keeps equal/untagged plugins in insertion order; reduceRight then
  // puts the lowest-order plugin outermost (wrapping all the rest).
  plugins.sort(byOrder);
  return (base) => plugins.reduceRight<Fetcher>((next, plugin) => plugin(next), base ?? resolveFetch());
}
