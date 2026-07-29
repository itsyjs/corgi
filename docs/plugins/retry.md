# retry

`withRetry` re-runs idempotent requests with replayable bodies on transient statuses
and network/timeout errors. Backoff is exponential with full jitter, and `Retry-After`
is honoured.

A caller-cancelled request is never retried, and the backoff wait is itself abortable.

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';

// number shorthand === { retries: 3 }
const api = corgi.create({ plugins: [withRetry(3)] });
await api.get('/flaky');
```

Works with a client (above), [`/chonk`'s `retry` option](/guide/chonk), or standalone
around native `fetch`. See the [Plugins overview](/plugins/).

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

- Methods: only the idempotent set by default. `POST`/`PATCH` are excluded, since
  replaying them can double-create or double-charge. Override with `methods`.
- Bodies: only replayable ones (string, `URLSearchParams`, `Blob`, `FormData`,
  `ArrayBuffer`, typed arrays). A `ReadableStream` body is consumed by the first
  attempt, so such a request is never retried.
- Responses: retried on `statuses` (408/429/500/502/503/504 by default).
- Errors: a per-attempt `TimeoutError`, and genuine network `TypeError`s
  (DNS/reset/offline). Never a caller `AbortError`, and never a programmer-error
  `TypeError` such as "is not a function".
- `Retry-After`: when the server sends it (seconds or an HTTP-date) it's used instead
  of computed backoff, capped at `maxDelay`.

## Ordering with timeout

`withRetry` is tagged `ORDER.retry` (300), which sits outside `withTimeout` (400), so
each attempt gets a fresh deadline and a fired timeout is retried.

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
// order in the array doesn't matter — corgi sorts by ORDER:
const api = corgi.create({ plugins: [withTimeout(5000), withRetry(3)] });
```

<small class="read-more">[Read more: per-attempt vs total budget →](/plugins/timeout#per-attempt-vs-total-budget)</small>
