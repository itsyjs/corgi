# Options & types

## `RequestOptions`

Per-call options. Extends `RequestInit` (minus the fields the client owns), so any
standard `fetch` field — `signal`, `credentials`, `mode`, `cache`, `redirect`, … —
passes straight through.

```ts
interface RequestOptions extends Omit<RequestInit, 'body' | 'method' | 'headers'> {
  method?: string;
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
  /** Throw HttpError on non-2xx. Default true. */
  throwOnError?: boolean;
  /** Post-parse hook: map/validate the value. Its return type becomes the result. */
  transform?: (value: unknown, response: Response) => unknown;
}
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
  throwOnError?: boolean;
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
