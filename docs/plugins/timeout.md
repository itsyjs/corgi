# timeout

A per-attempt deadline plugin. It ships in **two interchangeable
implementations** — pick one based on your runtime floor and byte budget.

| import                       | how                                           | runtime floor               | size         |
| ---------------------------- | --------------------------------------------- | --------------------------- | ------------ |
| `@itsy/corgi/timeout`        | hand-rolled `setTimeout` + `AbortController`  | **2022-safe** (all targets) | larger       |
| `@itsy/corgi/timeout-modern` | `AbortSignal.timeout()` + `AbortSignal.any()` | **Baseline 2024**           | ~60% smaller |

Both expose the same `withTimeout(ms)` with identical behaviour (same ordering
slot, same `"TimeoutError"` name), so you can swap the import freely.

## Usage

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withTimeout } from '@itsy/corgi/timeout';

const api = corgi.create({ plugins: [withTimeout(5000)] });
await api.get('/slow'); // rejects with a TimeoutError after 5s
```

Like any plugin, it also works via [`/chonk`'s options](/guide/chonk) and
[standalone around native `fetch`](/plugins/#_3-around-native-fetch-no-client) —
see the [Plugins overview](/plugins/) for all three.

Swap to the smaller version on modern runtimes — nothing else changes:

```ts twoslash
import { withTimeout } from '@itsy/corgi/timeout-modern';
```

## Behaviour

- Tagged `ORDER.timeout` (innermost). Combined with [`retry`](/plugins/retry),
  **each attempt gets its own fresh deadline**, and a fired timeout is retried.
- A caller's own `signal` is forwarded (its abort reason is preserved), so a
  user-cancel stays an `AbortError` while a timeout is a `TimeoutError`.
- `ms` of `0` or `Infinity` means "no timeout" — the request is forwarded
  untouched.
- Detect it with [`isTimeoutError`](/api/errors).

## Per-attempt vs total budget

`withTimeout` is a **per-attempt** deadline. For a single **total** budget across
all retries, don't use it — pass an `AbortSignal.timeout` as the request `signal`
instead. When it fires, the retry loop sees the aborted signal and stops:

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
await api.get('/report', { signal: AbortSignal.timeout(30_000) });
```

::: tip A global total budget
Want each attempt capped **and** one deadline across all retries — on every call, not
passed per-request? See [Per-attempt + total timeouts](/recipes/total-timeout).
:::

## Which should I use?

- Building for **evergreen browsers / Node 18.17+ / Deno / Bun / Workers** and want
  the smallest bundle? Use `@itsy/corgi/timeout-modern`.
- Need to support **older browsers** (pre-2024 Safari/Firefox) or want guaranteed
  timer cleanup under very high load? Use `@itsy/corgi/timeout`.

Both are opt-in: importing the module is the only way its bytes enter your bundle.
