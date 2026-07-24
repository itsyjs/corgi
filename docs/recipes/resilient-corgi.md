# A resilient client

A production client usually wants: retry transient failures, a deadline per attempt,
and sane behaviour under load. Here's the setup and the decisions behind it.

## The client

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

const api = corgi.create({
  baseURL: 'https://api.example.com',
  plugins: [withRetry({ retries: 3, backoff: 300, maxDelay: 10_000 }), withTimeout(5000)],
});

await api.get('/users');
```

`corgi` order-sorts plugins, so listing order doesn't matter — retry (300)
always ends up **outside** timeout (400).

## Why retry is outside timeout

Because retry wraps timeout, **each attempt gets its own fresh 5s deadline**, and a
timed-out attempt is itself retried. That's almost always what you want: one slow
attempt shouldn't burn the whole budget.

## Per-attempt vs total budget

`withTimeout` is **per attempt**. For a single **total** deadline across all retries,
don't use `withTimeout` — pass an `AbortSignal.timeout` as the request `signal`.
When it fires, the retry loop sees the aborted signal and stops:

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
const api = corgi.create({ plugins: [withRetry(3)] });
// ---cut---
// up to 3 retries, but give up entirely after 20s no matter what:
await api.get('/report', { signal: AbortSignal.timeout(20_000) });
```

You can combine both: `withTimeout(5000)` per attempt **and** a total-budget
`signal` — whichever fires first wins.

## What retry will and won't do

- **Idempotent methods only** by default (GET/HEAD/PUT/DELETE/OPTIONS/TRACE).
  POST/PATCH are excluded — replaying them can double-create or double-charge.
- **Replayable bodies only** — a `ReadableStream` body is consumed by the first
  attempt, so such a request is never retried.
- **Transient statuses** 408/429/500/502/503/504, plus network `TypeError`s and
  per-attempt timeouts.
- **Honours `Retry-After`** (seconds or HTTP-date), capped at `maxDelay`.
- **Full jitter backoff** — waits a random point in `[0, base * 2ⁿ)` so many clients
  don't retry in lockstep (thundering herd).

Observe or tune it with `onRetry`:

```ts twoslash
import { withRetry } from '@itsy/corgi/retry';
// ---cut---
withRetry({
  retries: 3,
  onRetry: ({ attempt, delay, response, error }) => {
    console.warn(`retry #${attempt} in ${delay}ms`, response?.status ?? error);
  },
});
```

See the [retry reference](/plugins/retry) for every option.

## Cancel-previous for interactive clients

If this client backs a UI that fires overlapping requests (search, filters), add
[`abortPrevious`](/plugins/abort-previous) at the front — it's the outermost slot,
so a new call cancels the entire prior chain, retries included:

```ts twoslash
import { corgi } from '@itsy/corgi';
import { abortPrevious } from '@itsy/corgi/abort-previous';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
const api = corgi.create({
  plugins: [abortPrevious(), withRetry(3), withTimeout(5000)],
});
```
