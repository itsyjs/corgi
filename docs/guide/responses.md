# Responses & errors

## Parsing

By default Corgi parses the body based on the response's `content-type`,
handling the most common cases as follows.

| Content-Type                            | Result    | Notes                                                                        |
| --------------------------------------- | --------- | ---------------------------------------------------------------------------- |
| `application/json` and `+json` suffixes | JSON      | Parsed, but an empty body yields `undefined` instead of throwing             |
| `text/*`                                | string    |                                                                              |
| (unknown/missing)                       | string    | Returns text and will not guess JSON, so HTML error pages don't cause issues |
| `204`/`205`/`304` and `HEAD`            | undefined | No body, so short-circuits to `undefined`                                    |
| everything else                         | Blob      |                                                                              |

::: details Forcing a response type
You can force a specific mode with `responseType`, and this will inform the TypeScript return type as well.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
const text = await api.get('/page', { responseType: 'text' });
const blob = await api.get('/img', { responseType: 'blob' });
const buf = await api.get('/bin', { responseType: 'arrayBuffer' });
```

:::

## Errors

All non-2xx responses reject with an [`HttpError`](/api/errors) by default.

```ts twoslash
import { corgi, isHttpError } from '@itsy/corgi';

try {
  await corgi.get('https://api.example.com/nope');
} catch (err) {
  if (isHttpError(err)) {
    err.status; // number, e.g. 404
    err.data; // best-effort parsed error body
    await err.response.json(); // the response was cloned, so it's still readable
  }
}
```

::: details Opting out of throwing

There are two ways to opt out of throwing on non-2xx responses.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
// 1. Disable the default error throwing behavior
const data = await api.get('/maybe', { throwOnError: false });

// 2. Get the raw Response
const res = await api.raw('/maybe');
```

:::

## Error guards

`isHttpError`, `isTimeoutError`, and `isAbortError` check the error's _name_, not
`instanceof` — so they keep working even where `instanceof` silently returns `false`.

```ts twoslash
import { isTimeoutError, isAbortError } from '@itsy/corgi';
declare const err: unknown;
// ---cut---
if (isTimeoutError(err)) {
  // a per-attempt timeout fired
} else if (isAbortError(err)) {
  // the caller (or a superseding call) cancelled
}
```

::: details Where instanceof fails
An error that crosses an iframe or web worker, or two bundled copies of the library, will fail `instanceof` checks because the constructor is different. These guards check the error's `name` instead, so they work in all cases.
:::

## Transform

A `transform` runs after parsing and its return type becomes the result. This is the hook
that powers [`schema()`](/plugins/schema):

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
const id = await api.get('/user', { transform: (v) => (v as { id: number }).id });
//    ^?
```
