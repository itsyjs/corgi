# Building requests

Corgi has a few extra features on top of the `fetch` API to make
requests easier to build. Everything is optional, use the
standard `fetch` API if preferred.

## Base URL

`baseURL` is prepended to relative URLs on the client

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
const api = corgi.create({ baseURL: 'https://api.example.com/v1' });

await api.get('/users'); //            -> https://api.example.com/v1/users
await api.get('users'); //             -> https://api.example.com/v1/users
await api.get('https://other.com/x'); // absolute URL bypasses baseURL entirely
```

## Query

The `query` attribute is merged into the URL's query string.

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
await corgi.get('/search', {
  query: { foo: 'bar', tag: ['a', 'b'], page: 2, cursor: null },
});
// -> /search?foo=bar&tag=a&tag=b&page=2    (cursor skipped)
```

<small>Values (and keys) are encoded via `URLSearchParams`, so spaces, `&`, unicode, etc.
are escaped correctly.</small>

::: details How query is processed

- arrays expand to repeated keys
- any existing query and `#hash` is preserved

Both `null` and `undefined` are dropped entirely. Corgi does **not** emit a
value-less `?flag` for `null` the way ofetch does. The web platform's
`URLSearchParams` can't represent a bare key (it normalizes `?flag` to `flag=`) and Corgi matches that behavior.

If you truly need a bare flag, put it in the URL string on a call that doesn't also pass `query`.
:::

## Body

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
// JSON:
await corgi.post('/users', { body: { name: 'Ada' } });

// FormData passes through — the runtime sets the multipart boundary:
const form = new FormData();
form.set('file', new Blob(['hi']), 'hi.txt');
await corgi.post('/upload', { body: form });
```

::: details How body is processed
A plain object or array is JSON-encoded and the `content-type` is set automatically.

Everything 'native' passes through untouched:

- `FormData`
- `Blob`/`File`
- `URLSearchParams`
- `ReadableStream`
- `ArrayBuffer`
- typed arrays

Streaming request bodies get `duplex: 'half'` automatically - Node/undici require
it or they throw.
:::

## Headers

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
const api = corgi.create({ headers: { 'x-app': 'web' } });
await api.get('/me', { headers: { authorization: 'Bearer t' } });
// sends: x-app: web  +  authorization: Bearer t
```

::: details How headers are processed
Headers are merged on a case-insensitive basis.

Order:

- an automatic `content-type`
- client defaults
- per-call headers

This means a caller header always wins.
:::

## Everything else

Any standard `RequestInit` field you set (`signal`, `mode`, `cache`, `priority`, etc.) is forwarded to `fetch` unchanged.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
const controller = new AbortController();
await api.get('/slow', { signal: controller.signal, credentials: 'include' });
```

A per-call deadline is a `signal` too — `AbortSignal.timeout(ms)` aborts the call (a
TOTAL budget spanning any retries). For a per-attempt deadline use the
[`withTimeout`](/plugins/timeout) plugin.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
await api.get('/slow', { signal: AbortSignal.timeout(5000) }); // this call: 5s max
```
