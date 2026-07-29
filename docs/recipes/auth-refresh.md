# Auth & token refresh

Two common needs: attach an auth token to every request, and transparently refresh
it when it expires. Both are plugins.

## Attaching a token

The simplest case, a static token, is just a header on the client:

```ts twoslash
import { corgi } from '@itsy/corgi';
declare const token: string;
// ---cut---
const api = corgi.create({
  baseURL: 'https://api.example.com',
  headers: { authorization: `Bearer ${token}` },
});
```

For a token that changes at runtime, use a plugin so it's read fresh on every call.
Slot it just **outside** retry (`ORDER.retry - 1`) so it's applied once per logical
call, not re-applied on every retry attempt:

```ts twoslash
import { corgi, order, ORDER, type Fetcher } from '@itsy/corgi';
declare const tokenStore: { get(): string | undefined };
// ---cut---
const withAuth = order(ORDER.retry - 1, (next: Fetcher): Fetcher => (url, init) => {
  const headers = new Headers(init?.headers);
  const token = tokenStore.get();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return next(url, { ...init, headers });
});

const api = corgi.create({ baseURL: 'https://api.example.com', plugins: [withAuth] });
```

## Refresh on 401, exactly once

Extend the plugin: if a response comes back `401`, refresh the token and replay the
request once. Because a plugin sees the raw `Response`, this is straightforward:

```ts twoslash
import { order, ORDER, type Fetcher } from '@itsy/corgi';
declare const tokenStore: { get(): string | undefined; set(t: string): void };
declare function refreshToken(): Promise<string>;
// ---cut---
const withAuthRefresh = order(ORDER.retry - 1, (next: Fetcher): Fetcher => async (url, init) => {
  const call = (token: string | undefined) => {
    const headers = new Headers(init?.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return next(url, { ...init, headers });
  };

  let res = await call(tokenStore.get());
  if (res.status === 401) {
    res.body?.cancel().catch(() => {}); // release the 401 body's connection
    const fresh = await refreshToken();
    tokenStore.set(fresh);
    res = await call(fresh); // replay once with the new token
  }
  return res;
});
```

::: tip Single-flight the refresh
If many requests get a 401 at once, you don't want a refresh storm. Cache the
in-flight refresh promise so concurrent callers share one refresh:

```ts twoslash
declare function doRefresh(): Promise<string>;
// ---cut---
let refreshing: Promise<string> | undefined;
function refreshToken(): Promise<string> {
  refreshing ??= doRefresh().finally(() => (refreshing = undefined));
  return refreshing;
}
```

:::

## Scoped sub-clients with `extend`

A common shape: one authenticated base client, several feature clients that inherit
its auth and add their own defaults. `extend` **combines** headers and plugins
rather than replacing them:

```ts twoslash
import { corgi } from '@itsy/corgi';
import type { Plugin } from '@itsy/corgi';
declare const withAuth: Plugin;
// ---cut---
const base = corgi.create({ baseURL: 'https://api.example.com', plugins: [withAuth] });

const billing = base.extend({ headers: { 'x-scope': 'billing' } }); // keeps auth
const admin = base.extend({ headers: { 'x-scope': 'admin' } }); // keeps auth
```
