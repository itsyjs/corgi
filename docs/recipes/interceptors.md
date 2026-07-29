# ofetch-style interceptors

[ofetch](https://github.com/unjs/ofetch) exposes four lifecycle _interceptors_.
Corgi has no separate interceptor API because a [plugin](/plugins/custom) already
covers all four, and adds short-circuiting, ordering, and state on top.

| ofetch                               | in a plugin                                |
| ------------------------------------ | ------------------------------------------ |
| `onRequest({ request, options })`    | code before `await next(url, init)`        |
| `onRequestError({ ..., error })`     | wrap `next` in `try` / `catch`             |
| `onResponse({ ..., response })`      | code after `await next` (status + headers) |
| `onResponseError({ ..., response })` | after `next`, guard on `!res.ok`           |

ofetch's `timeout: ms` isn't a lifecycle hook, so it maps to a deadline instead. Per
call, that's `signal: AbortSignal.timeout(ms)`. On every call, it's the
[`withTimeout(ms)`](/plugins/timeout) plugin.

<small class="read-more">[Read more: per-attempt vs total budget →](/plugins/timeout#per-attempt-vs-total-budget)</small>

## All four in one plugin

```ts twoslash
import type { Plugin, Fetcher } from '@itsy/corgi';

const withInterceptors: Plugin =
  (next: Fetcher): Fetcher =>
  async (url, init) => {
    // onRequest — inspect / modify before sending
    console.log('[request]', init?.method ?? 'GET', url);

    let res: Response;
    try {
      res = await next(url, init);
    } catch (error) {
      // onRequestError — the fetch itself threw (network / abort / timeout)
      console.error('[request error]', url, error);
      throw error;
    }

    // onResponse — every response (status + headers, never the body)
    console.log('[response]', url, res.status);

    // onResponseError — react to a non-2xx
    if (!res.ok) console.warn('[response error]', url, res.status);

    return res;
  };
```

## The individual hooks

::: details onRequest, modify the outgoing request
A plugin receives the final `url` string and `RequestInit`. The `query` object is
already merged into the URL and the body is already serialized.

```ts twoslash
import type { Plugin, Fetcher } from '@itsy/corgi';
// ---cut---
const withTimestamp: Plugin =
  (next: Fetcher): Fetcher =>
  (url, init) => {
    const u = new URL(url);
    u.searchParams.set('t', String(Date.now()));
    return next(u.toString(), init);
  };
```

:::

::: details onRequestError, the fetch threw
Wrap `next` in `try`/`catch`. The error guards tell the causes apart.

```ts twoslash
import { isAbortError, isTimeoutError } from '@itsy/corgi';
import type { Plugin, Fetcher } from '@itsy/corgi';
// ---cut---
const withRequestErrorLog: Plugin =
  (next: Fetcher): Fetcher =>
  async (url, init) => {
    try {
      return await next(url, init);
    } catch (error) {
      if (isTimeoutError(error)) console.warn('[timeout]', url);
      else if (isAbortError(error)) console.warn('[cancelled]', url);
      else console.error('[network error]', url, error);
      throw error; // rethrow — or return a Response to recover (interceptors can't)
    }
  };
```

:::

::: details onResponse / onResponseError, react to the result
Plugins see the raw `Response` (status, headers) but must not read the body, since
the client parses it once after the pipeline. Split by what you need:

- status / headers: a plugin, below.
- the parsed value: a per-call [`transform`](/guide/responses) or
  [`schema`](/plugins/schema).
- a non-2xx with its parsed body at the call site: the thrown `HttpError`
  (see [Error handling](/recipes/error-handling)).

```ts twoslash
import type { Plugin, Fetcher } from '@itsy/corgi';
// ---cut---
const withResponseLog: Plugin =
  (next: Fetcher): Fetcher =>
  async (url, init) => {
    const res = await next(url, init);
    if (!res.ok)
      console.warn('[http error]', res.status, url); // onResponseError
    else console.log('[ok]', res.status, url); // onResponse
    return res;
  };
```

:::

Two classic `onResponseError` jobs have dedicated pages: refreshing a token on `401`
is [Auth & token refresh](/recipes/auth-refresh), retrying transient statuses is
[retry](/plugins/retry).

## Shared and stacked interceptors

ofetch takes an array of `onRequest` fns; here you add multiple plugins and `compose`
chains them, sorted by their `order` hint. `ofetch.create({ onRequest })` is
`corgi.create({ plugins: [...] })`, and [`extend`](/guide/corgi#extend) derives scoped
children with plugins combining rather than replacing.

```ts twoslash
import { corgi } from '@itsy/corgi';
import type { Plugin } from '@itsy/corgi';
declare const withTimestamp: Plugin;
declare const withInterceptors: Plugin;
// ---cut---
const api = corgi.create({ plugins: [withTimestamp, withInterceptors] });
```

::: details What plugins add, and two seams to watch
Over interceptors you get short-circuiting (skip `next` to serve a cache or mock, or
return a `Response` to recover from an error), ordering (the `order` hint slots each
plugin correctly, e.g. auth once per call, outside retry), and state (closures hold
in-flight maps, as `abortPrevious` and dedupe do).

Two seams to keep in mind:

1. Data lives at the client, not the plugin. Plugins act on `(url, init) → Response`.
   The `query`/`body` objects are serialized before the pipeline and the response body
   is parsed after it, so touch URL/headers/BodyInit in a plugin, and the parsed value
   with a per-call [`transform`](/guide/responses).
2. Plugins are client-level. There are no per-call interceptors; vary behaviour with
   [`extend`](/guide/corgi#extend).

:::
