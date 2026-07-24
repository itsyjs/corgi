# retry

`withRetry` retries **idempotent** requests with **replayable** bodies on transient
statuses and network/timeout errors — using exponential backoff with full jitter,
honouring `Retry-After`. It never retries a caller-cancelled request, and its
backoff wait is itself abortable.

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';

// number shorthand === { retries: 3 }
const api = corgi.create({ plugins: [withRetry(3)] });
await api.get('/flaky');
```

Works with any of the three [plugin usage modes](/plugins/) — a client (above),
[`/chonk`'s `retry` option](/guide/chonk), or standalone around native `fetch`.

## Options

```ts twoslash
import { withRetry } from '@itsy/corgi/retry';
// ---cut---
withRetry({
  retries: 2, //     retries AFTER the first attempt (default 2 -> up to 3 tries)
  backoff: 300, //   base ms; wait for attempt n is random in [0, base * 2**n)
  maxDelay: 10_000, // ceiling per wait, and the cap applied to Retry-After
  methods: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'TRACE'], // idempotent set
  statuses: [408, 429, 500, 502, 503, 504], // transient statuses
  onRetry: ({ attempt, delay, error, response }) => {
    console.log(`retry #${attempt} in ${delay}ms`);
  },
});
```

## What it will and won't retry

- **Methods** — only the idempotent set by default. `POST`/`PATCH` are excluded:
  replaying them can double-create or double-charge. Override with `methods`.
- **Bodies** — only replayable ones (string, `URLSearchParams`, `Blob`,
  `FormData`, `ArrayBuffer`, typed arrays). A `ReadableStream` body is consumed by
  the first attempt, so such a request is never retried.
- **Responses** — retried on `statuses` (408/429/500/502/503/504 by default).
- **Errors** — a per-attempt `TimeoutError`, and genuine network `TypeError`s
  (DNS/reset/offline). Never a caller `AbortError`; never a programmer-error
  `TypeError` (e.g. "is not a function").
- **`Retry-After`** — if the server sends it (seconds or an HTTP-date), it's used
  instead of computed backoff, capped at `maxDelay`.

## Ordering with timeout

`withRetry` is tagged `ORDER.retry` (300), which sits **outside** `withTimeout`
(400). So each attempt gets a fresh per-attempt timeout, and a fired timeout is
retried. For a total budget instead, use a request `signal` — see
[timeout](/plugins/timeout#per-attempt-vs-total-budget).

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
// order in the array doesn't matter — corgi sorts by ORDER:
const api = corgi.create({ plugins: [withTimeout(5000), withRetry(3)] });
```
