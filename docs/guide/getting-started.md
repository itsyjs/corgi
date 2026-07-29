# Getting started

Corgi is built to be tiny by default, but has plugins to add support for additional use-cases.

All [plugins](/plugins/) are opt-in, so you can keep your bundle size small and only include what you need.

## Install

::: code-group

```sh [npm]
npm i @itsy/corgi
```

```sh [pnpm]
pnpm add @itsy/corgi
```

```sh [bun]
bun add @itsy/corgi
```

```sh [deno]
deno add npm:@itsy/corgi
```

:::

## One-off requests

The `corgi` singleton can be used out of the box for simple requests where plugin-support isn't needed.

```ts twoslash
import { corgi } from '@itsy/corgi';

interface User {
  id: number;
  name: string;
}

// GET + JSON parse + throw-on-error, typed as User
const user = await corgi.get<User>('https://api.example.com/users/1');
```

<small>It supports all HTTP methods as either a function or an option</small>

::: code-group

```ts twoslash [function]
import { corgi } from '@itsy/corgi';
// ---cut---
await corgi.head('https://api.example.com/ping');
```

```ts twoslash [option]
import { corgi } from '@itsy/corgi';
// ---cut---
await corgi('https://api.example.com/ping', { method: 'HEAD' });
```

:::

## Configured clients

Use `corgi.create()` when you want shared defaults (base URL, headers, etc.) or [Plugins](/plugins/timeout) that enable request timeouts, retries, and more.

```ts twoslash
import { corgi } from '@itsy/corgi';

const api = corgi.create({
  baseURL: 'https://api.example.com',
  headers: { authorization: 'Bearer token' },
});

const users = await api.get('/users'); // -> https://api.example.com/users
```

::: tip Batteries included
You can also get a batteries-included version of `corgi` from [`@itsy/corgi/chonk`](/guide/chonk) that includes all plugins!
:::
