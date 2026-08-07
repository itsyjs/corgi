# The Corgi export

`corgi` is the zero-config singleton — ready to use with any HTTP method or call `create` to start configuring.

## create

To build a configured [`Corgi`](/api/corgi-interface) client, call `create` with an optional config object.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create({ baseURL: 'https://api.example.com' });

await api.get('/user', { query: { name: 'Jane' } });
await api.post('/users', { body: { name: 'John' } });
await api.put('/users/1', { body: { age: 42 } });
await api.patch('/users/1', { body: { terms: true } });
await api.delete('/users/1');
await api.head('/users/1');

// all of the above are also available via the method attribute
await api('/users', { method: 'OPTIONS' });
```

## extend

For additional defaults or plugins on top of a base instance, use `extend`.

Headers and plugins **combine** rather than replace. To drop an inherited header, pass it with an
empty value.

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
const base = corgi.create({
  baseURL: 'https://api.example.com',
  headers: { authorization: 'Bearer token' },
});

// Inherits baseURL + auth header, adds its own:
const billing = base.extend({ headers: { 'x-scope': 'billing' } });
await billing.get('/invoices');

// An empty value drops an inherited header:
const anon = base.extend({ headers: { authorization: '' } });
await anon.get('/status'); // sent without authorization
```

## raw

If you want to opt-out of default parsing and throwing behaviors of Corgi, use `raw` - which will return the untouched `Response`.

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
const res = await api.raw('/download');
if (res.ok) {
  const buf = await res.arrayBuffer();
}
```
