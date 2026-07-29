# Composition engine

The primitives everything else is built from. See [Core concepts](/guide/concepts)
for the narrative.

## `Fetcher`

```ts twoslash
import type { Fetcher } from '@itsy/corgi';
```

A `fetch`-shaped function — the unit every plugin enhances.

## `Plugin`

```ts twoslash
import type { Plugin } from '@itsy/corgi';
```

Middleware for `Fetcher`s, shaped `(next) => (url, init) => …`, with an optional
`order` hint that `corgi` uses to sort plugins.

## `compose`

```ts
function compose(...plugins: Plugin[]): (base?: Fetcher) => Fetcher;
```

Sorts plugins by their `order` hint, then folds them outermost-first (lower `order`
= further out). The sort is stable, so plugins that share a hint, or have none, keep
the order you passed: `compose(a, b, c)(base) === a(b(c(base)))` for untagged
plugins. Call the result with a base `Fetcher`, or omit it to use a bind-safe global
`fetch`.

```ts twoslash
import { compose, order, ORDER, type Fetcher } from '@itsy/corgi';
declare const logging: import('@itsy/corgi').Plugin;
// ---cut---
const call = compose(logging)(); // -> Fetcher
const res = await call('https://example.com');
```

::: tip
`compose` sorts by `order`, so plugins slot into the right sequence no matter how
you list them (see [`ORDER`](#order)). Plugins with the same hint, or none, keep the
order you passed. Need to override the hints entirely? Nest plugins by hand:
`a(b(c(base)))`.
:::

## `order`

```ts
function order<F extends (next: Fetcher) => Fetcher>(n: number, plugin: F): Plugin;
```

Attaches an ordering hint to a plugin so `corgi` can slot it correctly.

```ts twoslash
import { order, ORDER, type Fetcher } from '@itsy/corgi';
declare function addToken(init?: RequestInit): RequestInit;
// ---cut---
const withAuth = order(
  ORDER.retry - 1,
  (next: Fetcher): Fetcher =>
    (url, init) =>
      next(url, addToken(init)),
);
```

## `ORDER`

Canonical ordering slots (lower = further out / runs earlier on the request).

```ts twoslash
import { ORDER } from '@itsy/corgi';
```

| slot      | value | role                                               |
| --------- | ----- | -------------------------------------------------- |
| `cancel`  | 100   | outermost — cancel-previous aborts the whole chain |
| `dedupe`  | 200   | share one in-flight request                        |
| `retry`   | 300   | re-run; sits outside timeout                       |
| `timeout` | 400   | innermost — per-attempt deadline                   |

Untagged plugins default to `250` (between `dedupe` and `retry`).
