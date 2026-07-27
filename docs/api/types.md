# Options & types

## `RequestOptions`

Per-call options. Extends `RequestInit` (minus the fields the client owns), so any
standard `fetch` field — `signal`, `credentials`, `mode`, `cache`, `redirect`, … —
passes straight through.

```ts
interface RequestOptions extends Omit<RequestInit, 'body' | 'method' | 'headers'> {
  /** LiteralUnion of the standard verbs — they autocomplete, any string still works. */
  method?: HttpMethod | (string & {});
  headers?: HeadersInit;
  /** Plain object/array -> JSON; BodyInit passes through. `object` (not `Record<string, unknown>`)
   * so interface DTOs type-check (TS#15300); a Map/Set/class instance type-checks but won't JSON-serialize cleanly. */
  body?: BodyInit | object | null;
  /** Object merged into the URL's query string (arrays -> repeated keys). */
  query?: Query;
  /** Prefix-joined with the url; absolute urls bypass it. */
  baseURL?: string;
  /** Force a parse mode instead of sniffing the content-type. */
  responseType?: ParseAs;
  /** Throw HttpError on non-2xx. Default true. A `(status) => boolean` predicate throws selectively. */
  throwOnError?: boolean | ((status: number) => boolean);
  /** Post-parse hook: map/validate the value. Its return type becomes the result. */
  transform?: (value: unknown, response: Response) => unknown;
}
```

### Selective throwing

`throwOnError` accepts a `(status) => boolean` predicate: return `true` to throw
[`HttpError`](/api/errors#httperror), `false` to resolve with the parsed body
(typed as your `<T>`). Useful when an API returns a body you want to read on some
4xx, while still throwing on server errors:

```ts twoslash
import { corgi } from '@itsy/corgi';
interface User {}
interface ApiError {}
// ---cut---
// Client-wide policy: throw 5xx, hand back 4xx bodies.
const api = corgi.create({
  baseURL: 'https://api.example.com',
  throwOnError: (status) => status >= 500,
});

const user = await api.get<User | ApiError>('/users/1'); // 404/422 body returned; 500 throws
```

Per call, tolerate a single status and keep its parsed body:

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create({ baseURL: 'https://api.example.com' });
interface Order {}
interface Conflict {}
declare const draft: object;
// ---cut---
const out = await api.post<Order | Conflict>('/orders', {
  body: draft,
  throwOnError: (s) => s !== 409, // everything but 409 throws; 409 body returned + parsed
});
```

The non-thrown branch returns the parsed body **without** surfacing the status, so
the predicate shines when you WANT the error body. To branch on status and remap
(e.g. 404 → `null`), a `try/catch` + [`isHttpError`](/api/errors#ishttperror)
reads cleaner.

### `HttpMethod`

```ts twoslash
import type { HttpMethod } from '@itsy/corgi';
//          ^?
```

::: info Pipeline config is client-level
There is no per-call `plugins`, `fetch`, or `timeout`. Those shape the pipeline
and live on [`CorgiOptions`](#corgioptions) / `extend`.

For a per-call deadline, pass the standard `signal: AbortSignal.timeout(ms)` — a
**total** budget for that call. For a **per-attempt** deadline, add the
[`withTimeout`](/plugins/timeout) plugin (client-level).
:::

## `CorgiOptions`

Corgi-level defaults, merged into every request.

```ts
interface CorgiOptions {
  baseURL?: string;
  headers?: HeadersInit;
  /** Boolean, or a `(status) => boolean` predicate for a client-wide throw policy. */
  throwOnError?: boolean | ((status: number) => boolean);
  /** Middleware plugins; built into the pipeline once and reused (order-sorted). */
  plugins?: readonly Plugin[];
  /** Custom fetch implementation for this client. */
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  mode?: RequestMode;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
}
```

## `ParseAs`

```ts twoslash
import type { ParseAs } from '@itsy/corgi';
```

## `MappedResponse`

Maps a `responseType` to the value type it produces. `json` falls through to your
`<T>`; the rest are fixed platform types.

```ts twoslash
import type { MappedResponse } from '@itsy/corgi';

type A = MappedResponse<'text', unknown>;
type B = MappedResponse<'blob', unknown>;
type C = MappedResponse<'stream', unknown>;
```

## `Query` & `QueryValue`

```ts twoslash
import type { Query, QueryValue } from '@itsy/corgi';
```

A value that can appear in a `query` object. Arrays of scalars expand to repeated
keys; `null`/`undefined` are skipped.
