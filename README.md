# @itsy/corgi

Tiny composable typed `fetch` — one-off or client; cancel-previous, retry,
timeout, and schema-validated transforms as opt-in middleware. **~1.4 KB gzipped
core, zero dependencies, ESM, isomorphic.**

> Full guides: **https://itsyjs.github.io/corgi/** — but the shipped `.d.ts` are
> heavily documented, so your editor (and coding agents) can work offline. Agents:
> see [`AGENTS.md`](./AGENTS.md).

```sh
npm i @itsy/corgi
```

```ts
import { corgi } from '@itsy/corgi';

// GET + JSON parse + throw-on-non-2xx, typed:
const user = await corgi.get<User>('https://api.example.com/users/1');

// Configured client with shared defaults:
const api = corgi.create({ baseURL: 'https://api.example.com', headers: { authorization: 'Bearer t' } });
await api.post('/users', { body: { name: 'Ada' } }); // plain object -> JSON
```

## Why

Native `fetch` resolves on 404/500, drops the base path in `new URL`, throws on
empty-body JSON, and duplicates case-varied headers. `@itsy/corgi` fixes those once
and gets out of the way — see [Why this size?](https://itsyjs.github.io/corgi/guide/library-size).

- **Throws a typed `HttpError`** on non-2xx (opt out with `throwOnError: false` or `.raw()`).
- **Composable middleware** from two shapes (`Fetcher`, `Plugin`) with predictable ordering.
- **Typed results** — `<T>`, `responseType` mapping, and a `transform` hook (powers `schema`).
- **Pay for what you import** — Corgi is core; everything else is a subpath.

## Entry points

| import                       | exports                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `@itsy/corgi`                | `corgi` (+ `corgi.create`), `compose`/`order`/`ORDER`, `HttpError`, `isHttpError`/`isTimeoutError`/`isAbortError` |
| `@itsy/corgi/retry`          | `withRetry`                                                                                                       |
| `@itsy/corgi/timeout`        | `withTimeout` — hand-rolled, 2022-safe                                                                            |
| `@itsy/corgi/timeout-modern` | `withTimeout` — builtin-based, ~60% smaller, Baseline-2024                                                        |
| `@itsy/corgi/abort-previous` | `abortPrevious` (search-as-you-type)                                                                              |
| `@itsy/corgi/schema`         | `schema`, `parseWith`, `ValidationError`, `isValidationError` — Standard Schema                                   |
| `@itsy/corgi/chonk`          | batteries-included: `corgi` with `retry`/`timeout`/`abortPrevious` as first-class options                         |

```ts
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { abortPrevious } from '@itsy/corgi/abort-previous';
import { withTimeout } from '@itsy/corgi/timeout';

const search = corgi.create({ plugins: [abortPrevious(), withRetry(2), withTimeout(5000)] });
```

## Requests

```ts
const api = corgi.create({ baseURL: 'https://api.example.com/v1' });

await api.get('/search', { query: { q: 'ada', tag: ['a', 'b'], draft: null } });
// -> /v1/search?q=ada&tag=a&tag=b   (arrays repeat; null/undefined & empty arrays omitted)

await api.post('/users', { body: { name: 'Ada' } }); // object -> JSON + content-type
await api.post('/upload', { body: formData }); // FormData/Blob/stream/etc. pass through

await api.get('/x', { responseType: 'blob' }); // -> Promise<Blob> (typed)
```

- **`baseURL`** is _prefix-joined_, so the base path is kept (`new URL('/x', base)` would drop it).
  An absolute or protocol-relative url bypasses it.
- **`query`**: arrays -> repeated keys; `null`/`undefined` values (and nullish items) are omitted
  (not `key=`, not a bare flag); an empty array omits the key; encoded via `URLSearchParams`.
- **`body`**: plain object/array -> JSON (+ `content-type: application/json`); every real `BodyInit`
  passes through untouched; a `ReadableStream` body gets `duplex: 'half'` automatically.
- **`headers`** merge case-insensitively (no `Content-Type`/`content-type` duplication). Precedence
  low -> high: auto JSON content-type < client defaults < per-call.

## Responses & errors

```ts
import { corgi, isHttpError, isTimeoutError, isAbortError } from '@itsy/corgi';

try {
  const user = await corgi.get<User>('/users/1');
} catch (err) {
  if (isHttpError(err)) {
    err.status;
    err.statusText;
    err.url;
    err.data; // data = best-effort parsed error body
    const body = await err.response.json(); // response body is still readable
  } else if (isTimeoutError(err)) {
    // a deadline fired (withTimeout, or AbortSignal.timeout)
  } else if (isAbortError(err)) {
    // caller cancelled (or a superseding abortPrevious call)
  } else throw err;
}

await api.get('/maybe', { throwOnError: false }); // non-2xx resolves to the parsed body (typed as <T> — narrow it)
const res = await api.raw('/download'); // raw Response: no parse, no throw
```

- Non-2xx **throws `HttpError`** by default (the opposite of native `fetch`). `err.response` is
  unread and re-readable; guards are **name-based**, so they survive iframes/workers/duplicate bundles.
- Parsing sniffs `content-type`: `application/json` and `+json` suffixes (e.g. `application/problem+json`)
  -> JSON; `text/*` and unknown types -> text (never guessed as JSON); everything else -> `Blob`;
  204/205/304 and HEAD -> `undefined`. Forcing `responseType: 'json'` on non-JSON throws `SyntaxError`.
- Runtime validation: `schema()` (below) throws `ValidationError` with `.issues`.

## Plugins

Plugins are client-level (`plugins: [...]`), built into the pipeline once and reused. `corgi`
order-sorts them by an `order` hint, so array order doesn't matter (see `ORDER`).

### Retry — `@itsy/corgi/retry`

```ts
import { withRetry } from '@itsy/corgi/retry';
const api = corgi.create({ plugins: [withRetry(3)] }); // 3 retries (4 tries total)
corgi.create({ plugins: [withRetry({ retries: 3, backoff: 300, maxDelay: 10_000, onRetry: console.log })] });
```

Defaults: `retries: 2`, `backoff: 300`, `maxDelay: 10_000`, statuses `408/429/500/502/503/504`,
methods `GET HEAD PUT DELETE OPTIONS TRACE` (POST/PATCH excluded). Exponential backoff with full
jitter; honors `Retry-After` (capped at `maxDelay`). Retries transient statuses, per-attempt
`TimeoutError`, and network `TypeError`; never a caller `AbortError`. **A `ReadableStream` body is
not replayable, so such a request is never retried.**

### Timeout — `@itsy/corgi/timeout` vs `@itsy/corgi/timeout-modern`

Both export `withTimeout(ms)`, are drop-in identical (same `ORDER` slot, `ms` semantics — `0`/`Infinity`
disable — and `"TimeoutError"` name), and are **per-attempt**. They differ only in implementation:

|               | `@itsy/corgi/timeout`                        | `@itsy/corgi/timeout-modern`                                                             |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| mechanism     | hand-rolled `setTimeout` + `AbortController` | `AbortSignal.timeout()` + `AbortSignal.any()`                                            |
| runtime floor | **2022-safe** (any target)                   | **Baseline-2024**: Node 18.17+, Chrome 116+, FF 124+, Safari 17.4+, Deno 1.39+, Bun 1.1+ |
| size          | larger                                       | ~60% smaller                                                                             |
| timers        | guaranteed `clearTimeout` cleanup            | native timer lingers (unref'd) until it fires                                            |

Default to `@itsy/corgi/timeout`. Choose `-modern` for the smaller bundle when your runtimes are
Baseline-2024+. (`/chonk`'s `timeout` option uses the hand-rolled one.)

```ts
import { withTimeout } from '@itsy/corgi/timeout';
const api = corgi.create({ plugins: [withRetry(2), withTimeout(5000)] }); // 5s PER attempt
await api.get('/report', { signal: AbortSignal.timeout(20_000) }); // 20s TOTAL across retries
```

### Cancel previous — `@itsy/corgi/abort-previous`

```ts
import { abortPrevious } from '@itsy/corgi/abort-previous';
const search = corgi.create({ plugins: [abortPrevious()] });
// each new call aborts the last; the superseded one rejects with AbortError (isAbortError -> ignore)
```

Stateful: keep it at the client level (one instance == one search box). **On a server, create the
client per request** — a module-scoped one would cancel unrelated users' requests.

### Schema validation — `@itsy/corgi/schema`

```ts
import { z } from 'zod'; // or Valibot / ArkType — any Standard Schema validator
import { schema, parseWith, isValidationError } from '@itsy/corgi/schema';

const User = z.object({ id: z.number(), name: z.string() });
const user = await api.get('/users/1', { transform: schema(User) }); // typed + runtime-validated
const also = await parseWith(User, api.get('/users/1')); // .then() style, zero client bytes
```

`schema` is a `transform`, not a client option (validation is per-call) — this holds in `/chonk` too.

### Chonk — `@itsy/corgi/chonk`

```ts
import { corgi } from '@itsy/corgi/chonk';
const api = corgi.create({ baseURL: '…', retry: 3, timeout: 5000, abortPrevious: true });
```

Batteries-included: the plugins become first-class options. Larger bundle (~2.5 KB); for browser/edge
import from `@itsy/corgi` and add only the plugin subpaths you need.

## Writing a plugin

A plugin is middleware around `fetch`: `(next) => (url, init) => Promise<Response>`. It receives the
final url (query already merged) and a `RequestInit` (body already serialized).

```ts
import { order, ORDER, type Plugin } from '@itsy/corgi';

// Auth applied once per logical call (order just OUTSIDE retry, so it isn't re-run per attempt):
const withAuth = (token: string) =>
  order(ORDER.retry - 1, (next) => (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return next(url, { ...init, headers });
  });
```

Rules: always resolve to a `Response`; don't consume the body of a `Response` you return (clone to
inspect, `res.body?.cancel()` on ones you discard); treat `init` as immutable and forward the caller's
`signal`. `ORDER` slots: `cancel` 100 (outermost) · `dedupe` 200 · `retry` 300 · `timeout` 400
(innermost); untagged plugins sort at 250.

## Runtime support

Core + most subpaths run on **Node 18.17+, Deno, Bun, Cloudflare Workers, and evergreen browsers**
(web-standard globals only). Exception: `@itsy/corgi/timeout-modern` needs a **Baseline-2024** runtime
for `AbortSignal.any` (see the timeout table) — use `@itsy/corgi/timeout` on older targets.

## Bundle size (gzipped, approx.)

| import                            | size     |
| --------------------------------- | -------- |
| `@itsy/corgi` — `{ corgi }`       | ~1.45 KB |
| `@itsy/corgi/retry`               | ~0.94 KB |
| `@itsy/corgi/abort-previous`      | ~0.30 KB |
| `@itsy/corgi/timeout`             | ~0.33 KB |
| `@itsy/corgi/timeout-modern`      | ~0.22 KB |
| `@itsy/corgi/schema`              | ~0.19 KB |
| `@itsy/corgi/chonk` — `{ corgi }` | ~2.5 KB  |

## License

MIT © Dave Honneffer
