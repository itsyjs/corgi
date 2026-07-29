# A resilient client

Retry on transient failures, with a deadline on each attempt.

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

Listing order doesn't matter. `corgi` sorts plugins, so retry (300) always ends up
outside timeout (400).

::: details Why retry sits outside timeout
Because retry wraps timeout, each attempt gets its own fresh 5s deadline and a
timed-out attempt is itself retried. That's almost always what you want, since one
slow attempt shouldn't burn the whole budget.
:::

<small class="read-more">[Read more: per-attempt vs total budget →](/plugins/timeout#per-attempt-vs-total-budget)</small>

## Tuning retry

The defaults cover the common case: idempotent methods only, replayable bodies only,
transient statuses (408/429/500/502/503/504), `Retry-After` honoured, and full-jitter
backoff so many clients don't retry in lockstep.

Observe or tune it with `onRetry`.

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

<small class="read-more">[Read more: every retry option →](/plugins/retry)</small>

## Cancel-previous for interactive clients

If this client backs a UI that fires overlapping requests (search, filters), add
[`abortPrevious`](/plugins/abort-previous). It takes the outermost slot, so a new
call cancels the entire prior chain, retries included.

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
