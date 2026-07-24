# The Corgi

`corgi` is the root export: a ready-to-use `Corgi` — a callable that's also an object
of verb shortcuts and helpers — that additionally exposes [`create`](#create) for
building configured instances. Its type is `CorgiAPI` (a `Corgi` plus `create`).

```ts twoslash
import { corgi } from '@itsy/corgi';
```

## Call signature

Every callable (the client itself and each verb) shares the `Call` overload set:

```ts
interface Call {
  // transform → the transform's return type
  <R>(
    url: string,
    options: RequestOptions & { transform: (value: unknown, response: Response) => R | Promise<R> },
  ): Promise<R>;
  // responseType → mapped platform type
  <T = unknown, P extends ParseAs = 'json'>(
    url: string,
    options: RequestOptions & { responseType: P },
  ): Promise<MappedResponse<P, T>>;
  // otherwise → your <T> (default unknown)
  <T = unknown>(url: string, options?: RequestOptions): Promise<T>;
}
```

## Methods

```ts
interface Corgi extends Call {
  get: Call;
  post: Call;
  put: Call;
  patch: Call;
  delete: Call;
  head: Call;
  raw: (url: string, options?: RequestOptions) => Promise<Response>;
  extend: (defaults?: CorgiOptions) => Corgi;
}
```

### verbs — `get` / `post` / `put` / `patch` / `delete` / `head`

Shorthands that set the method and otherwise behave like the callable.

### `raw`

```ts
raw(url: string, options?: RequestOptions): Promise<Response>;
```

Returns the untouched `Response`. **No parsing, no throwing** — the escape hatch
for streaming, manual status handling, or reading headers.

### `extend`

```ts
extend(defaults?: CorgiOptions): Corgi;
```

Derives a new client whose defaults extend this one's. Headers and plugins
**combine** (they don't replace). This is the supported way to make a one-off
pipeline variation.

## The root export — `create`

`corgi` itself is a `CorgiAPI`: a `Corgi` plus a `create` method for building configured
instances. (Both `create` and [`extend`](#extend) return a plain `Corgi`.)

```ts
interface CorgiAPI extends Corgi {
  create: (defaults?: CorgiOptions) => Corgi;
}
```

### `create`

```ts
create(defaults?: CorgiOptions): Corgi;
```

Builds a fresh, independently-configured `Corgi` — base URL, headers, plugins, etc. The
plugin pipeline is built once and reused across its calls. See
[Options & types](/api/types#corgioptions) for `CorgiOptions`.

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
const api = corgi.create({
  baseURL: 'https://api.example.com',
  headers: { authorization: 'Bearer token' },
});
```
