# Enhance native `fetch`

You don't need the client to use plugins. Because a plugin is just `fetch`-shaped
middleware, you can compose a few into a **drop-in `fetch`** — same call signature,
same raw `Response`, just with retry/timeout/etc. layered on.

## The basic move

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

// Same signature as fetch — returns a raw Response:
const fetchX = compose(withRetry(3), withTimeout(5000))();

const res = await fetchX('https://api.example.com/data');
if (res.ok) {
  const data = await res.json();
}
```

`compose(...)()` with no base uses a **bind-safe** global `fetch` (safe on
Cloudflare Workers, where a detached `fetch` throws). To wrap a _specific_ fetch —
a polyfill, a mock, an instrumented one — pass it as the base:

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
declare const undiciFetch: typeof fetch;
// ---cut---
const fetchX = compose(withRetry(3))(undiciFetch);
```

## What you get (and don't)

Plugins are pure `Response → Response`:

- ✅ retry, timeout, cancel-previous, your own middleware
- ❌ **no** JSON parsing, **no** throw-on-non-2xx — you handle the `Response`
  yourself (that's the [client's](/guide/corgi) job)

If you find yourself re-implementing "parse + throw on error", that's the signal to
switch to `corgi` — you can pass the exact same plugins to it.

## Ordering is handled for you

`compose` sorts plugins by their `ORDER` hint (just like `corgi`, which is
built on it), so the array order doesn't matter — retry always ends up **outside**
timeout, giving each attempt a fresh deadline and retrying a fired timeout:

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
// Both compose to the SAME pipeline: retry OUTSIDE timeout.
const a = compose(withRetry(3), withTimeout(5000))();
const b = compose(withTimeout(5000), withRetry(3))();
```

Want one deadline for **all** attempts combined instead of per-attempt? Don't
reorder — pass a total-time signal: `signal: AbortSignal.timeout(5000)`.

Need a layering that deliberately fights the hints? A plugin is just
`(next) => Fetcher`, so nest them by hand to bypass the sort:

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
// timeout OUTSIDE retry — nest by hand; each compose()() gives a bind-safe base.
const totalDeadline = compose(withTimeout(5000))(compose(withRetry(3))());
```
