# Core concepts

Everything in Corgi is built from two tiny shapes and one composition
function.

## `Fetcher`

A `Fetcher` is a function that looks exactly like `fetch`: give it a URL (and
optional `init`) and it resolves to a `Response`.

```ts twoslash
import type { Fetcher } from '@itsy/corgi';
```

The real `fetch` is a `Fetcher`. So is every layer you build on top of it.

## `Plugin`

A `Plugin` is middleware for `Fetcher`s: it takes a `Fetcher` and returns an
enhanced one. This is the classic `(next) => (url, init) => …` shape.

```ts twoslash
import type { Plugin, Fetcher } from '@itsy/corgi';

// A plugin that logs every request:
const withLog: Plugin =
  (next: Fetcher): Fetcher =>
  async (url, init) => {
    console.log('→', url);
    const res = await next(url, init);
    console.log('←', res.status);
    return res;
  };
```

Plugins stay pure `Response → Response`. They never parse or throw — that's the
client's job — so a plugin like retry can read `res.status` freely while the body
is left untouched.

## `compose`

`compose` folds plugins into a single plugin, applied **outermost-first**:

```ts twoslash
import { compose, type Plugin } from '@itsy/corgi';
declare const a: Plugin;
declare const b: Plugin;
declare const c: Plugin;
// ---cut---
// compose(a, b, c)(base) === a(b(c(base)))
const call = compose(a, b, c)(); // omit the base to use a bind-safe global fetch
const res = await call('https://example.com');
```

Here `a`/`b`/`c` are untagged, so they keep the order you passed: `a` is the
outermost layer (sees the request first, the response last) and `c` sits closest
to the real `fetch`.

::: tip compose sorts by order
`compose` slots plugins by their `order` hint (below) before folding them. Plugins
with the same hint — or none, like `a`/`b`/`c` here — keep the order you pass. To
override the hints, nest the plugins by hand: `a(b(c(base)))`.
:::

## `order` and `ORDER`

`compose` (and `corgi`, built on it) sorts plugins by an `order` hint so
the sequence is correct no matter how you list them. The built-in slots:

| slot      | value | meaning                                                      |
| --------- | ----- | ------------------------------------------------------------ |
| `cancel`  | 100   | outermost — a superseding call aborts the entire prior chain |
| `dedupe`  | 200   | share one in-flight request across identical callers         |
| `retry`   | 300   | re-run the request; sits **outside** timeout                 |
| `timeout` | 400   | innermost — per-attempt deadline, next to `fetch`            |

Lower number = further out (runs earlier on the request). Built-in plugins are
pre-tagged; tag your own with `order`:

```ts twoslash
import { order, ORDER, type Fetcher } from '@itsy/corgi';
declare function addToken(init?: RequestInit): RequestInit;
// ---cut---
// Apply auth once per logical call, just OUTSIDE retry (so it isn't re-applied
// on every retry attempt):
const withAuth = order(
  ORDER.retry - 1,
  (next: Fetcher): Fetcher =>
    (url, init) =>
      next(url, addToken(init)),
);
```

That ordering is why, for example, `withRetry` sits outside `withTimeout`: each
attempt gets its own fresh deadline, and a fired timeout is retried.
