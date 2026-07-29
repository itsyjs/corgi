# Write your own plugin

A plugin is middleware around `fetch`. Logging, auth, metrics, caching, and mocking
are each a handful of lines.

## The shape

A [`Plugin`](/api/composition#plugin) takes the next fetcher and returns one of its own.

So the skeleton for a plugin looks like this.

```ts twoslash
import type { Plugin, Fetcher } from '@itsy/corgi';

const myPlugin: Plugin =
  (next: Fetcher): Fetcher =>
  async (url, init) => {
    // do things before like inspect/modify url + init
    const res = await next(url, init);
    // or do things after like inspect the Response (don't read its body — leave that for the main client!)
    return res;
  };
```

Three rules:

- Call `next(url, init)` to continue the chain, or don't, to short-circuit the request.
- Return a `Response`. Plugins are pure `Response → Response`, so no parsing and no
  throwing. You can read `res.status` and headers, but don't consume the body; the
  main client parses it.
- Forward `init` to `next`. If you're modifying headers (f.ex), then you should do
  `await next(url, { ...init, headers })`.

### Example: request logging + timing

```ts twoslash
import type { Plugin, Fetcher } from '@itsy/corgi';

const withLog: Plugin =
  (next: Fetcher): Fetcher =>
  async (url, init) => {
    const start = Date.now();
    const res = await next(url, init);
    console.log(`${init?.method ?? 'GET'} ${url} → ${res.status} (${Date.now() - start}ms)`);
    return res;
  };
```

### Example: an auth header, applied once per call

Use [`order`](/api/composition#order) to slot your plugin. Placing auth just
**outside** retry (`ORDER.retry - 1`) means the token is applied once per logical
call, not re-applied on every retry attempt:

```ts twoslash
import { order, ORDER, type Fetcher } from '@itsy/corgi';
declare function getToken(): Promise<string>;
// ---cut---
const withAuth = order(ORDER.retry - 1, (next: Fetcher): Fetcher => async (url, init) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${await getToken()}`);
  return next(url, { ...init, headers });
});
```

Untagged plugins default to order `250` (between `dedupe` and `retry`). See
[`ORDER`](/api/composition#order) for the slots.

## Using your plugin

Exactly like the built-ins — it's the same shape:

```ts twoslash
import { corgi, compose } from '@itsy/corgi';
import type { Plugin } from '@itsy/corgi';
declare const withLog: Plugin;
// ---cut---
// With a client:
const api = corgi.create({ plugins: [withLog] });

// Or standalone, around native fetch:
const fetchL = compose(withLog)();
```

Both paths honor your `order` hint. `corgi` is built on `compose`, and `compose`
sorts by `order` before folding, so you can list plugins in any order and they slot
correctly.

## Stateful plugins

A plugin can keep state in the closure created when it's applied (that's how
[`abortPrevious`](/plugins/abort-previous) remembers the in-flight request). If
yours does, it must live at the client level so the pipeline and its state are built
once and reused. On a server, build such a client per request so unrelated requests
don't share state.

::: details A worked example: in-flight de-duplication

```ts twoslash
import { order, ORDER, type Fetcher } from '@itsy/corgi';
// ---cut---
// Share one request across identical concurrent GETs.
const dedupe = order(ORDER.dedupe, (next: Fetcher): Fetcher => {
  const inflight = new Map<string, Promise<Response>>();
  return (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') return next(url, init);
    const existing = inflight.get(url);
    if (existing) return existing.then((r) => r.clone());
    const p = next(url, init).finally(() => inflight.delete(url));
    inflight.set(url, p);
    return p.then((r) => r.clone());
  };
});
```

:::

## Coming from ofetch?

A plugin covers all four of ofetch's hooks (`onRequest` / `onRequestError` /
`onResponse` / `onResponseError`) and more.

<small class="read-more">[Read more: ofetch-style interceptors →](/recipes/interceptors)</small>
