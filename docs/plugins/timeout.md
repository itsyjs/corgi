# timeout

`withTimeout(ms)` gives every attempt its own deadline.

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withTimeout } from '@itsy/corgi/timeout';

const api = corgi.create({ plugins: [withTimeout(5000)] });
await api.get('/slow'); // rejects with a TimeoutError after 5s
```

Like any plugin it also works via [`/chonk`'s options](/guide/chonk) and
[around native `fetch`](/plugins/#use-with-native-fetch).

## Picking an implementation

It ships twice. Both expose the same `withTimeout(ms)`, the same ordering slot, and
the same `"TimeoutError"` name, so you can swap the import freely.

| import                       | how                                           | runtime floor           | size         |
| ---------------------------- | --------------------------------------------- | ----------------------- | ------------ |
| `@itsy/corgi/timeout`        | hand-rolled `setTimeout` + `AbortController`  | 2022-safe (all targets) | larger       |
| `@itsy/corgi/timeout-modern` | `AbortSignal.timeout()` + `AbortSignal.any()` | Baseline 2024           | ~60% smaller |

```ts twoslash
import { withTimeout } from '@itsy/corgi/timeout-modern';
```

::: details Which one do I want?
Targeting evergreen browsers, Node 18.17+, Deno, Bun, or Workers, and want the
smallest bundle? Use `@itsy/corgi/timeout-modern`.

Supporting older browsers (pre-2024 Safari/Firefox), or want guaranteed timer
cleanup under very high load? Use `@itsy/corgi/timeout`.
:::

## Behaviour

- Tagged `ORDER.timeout` (innermost). With [`retry`](/plugins/retry), each attempt
  gets a fresh deadline and a fired timeout is retried.
- A caller's own `signal` is forwarded with its abort reason preserved, so a
  user-cancel stays an `AbortError` while a timeout stays a `TimeoutError`.
- `ms` of `0` or `Infinity` means no timeout; the request is forwarded untouched.
- Detect it with [`isTimeoutError`](/api/errors#istimeouterror).

## Per-attempt vs total budget

`withTimeout` is per-attempt. For a single total budget across all retries, pass an
`AbortSignal.timeout` as the request `signal` instead. When it fires, the retry loop
sees the aborted signal and stops.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
await api.get('/report', { signal: AbortSignal.timeout(30_000) });
```

Use both together to cap each attempt *and* the whole call. Whichever fires first wins.

::: tip The same budget on every call
A per-request `signal` is something you have to remember to pass. To make the total
budget a client-level default instead, see
[Per-attempt + total timeouts](/recipes/total-timeout).
:::
