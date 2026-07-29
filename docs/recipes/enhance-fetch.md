# Enhance native `fetch`

Plugins are `fetch`-shaped middleware, so you can compose a few into a drop-in
`fetch` without adopting the client. Same call signature, same raw `Response`.

## Usage

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

// Same signature as fetch, returns a raw Response:
const fetchX = compose(withRetry(3), withTimeout(5000))();

const res = await fetchX('https://api.example.com/data');
if (res.ok) {
  const data = await res.json();
}
```

`compose(...)()` with no base uses a bind-safe global `fetch`, which matters on
Cloudflare Workers where a detached `fetch` throws. To wrap a specific fetch (a
polyfill, a mock, an instrumented one) pass it as the base.

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
declare const undiciFetch: typeof fetch;
// ---cut---
const fetchX = compose(withRetry(3))(undiciFetch);
```

## What you get

Retry, timeout, cancel-previous, and any middleware you write. Plugins are pure
`Response → Response`, so there's no JSON parsing and no throw-on-non-2xx. You
handle the `Response` yourself; that part is the [client's](/guide/corgi) job.

## Ordering is handled for you

`compose` sorts plugins by their `ORDER` hint, just like `corgi`, which is built on
it. Array order doesn't matter, so retry always ends up outside timeout: each attempt
gets a fresh deadline, and a fired timeout is retried.

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
// Both compose to the SAME pipeline: retry OUTSIDE timeout.
const a = compose(withRetry(3), withTimeout(5000))();
const b = compose(withTimeout(5000), withRetry(3))();
```

Want one deadline across all attempts instead of per-attempt? Don't reorder, pass
`signal: AbortSignal.timeout(ms)` on the call.

<small class="read-more">[Read more: per-attempt vs total budget →](/plugins/timeout#per-attempt-vs-total-budget)</small>

::: details Deliberately fighting the hints
A plugin is just `(next) => Fetcher`, so nest them by hand to bypass the sort.

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
// timeout OUTSIDE retry; each compose()() gives a bind-safe base.
const totalDeadline = compose(withTimeout(5000))(compose(withRetry(3))());
```

:::
