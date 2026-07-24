# ofetch-style interceptors

[ofetch](https://github.com/unjs/ofetch) exposes four lifecycle
_interceptors_ — `onRequest`, `onRequestError`, `onResponse`, `onResponseError`.

`@itsy/corgi` has no separate interceptor API because a [plugin](/plugins/custom) —
middleware around `fetch` — already covers all four, and adds short-circuiting,
ordering, and state on top.

| ofetch                               | in a plugin                                |
| ------------------------------------ | ------------------------------------------ |
| `onRequest({ corgi, options })`      | code before `await next(url, init)`        |
| `onRequestError({ ..., error })`     | wrap `next` in `try` / `catch`             |
| `onResponse({ ..., response })`      | code after `await next` (status + headers) |
| `onResponseError({ ..., response })` | after `next`, guard on `!res.ok`           |

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

## onRequest — modify the outgoing request

A plugin receives the **final** `url` string and `RequestInit` - the `query` object is
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

## onRequestError — the fetch threw

Wrap `next` in `try`/`catch`. The error guards help tell the causes apart.

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

## onResponse / onResponseError — react to the result

Plugins see the raw `Response` (status, headers) but **must not read the body** — the
client parses it once, after the pipeline. So split by what you need:

- status / headers → a plugin, below.
- the **parsed** value → a per-call [`transform`](/guide/responses) or
  [`schema`](/plugins/schema).
- a non-2xx **with its parsed body** at the call site → the thrown `HttpError`
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

Two classic `onResponseError` jobs have dedicated homes: refreshing a token on `401`
is [Auth & token refresh](/recipes/auth-refresh); retrying transient statuses is
[retry](/plugins/retry).

## Arrays of interceptors → just add plugins

ofetch takes an array of `onRequest` fns; here you add multiple plugins. `compose`
chains them and sorts by their `order` hint:

```ts twoslash
import { corgi } from '@itsy/corgi';
import type { Plugin } from '@itsy/corgi';
declare const withTimestamp: Plugin;
declare const withInterceptors: Plugin;
// ---cut---
const api = corgi.create({ plugins: [withTimestamp, withInterceptors] });
```

## Shared interceptors → `ofetch.create`

`ofetch.create({ onRequest })` is `corgi.create({ plugins: [...] })`. Derive scoped
children with [`extend`](/guide/corgi#extend) — plugins combine, not replace.

## What plugins add over interceptors

- **Short-circuit** — skip `next` to serve a cache/mock, or return a `Response` to
  recover from an error.
- **Ordering** — the `order` hint slots each plugin correctly (e.g. auth once per call,
  outside retry).
- **State** — closures hold in-flight maps (`abortPrevious`, dedupe).

## Two seams to remember

1. **Data lives at the client, not the plugin.** Plugins act on `(url, init) → Response`.
   The `query`/`body` objects are serialized before the pipeline and the response body is
   parsed after it — so touch URL/headers/BodyInit in a plugin, and the parsed value with
   a per-call [`transform`](/guide/responses).
2. **Plugins are client-level.** There are no per-call interceptors; vary behaviour with
   [`extend`](/guide/corgi#extend).
