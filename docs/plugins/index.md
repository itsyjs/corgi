# Plugins

A **plugin** is middleware for `fetch`. Plugins can even be used with native fetch!

Each built-in plugin lives on its own import path, so it costs **zero bytes** unless you import it.

| plugin                                     | import                       | what it does                                                          | `ORDER` slot    | stateful? |
| ------------------------------------------ | ---------------------------- | --------------------------------------------------------------------- | --------------- | --------- |
| [`withTimeout`](/plugins/timeout)          | `@itsy/corgi/timeout`        | per-attempt request timeouts                                          | `timeout` (400) | no        |
| [`withTimeout`](/plugins/timeout)          | `@itsy/corgi/timeout-modern` | per-attempt request timeouts, using modern JS (2024) for smaller size | `timeout` (400) | no        |
| [`withRetry`](/plugins/retry)              | `@itsy/corgi/retry`          | retry request failures w/ backoff                                     | `retry` (300)   | no        |
| [`abortPrevious`](/plugins/abort-previous) | `@itsy/corgi/abort-previous` | cancel the in-flight request when a new one starts (avoids racing)    | `cancel` (100)  | **yes**   |
| [`schema`](/plugins/schema)                | `@itsy/corgi/schema`         | runtime-validate a response body                                      | N/A             | no        |

::: info The schema plugin
`schema` isn't technically a plugin (it's a `transform`), but it's opt-in and extends
what a call can do, so it's listed here for the overview.

You can read more information about schema [on its page](/plugins/schema)
:::

## Use with a Corgi instance

Pass plugins to `create` - they'll be used on every call.

If you pass plugins to `extend`, they **combine** with the parent's.
In [chonk](/guide/chonk#derived-clients), where plugins are options, a value you pass replaces the
parent's instead.

```ts twoslash
import { corgi } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

const api = corgi.create({
  baseURL: 'https://api.example.com',
  plugins: [withRetry(3), withTimeout(5000)], // sorted to retry → timeout for you
});

await api.get('/users'); // parsed, typed, throws on non-2xx
```

::: info Plugin order
Plugins are sorted automatically by an internal value, so you don't have to worry about the order in the `plugins` array.
:::

## Already packaged into Corgi-chonk

[`@itsy/corgi/chonk`](/guide/chonk) bundles all the built-in plugins into a single package, so you can skip the imports and just use them.

```ts twoslash
import { corgi } from '@itsy/corgi/chonk';

const api = corgi.create({
  baseURL: 'https://api.example.com',
  retry: 3,
  timeout: 5000,
  abortPrevious: true,
});
```

## Use with native `fetch`

Because a plugin is `fetch`-shaped middleware, you can compose plugins into a
drop-in `fetch` with no client and no parsing layer. Use `compose(...)()`, omitting
the base to get a bind-safe global `fetch`:

```ts twoslash
import { compose } from '@itsy/corgi';
import { withRetry } from '@itsy/corgi/retry';
import { withTimeout } from '@itsy/corgi/timeout';

// A fetch with retry + timeout baked in:
const fetchX = compose(withRetry(3), withTimeout(5000))();

const res = await fetchX('https://api.example.com/data');
const data = await res.json(); // you handle the Response yourself
```

::: details Things to know about this mode

- The above example will wrap global `fetch` with the plugins shown. So normal response handling will be in play (e.g. you'll need to do `res.ok`).
- `compose` still sorts by `ORDER` just like the `plugins` array of Corgi.
- Prefer `compose(...)()` over `plugin(fetch)` as `compose` with no base uses a
  bind-safe global `fetch`

:::

<small>If you want to use a custom fetch, pass it to `compose` instead of calling it with no arguments.</small>

```ts twoslash
import { compose } from '@itsy/corgi';
import { withTimeout } from '@itsy/corgi/timeout';
declare const myFetch: typeof fetch;
// ---cut---
// A single plugin around a custom fetch:
const fetchT = compose(withTimeout(3000))(myFetch);
```
