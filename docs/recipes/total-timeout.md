# Per-attempt + total timeouts

[`withTimeout`](/plugins/timeout) is per-attempt, and a per-request
`signal: AbortSignal.timeout(ms)` is the usual way to add a total budget on top.

To make that total budget a client-level default instead of something you pass on
every call, add a second `withTimeout` re-tagged to sit outside retry.

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

The outer timeout runs per call, so every request gets a fresh 20s clock.

::: details Why the outer one needs re-tagging
Both timeouts default to `ORDER.timeout` (400), so two plain `withTimeout(...)` calls
would _both_ land inside retry: two per-attempt deadlines, not a total. `order` re-tags
the outer one to `ORDER.retry - 1` so it sits outside the loop.

| plugin                                        | order | role                    |
| --------------------------------------------- | ----- | ----------------------- |
| `order(ORDER.retry - 1, withTimeout(20_000))` | 299   | total budget, all tries |
| `withRetry(3)`                                | 300   | re-runs failed attempts |
| `withTimeout(5_000)`                          | 400   | per-attempt deadline    |

Lower `order` sits further out (see [core concepts](/guide/concepts#order-and-order)).
`order` only sets the plugin's `order` and returns it, so re-tagging a built plugin is
safe: each `withTimeout()` call is a fresh instance.
:::

::: details What fires when

- An attempt exceeds 5s: `TimeoutError`, and retry tries again if the 20s total
  isn't spent.
- The 20s total elapses: the outer timeout aborts the in-flight attempt and the
  retry loop stops, even mid-backoff.
- A caller's own `signal` still works and its reason is preserved, so a user-cancel
  stays an `AbortError` and a timeout stays a `TimeoutError`.

:::

## Tightening a single call

The global budgets are defaults, so a per-request `signal` can still make one call
stricter. It only tightens, it never extends past the outer plugin's 20s.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
await api.get('/report', { signal: AbortSignal.timeout(3_000) }); // this call: 3s max
```

## See also

- [timeout](/plugins/timeout) for the plugin and per-attempt vs total budgets.
- [A resilient client](/recipes/resilient-corgi) for retry plus a per-attempt timeout.
- [Composition engine](/api/composition) for `order`, `ORDER`, and the slots.
