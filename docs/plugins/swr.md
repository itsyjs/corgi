# swr

Serve GETs from an in-memory cache!

- Fresh hits skip the network
- Stale hits are answered instantly while a background refresh updates the store
- Concurrent misses share one request

```ts twoslash
import { corgi } from '@itsy/corgi';
import { swr } from '@itsy/corgi/swr';

const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: 300_000 })] });

await api.get('/rates'); // miss -> network, response stored
await api.get('/rates'); // < 60s later -> from memory, no request
await api.get('/rates'); // 60s-6min later -> stale answer now, refresh in the background
```

Works with a Corgi as a plugin or via [`/chonk`'s `swr` option](/guide/chonk).

## Options

```ts twoslash
import { swr } from '@itsy/corgi/swr';
// ---cut---
swr({
  fresh: 60_000, // ms a stored response is served from memory — zero network
  stale: 300_000, // ms AFTER fresh: serve the stale copy now + refresh in the background (default 0)
  errorBackoff: 10_000, // after a failed refresh, don't try again for this long (default 0)
  accept: (res) => res.ok, // what may enter the store (default shown) — may read the body
  onError: ({ url }) => console.warn('refresh failed', url), // background failures (default: silent)
});

swr(60_000); // number shorthand -> { fresh: 60_000 }
```

::: details How age is resolved
With `age` = ms since the response was stored:

| age               | behaviour                                             |
| ----------------- | ----------------------------------------------------- |
| `< fresh`         | served from memory — no request                       |
| `< fresh + stale` | stale copy served now; one refresh updates the store  |
| past both         | entry dropped — the call hits the network like a miss |

Note: `stale: Infinity` is supported. Once warm, calls never block again — the stale copy
is always served while refreshes run in the background.
:::

## Request dedupe

<small>Concurrent misses for the same url always share one request. `fresh: 0` makes
that the whole plugin: never serve from the store, still collapse bursts.</small>

```ts twoslash
import { corgi } from '@itsy/corgi';
import { swr } from '@itsy/corgi/swr';
// ---cut---
const api = corgi.create({ plugins: [swr({ fresh: 0 })] });

// three components mount at once -> ONE request, all three calls resolve
await Promise.all([api.get('/me'), api.get('/me'), api.get('/me')]);
```

## Behaviour

- GETs only, keyed by the final url. Everything else passes straight through.
- Only responses `accept` lets in are stored (default `res.ok`). A failed refresh
  keeps the old entry serving — effectively `stale-if-error` — waits out
  `errorBackoff` before re-attempting, and reports through `onError`.
- One refresh per url at a time, detached from the caller's `signal`.
- A shared trip carries the FIRST caller's `signal`, so if that caller aborts, the
  callers who joined its trip reject too. The slot is released either way.
- Expired entries are deleted when a call touches them; nothing else evicts.

## Composing with the other plugins

- With [`retry`](/plugins/retry): a failed refresh attempt is retried before it counts
  as failed — so one `errorBackoff` cycle costs `retries + 1` upstream requests.
- With [`timeout`](/plugins/timeout): a hung refresh is cut off and reported to
  `onError`. **Recommended on servers** — without a deadline, a hung refresh holds the
  per-url single-flight lock forever and no new refresh can start (`errorBackoff`
  can't help: nothing ever fails).
- With [`abortPrevious`](/plugins/abort-previous): superseding calls and background
  refreshes can't cancel each other.
- Plugins to the 'inside' of swr run only on real network trips, never on cache hits — and the
  cache key is the url as swr sees it, so an inside plugin that rewrites the url
  (auth or cache-busting params) doesn't fragment the key.

## Surviving a down upstream

<small>`stale: Infinity` never blocks once warm; `errorBackoff` stops a failing upstream
from being hit on every stale call; `onError` is the only place background failures
surface.</small>

```ts twoslash
import { corgi } from '@itsy/corgi';
import { swr } from '@itsy/corgi/swr';
declare const logger: { error: (msg: string, ctx?: unknown) => void };
// ---cut---
const menu = corgi.create({
  plugins: [
    swr({
      fresh: 60_000, // serve from memory for a minute
      stale: Infinity, // after that: stale instantly, forever, refresh in the background
      errorBackoff: 10_000, // upstream failing? keep serving stale, re-attempt every 10s
      onError: ({ url, error, response }) => logger.error(`refresh failed: ${url}`, error ?? response),
    }),
  ],
});
```

<small>Gate what may enter the store with `accept` — a refusal counts as a failed
refresh, so the last good response keeps serving:</small>

```ts
import { swr } from '@itsy/corgi/swr';
import { MenuSchema } from './schemas';

// a garbage 200 can't poison the cache:
swr({
  fresh: 60_000,
  stale: Infinity,
  accept: async (res) => MenuSchema.safeParse(await res.json()).success,
});
```

## Caveats

<small>The cache lives in the client: one client = one cache, and `extend()` starts an
empty one.</small>

```ts twoslash
import { corgi } from '@itsy/corgi';
import { swr } from '@itsy/corgi/swr';
// ---cut---
// DO: module scope for data that is the same for everyone (rates, catalogs, flags):
const rates = corgi.create({ plugins: [swr({ fresh: 60_000 })] });

// DON'T: module scope when responses differ per user — the key is the url alone,
// so user A's /me would be served to user B. Build the client per request instead:
const forUser = (token: string) => corgi.create({ headers: { authorization: token }, plugins: [swr(60_000)] });
```

::: warning On the server
The cache key is the final url — auth headers and cookies are NOT part of it.
Per-user responses through a shared client are a data leak.
:::
