# @itsy/corgi

Tiny composable typed `fetch` — one-off or client; cancel-previous, retry,
timeout, and schema-validated transforms as opt-in middleware. **~1.4 KB gzipped,
zero dependencies, ESM, isomorphic.**

> Full docs: **https://itsyjs.github.io/corgi/**

```sh
npm i @itsy/corgi
```

```ts
import { corgi } from '@itsy/corgi';

// GET + JSON parse + throw-on-non-2xx, typed:
const user = await corgi.get<User>('https://api.example.com/users/1');

// Configured Corgi with shared defaults:
import { corgi } from '@itsy/corgi';
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

| import                       | what                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `@itsy/corgi`                | `corgi`, `corgi`, `compose`/`order`/`ORDER`, `HttpError` + guards                         |
| `@itsy/corgi/timeout`        | `withTimeout` — hand-rolled, 2022-safe                                                    |
| `@itsy/corgi/timeout-modern` | `withTimeout` — `AbortSignal.any`, Baseline 2024, smaller                                 |
| `@itsy/corgi/retry`          | `withRetry`                                                                               |
| `@itsy/corgi/abort-previous` | `abortPrevious` (search-as-you-type)                                                      |
| `@itsy/corgi/schema`         | `schema`, `parseWith` — Standard Schema validation                                        |
| `@itsy/corgi/chonk`          | batteries-included: `corgi` with `retry`/`timeout`/`abortPrevious` as first-class options |

```ts
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { abortPrevious } from '@itsy/corgi/abort-previous';
import { withTimeout } from '@itsy/corgi/timeout';

const search = corgi.create({ plugins: [abortPrevious(), withRetry(2), withTimeout(5000)] });
```

Runs on Node 18.17+, Deno, Bun, Cloudflare Workers, and evergreen browsers.

## License

MIT © Dave Honneffer
