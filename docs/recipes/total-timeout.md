# Per-attempt + total timeouts

`withTimeout` is a **per-attempt** deadline. A **total** budget across all retries is
usually a per-request `signal: AbortSignal.timeout(ms)` (see
[A resilient client](/recipes/resilient-corgi)). But if you want the _same_ total
budget on **every** call — a client-level default, not something you remember to pass
each time — make the total a plugin too, by placing a second `withTimeout` **outside**
retry.

## Two deadlines, one client

```ts twoslash
import { corgi, order, ORDER } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

const api = corgi.create({
  baseURL: 'https://api.example.com',
  plugins: [
    order(ORDER.retry - 1, withTimeout(20_000)), // TOTAL: wraps the whole retry loop
    withRetry(3),
    withTimeout(5_000), // PER-ATTEMPT: fresh 5s deadline each try (ORDER.timeout)
  ],
});

await api.get('/report'); // each try ≤ 5s; the whole thing ≤ 20s
```

## How the layers stack

`corgi` order-sorts plugins, and **lower `order` sits further out** (see
[core concepts](/guide/concepts#order-and-order)):

| plugin                                        | order | role                    |
| --------------------------------------------- | ----- | ----------------------- |
| `order(ORDER.retry - 1, withTimeout(20_000))` | 299   | total budget, all tries |
| `withRetry(3)`                                | 300   | re-runs failed attempts |
| `withTimeout(5_000)`                          | 400   | per-attempt deadline    |

The outer timeout wraps the entire retry loop in one deadline; the inner one gives
each attempt its own. Whichever fires first wins.

## Why re-tag the outer one

Both timeouts default to `ORDER.timeout` (400), so two plain `withTimeout(...)` would
_both_ land inside retry — two per-attempt deadlines, not a total. `order` re-tags the
outer one to `ORDER.retry - 1` so it sits **outside** the loop. Both `order` and
`ORDER` are exported from `@itsy/corgi`:

```ts twoslash
import { order, ORDER } from '@itsy/corgi';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
const totalBudget = order(ORDER.retry - 1, withTimeout(20_000));
```

`order` just sets the plugin's `order` and returns it, so re-tagging a built plugin is
safe — each `withTimeout()` call is a fresh instance.

## What fires when

- An attempt exceeds **5s** → `TimeoutError` → retry tries again (if the 20s total
  isn't spent).
- The **20s total** elapses → the outer timeout aborts the in-flight attempt **and**
  the retry loop stops (it sees the aborted signal), even mid-backoff.
- A caller's own `signal` still works and its reason is preserved — a user-cancel stays
  an `AbortError`, a timeout a `TimeoutError`.

The outer timeout runs **per call**, so every request gets a _fresh_ 20s clock — you're
not sharing one `AbortSignal.timeout` across calls (which would abort every later
request once the first fires).

## Tightening a single call

The global budgets are defaults; a per-request `signal` can still make one call
_stricter_ (whichever deadline fires first wins):

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
await api.get('/report', { signal: AbortSignal.timeout(3_000) }); // this call: 3s max
```

A per-request `signal` can only tighten, never extend past the outer plugin's 20s.

## See also

- [A resilient client](/recipes/resilient-corgi) — retry + per-attempt timeout, `Retry-After`.
- [timeout](/plugins/timeout) — the plugin and its two implementations.
- [Composition engine](/api/composition) — `order`, `ORDER`, and the slots.
