# AGENTS.md — `@itsy/corgi` for coding agents

Composable typed `fetch`. One-off (`corgi`) or configured client (`corgi.create`),
with retry / timeout / cancel-previous / schema as opt-in middleware. ESM-only,
zero deps, isomorphic. Every export is documented in its `.d.ts` — hover/read those
for exact types. This file is the task-oriented map.

## Import map (symbols live on subpaths — the root does NOT re-export plugins)

| import path                  | exports                                                                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@itsy/corgi`                | `corgi` (+ `corgi.create`), `compose`, `order`, `ORDER`, `HttpError`, `isHttpError`, `isTimeoutError`, `isAbortError`; types `Corgi`, `CorgiAPI`, `Call`, `CorgiOptions`, `RequestOptions`, `MappedResponse`, `ParseAs`, `Query`, `QueryValue`, `Fetcher`, `Plugin` |
| `@itsy/corgi/retry`          | `withRetry`, type `RetryOptions`                                                                                                                                                                                                                                    |
| `@itsy/corgi/timeout`        | `withTimeout` (hand-rolled, 2022-safe)                                                                                                                                                                                                                              |
| `@itsy/corgi/timeout-modern` | `withTimeout` (builtin-based, smaller, Baseline-2024)                                                                                                                                                                                                               |
| `@itsy/corgi/abort-previous` | `abortPrevious`                                                                                                                                                                                                                                                     |
| `@itsy/corgi/schema`         | `schema`, `parseWith`, `ValidationError`, `isValidationError`, type `StandardSchemaV1`                                                                                                                                                                              |
| `@itsy/corgi/chonk`          | `corgi` with `retry`/`timeout`/`abortPrevious` as options; re-exports everything above (incl. `withTimeoutModern`)                                                                                                                                                  |

## Core usage

```ts
import { corgi } from '@itsy/corgi';

const user = await corgi.get<User>('https://api.example.com/users/1'); // typed, throws on non-2xx
const api = corgi.create({ baseURL: 'https://api.example.com', headers: { authorization: 'Bearer t' } });
await api.post('/users', { body: { name: 'Ada' } }); // object -> JSON
await api.get('/x', { query: { tag: ['a', 'b'] }, responseType: 'blob' });
const raw = await api.raw('/x'); // raw Response, no parse/throw
const scoped = api.extend({ headers: { 'x-tenant': 'acme' } }); // headers merge, plugins concat
```

`RequestOptions` (per-call): `method` `headers` `body` `query` `baseURL` `responseType`
`throwOnError` `transform` + any `RequestInit` field (incl. `signal`).
`CorgiOptions` (client-level, on `create`/`extend`): `baseURL` `headers` `throwOnError`
`plugins` `fetch` + `credentials`/`mode`/`cache`/`redirect`/`referrer`/`referrerPolicy`.
Return-type priority: `transform` > `responseType` > `<T>` (defaults `unknown`).

## Common mistakes (READ THIS)

1. **Plugins are client-level, not per-call.** Use `corgi.create({ plugins: [...] })`.
   `corgi(url, options)` is a request call — passing `{ plugins }` to it is WRONG.
2. **No per-call `timeout` field.** Per-attempt deadline = `withTimeout` plugin (client-level).
   Total budget = `signal: AbortSignal.timeout(ms)` (per-call; spans retries and stops the loop).
3. **Non-2xx throws `HttpError`** by default (unlike native `fetch`). Don't check `res.ok`; catch,
   or pass `throwOnError: false`, or use `.raw()`.
4. **`throwOnError: false` returns the parsed body typed as `<T>`** even on errors — narrow it.
5. **204/205/304 and HEAD resolve to `undefined`** regardless of `<T>`. `head()` is typed `Promise<undefined>`.
6. **Retry skips non-replayable bodies:** a `ReadableStream` body is never retried, even on GET.
7. **`abortPrevious` is stateful** — one client instance per logical stream; on servers build the
   client per request, never module-scope it.
8. **Two `withTimeout` exports** — pick `@itsy/corgi/timeout` unless you know your runtime is Baseline-2024.
9. **`schema` is a `transform`, not a client/`chonk` option.**
10. **`query` drops `null`/`undefined`** (not `key=`, not a bare flag); empty arrays are dropped.

## Recipes

### Retry + per-attempt timeout (resilient client)

```ts
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

const api = corgi.create({ baseURL, plugins: [withRetry(3), withTimeout(5000)] });
await api.get('/report', { signal: AbortSignal.timeout(20_000) }); // + total budget
```

### Search-as-you-type (cancel stale)

```ts
import { corgi, isAbortError } from '@itsy/corgi';
import { abortPrevious } from '@itsy/corgi/abort-previous';

const search = corgi.create({ baseURL, plugins: [abortPrevious()] });
async function run(q: string) {
  try {
    return await search.get<Hit[]>('/search', { query: { q } });
  } catch (e) {
    if (isAbortError(e)) return;
    throw e;
  } // superseded -> expected
}
```

### Auth token + refresh-on-401 (custom plugin)

```ts
import { order, ORDER, type Plugin } from '@itsy/corgi';

const withAuth = (getToken: () => string): Plugin =>
  order(ORDER.retry - 1, (next) => (url, init) => {
    // outside retry: applied once per call
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${getToken()}`);
    return next(url, { ...init, headers });
  });

const withRefresh = (refresh: () => Promise<void>): Plugin =>
  order(ORDER.retry - 1, (next) => async (url, init) => {
    let res = await next(url, init);
    if (res.status === 401) {
      res.body?.cancel().catch(() => {}); // release the 401 body
      await refresh();
      res = await next(url, init); // replay once
    }
    return res;
  });
```

### Total timeout as a client default (re-tag to sit outside retry)

```ts
import { order, ORDER } from '@itsy/corgi';
import { withTimeout } from '@itsy/corgi/timeout';
import { withRetry } from '@itsy/corgi/retry';

corgi.create({
  plugins: [
    order(ORDER.retry - 1, withTimeout(20_000)), // TOTAL: wraps the whole retry loop
    withRetry(3),
    withTimeout(5_000), // PER-ATTEMPT
  ],
});
```

### Schema validation

```ts
import { z } from 'zod';
import { schema, isValidationError } from '@itsy/corgi/schema';

const User = z.object({ id: z.number(), name: z.string() });
try {
  const u = await api.get('/users/1', { transform: schema(User) });
} catch (e) {
  if (isValidationError(e)) console.error(e.issues);
  else throw e;
}
```

### Error handling

```ts
import { isHttpError, isTimeoutError, isAbortError } from '@itsy/corgi';
try {
  await api.get('/x');
} catch (e) {
  if (isHttpError(e)) {
    e.status;
    e.data;
    await e.response.text();
  } else if (isTimeoutError(e)) {
    /* deadline */
  } else if (isAbortError(e)) {
    /* cancelled / superseded */
  } else throw e;
}
```

### Enhance native fetch (no client)

```ts
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

const fetchX = compose(withRetry(3), withTimeout(5000))(); // omit base -> bind-safe global fetch
const res = await fetchX('https://api.example.com/data'); // raw Response (no parse/throw)
```

## Custom plugin contract

`Plugin = (next: Fetcher) => (url: string, init?: RequestInit) => Promise<Response>`, optional `.order`.

- Always resolve to a `Response`; call `next(url, init)` or short-circuit with your own `Response`.
- Don't consume the body of a `Response` you return (clone to inspect); `res.body?.cancel()` discards.
- `init` is immutable: `next(url, { ...init, headers })`; forward the caller's `signal`.
- `ORDER`: `cancel` 100 (outermost) · `dedupe` 200 · `retry` 300 · `timeout` 400 (innermost);
  untagged = 250. Lower = further out (sees request first, response last). `compose` sorts by it.

## Error taxonomy (name-based guards)

- `HttpError` — non-2xx. Fields: `status`, `statusText`, `url`, `response` (readable), `data` (parsed body).
- `"TimeoutError"` — a deadline fired (`withTimeout` or `AbortSignal.timeout`). `isTimeoutError`.
- `"AbortError"` — caller cancel or `abortPrevious` supersede. `isAbortError`.
- `ValidationError` — schema failure; `.issues`. `isValidationError`.

## Runtime support

Node 18.17+, Deno, Bun, Cloudflare Workers, evergreen browsers. Only exception:
`@itsy/corgi/timeout-modern` needs Baseline-2024 (`AbortSignal.any`: Node 18.17+, Chrome 116+,
Firefox 124+, Safari 17.4+, Deno 1.39+, Bun 1.1+); use `@itsy/corgi/timeout` on older runtimes.
