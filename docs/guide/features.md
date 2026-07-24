# Features

What Corgi adds on top of `fetch`. All optional.

## One client, or many

`corgi` for one-offs; `corgi.create()` for a configured client. Both are callable and have `get`/`post`/`put`/`patch`/`delete`/`head`.

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
await corgi.get('https://api.example.com/ping');

const api = corgi.create({ baseURL: 'https://api.example.com' });
await api.post('/users', { body: { name: 'Ada' } });
```

<small class="read-more">[Read more: The Corgi export →](/guide/corgi)</small>

## Throws on non-2xx

No `if (!res.ok)`. A 404/500 rejects with a typed [`HttpError`](/api/errors) carrying the status, parsed body, and a re-readable response.

```ts twoslash
import { corgi, isHttpError } from '@itsy/corgi';
// ---cut---
try {
  await corgi.get('/users/1');
} catch (err) {
  if (isHttpError(err)) err.status; // 404
}
```

<small class="read-more">[Read more: Responses & errors →](/guide/responses)</small>

## Typed results

`unknown` by default, never `any`.

```ts twoslash
import { corgi } from '@itsy/corgi';
interface User {
  id: number;
}
// ---cut---
const user = await corgi.get<User>('/users/1'); //            User
const text = await corgi.get('/x', { responseType: 'text' }); // string
```

<small class="read-more">[Read more: TypeScript →](/guide/typescript)</small>

## Request building, handled

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create({ baseURL: 'https://api.example.com' });
// ---cut---
await api.get('/search', { query: { tag: ['a', 'b'], page: 2 } }); // ?tag=a&tag=b&page=2
await api.post('/users', { body: { name: 'Ada' } }); //              JSON + content-type set
```

<small class="read-more">[Read more: Building requests →](/guide/requests)</small>

## Error guards

Name-based, so they survive iframes, workers, and duplicate bundles where `instanceof` fails.

```ts twoslash
import { isTimeoutError, isAbortError } from '@itsy/corgi';
declare const err: unknown;
// ---cut---
isTimeoutError(err);
isAbortError(err);
```

<small class="read-more">[Read more: Error guards →](/guide/responses#error-guards)</small>

## Opt-in plugins

Retry, timeout, cancel-previous, schema validation — each on its own import path, zero cost until imported.

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
const api = corgi.create({ plugins: [withRetry(3), withTimeout(5000)] });
```

<small class="read-more">[Read more: Plugins →](/plugins/)</small>

## Derived clients

`extend()` — headers and plugins combine with the parent, not replace.

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
const api = corgi.create({ headers: { authorization: 'Bearer t' } });
const billing = api.extend({ headers: { 'x-scope': 'billing' } }); // keeps auth
```

<small class="read-more">[Read more: The Corgi export →](/guide/corgi)</small>

## Parses the response

By `content-type` — JSON, text, or `Blob`. Empty JSON → `undefined` (not a throw); unknown types → text (no JSON guessing).

<small class="read-more">[Read more: Parsing →](/guide/responses#parsing)</small>
