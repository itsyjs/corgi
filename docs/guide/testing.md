# Testing

Ideally, avoid mocking Corgi and rather hand it a fake `fetch`.

`mockFetch()` from `@itsy/corgi/testing` provides a fake; you tell it how to answer requests, and it
records every request it receives.

This way, Corgi still runs as normal - it builds the
url and query string, retries, throws `HttpError` - so your tests exercise the
same code that runs in production.

<small>This example would work with any test runner!</small>

```ts twoslash
import { corgi } from '@itsy/corgi';
import { mockFetch } from '@itsy/corgi/testing';

const http = mockFetch();

// A client that talks to the mock instead of the network
const api = corgi.create({ fetch: http.fetch });

// "GET /users responds with this JSON"
http.get('/users', { json: [{ id: 1 }] });

const users = await api.get('/users', { query: { page: 2 } });

// The request was recorded, with the url corgi really built:
http.lastCall?.url; //                '/users?page=2'
http.lastCall?.query.get('page'); //  '2'
```

Pass `fetch` in like this whenever the test creates the client — each test can
have its own isolated mock.

## Matching requests

A string route matches the request **path** and ignores the rest (origin,
query). For anything dynamic, use a RegExp or a function:

```ts twoslash
import { mockFetch } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
http.get('/users', { json: [] }); //                  path match — any query
http.post(/\/users\/\d+$/, { status: 204 }); //       RegExp, tested on the whole url
http.get((call) => call.query.has('q'), { text: 'hits' }); // function gets the full request
```

::: info `/users/:id` throws on purpose
`:id`-style patterns aren't supported, and matching them as literal text would
be confusing — so registering one throws. Use a RegExp, then assert the exact
path with `http.lastCall?.pathname`.
:::

## Replies

```ts twoslash
import { mockFetch, networkError } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
http.get('/a', { json: { ok: true } }); //  200 with a JSON body
http.get('/b', { text: '<p>hi</p>' }); //   200 with a text body
http.get('/c', { status: 503 }); //         any status (statusText filled in for you)
http.get('/d', networkError()); //          fails as if the network died
http.get('/e', { hang: true }); //          never answers — for abort/timeout tests
http.get('/f', (call) => ({ json: call.json() })); // computed per request
http.get('/g', { json: [], delay: 30 }); // answers after 30ms — loading states
```

An array means "answer with these, in order" — the last entry repeats.

<small>An example of testing `retry` using the array syntax.</small>

```ts twoslash
import { mockFetch } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
// First attempt fails, the retry succeeds:
http.get('/flaky', [{ status: 503 }, { json: { ok: true } }]);
```

If two routes match, the one registered **last** wins - so `http.any(...)` in a
setup file works as a fallback. Registering the same route again replaces it.

::: warning Reply with a status, not an `httpError()`
`httpError()` builds the error corgi _throws_ - use it in assertions. As a
reply it would skip corgi's own error handling (and retry), so `mockFetch`
rejects it. Reply `{ status: 503 }` and let corgi throw for real.
:::

## Testing a client you didn't create

Most apps create their client once, at module scope - a test can't pass `fetch`
into that. It doesn't need to: a client with no `fetch` of its own looks up
`globalThis.fetch` on **every call**, so make the mock the global with
`install()`:

```ts
// test-setup.ts
import { mockFetch } from '@itsy/corgi/testing';

export const http = mockFetch();

// Every client without its own fetch now hits the mock —
// including ones created before this line ran.
const restore = http.install();

// Wipe routes and recorded calls between tests.
afterEach(() => http.reset());

// Put the real fetch back when the suite is done.
afterAll(() => restore());
```

`install()` is `globalThis.fetch = http.fetch` with a receipt: it remembers
what was there and hands back a function that puts exactly that back — so the
stub can't leak into other suites when your runner shares one process. Calling
the restore twice is a no-op, and `reset()` never touches the global (routes
and calls are one lifecycle, global ownership another).

Plain `fetch(...)` calls in your code hit the mock too, and get recorded like
everything else. Since `reset()` clears routes, register them inside each test
or a `beforeEach`, not at module scope.

## Waiting for a request you can't await

Plenty of code starts a request and hands you nothing to await - a component
that fetches when it mounts, an event handler, anything fire-and-forget. The
usual workaround is to guess (`await new Promise((r) => setTimeout(r, 0))`),
which breaks the moment the request takes more than a tick.

`settled()` is the deterministic version: it resolves once every request the
mock started has finished, and nothing new started right after.

```ts twoslash
import { corgi } from '@itsy/corgi';
import { mockFetch } from '@itsy/corgi/testing';

const http = mockFetch();
const api = corgi.create({ fetch: http.fetch });

let name = '';
// Stands in for a component that fetches on mount and returns void:
const mount = () => {
  void api.get<{ name: string }>('/user').then((user) => {
    name = user.name;
  });
};
// ---cut---
http.get('/user', { json: { name: 'Ada' } });

mount(); // nothing to await here

await http.settled();
name; // 'Ada'
```

A response that kicks off the **next** request keeps `settled()` waiting, so a
chain of requests settles as one unit.

Follow-ups chained through promises, `queueMicrotask`, or one `setTimeout(0)`
hop are all caught; something scheduled with a **real delay**
(`setTimeout(50)`) is not - await that directly.

::: info Two things it won't wait for
`{ hang: true }` never finishes by design, so it's excluded - otherwise
`settled()` would deadlock in exactly the abort tests that need it.

A client **sleeping between retry attempts** is also invisible: that wait
happens inside `withRetry`, not in the transport, so with the default 300ms
backoff `settled()` can return after the first attempt. For those tests, await
the request directly, or use the
[1ms `Retry-After` lever](#keeping-retry-tests-fast).
:::

## Slow responses

`delay` answers after a wait - for testing loading states, spinners, and
"slower than X" UI without hand-rolling a timing fetch:

```ts twoslash
import { mockFetch } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
http.get('/report', { json: { rows: [] }, delay: 50 }); // headers+body after 50ms
```

`settled()` waits through the delay, and **aborting the request cancels the
wait** - a `withTimeout(10)` client rejects at ~10ms, not after the full delay.
That makes `{ delay }` the deterministic way to assert a request was _not_
cancelled, too: it resolves when nothing aborts it, on a schedule you chose.

For a **delayed failure**, compute the reply - the function form may be async:

```ts twoslash
import { mockFetch, networkError } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
http.get('/flaky', async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  return networkError(); // the wire dies, but only after 30ms
});
```

`{ hang: true }` stays the tool for "never answers" - a huge `delay` would
leave a real timer running; a hang costs nothing and exits via the request's
signal (or `reset()`).

## Asserting calls

`calls` and `lastCall` are the raw log. `callsTo(pattern, method?)` filters it
**with route semantics** - the pattern means exactly what it means in
`http.get(pattern, …)`, so you never re-implement path matching in a test:

```ts twoslash
import { corgi } from '@itsy/corgi';
import { mockFetch } from '@itsy/corgi/testing';

const http = mockFetch();
const api = corgi.create({ fetch: http.fetch, baseURL: 'https://api.test' });
http.any({ json: { ok: true } });
await api.post('/users', { body: { name: 'Ada' } });
// ---cut---
http.callsTo('/users').length; //          every method, any query, any origin
http.callsTo('/users', 'post').length; //  just the POSTs
http.callsTo('/users', 'POST')[0]?.json(); // -> { name: 'Ada' }
```

### Teardown hygiene

A typo'd route fails twice, silently: the route never serves, and the real
request matches nothing - and if the code under test swallows the rejection,
the test still passes. Two views catch both halves, so teardown can insist the
test used what it arranged:

```ts
afterEach(() => {
  // Map to strings so a failure prints 'GET /usres', not a Headers dump.
  assert.deepEqual(
    http.unmatchedCalls.map((c) => `${c.method} ${c.url}`),
    [],
  );
  assert.deepEqual(http.unusedRoutes, []);
  http.reset();
});
```

`unmatchedCalls` is the subset of `calls` that matched no route;
`unusedRoutes` lists registered routes that never answered (as `'GET /users'`
strings, in registration order). One caveat: an `any()` fallback registered in
a setup file may be _legitimately_ unused - filter `'ANY *'` out of the
assertion, or skip it in suites that register one.

## When nothing matches

The request rejects with an error named `'MockRouteError'` that lists the
routes you registered - and when a route matches the url under a **different
method**, it says so ("a GET route matches this url…"), since that's almost
always the actual mistake. It's deliberately not a fake 404 (corgi would wrap
that into a normal-looking `HttpError`) and not a `TypeError` (retry would
treat it as a flaky network and slowly retry it). If the code under test
swallows the error, `http.unmatchedCalls` still shows what it tried - see
[teardown hygiene](#teardown-hygiene).

## Keeping retry tests fast

Retry waits real time between attempts (~300ms and up). Cheapest option first:

1. Don't trigger it - reply 2xx, or a status retry ignores (400, 404).
2. If the test creates the client, turn the waiting off. With the plugin:
   `corgi.create({ plugins: [withRetry({ retries: 2, backoff: 0 })] })`, or on a
   [chonk](/guide/chonk) client: `corgi.create({ retry: { retries: 2, backoff: 0 } })`.
3. If it can't - a module-scope client with retry baked in - reply
   `{ status: 503, headers: { 'retry-after': '0.001' } }`. Corgi honors
   fractional `Retry-After` seconds, so each wait is 1ms.

## Aborts and timeouts

`{ hang: true }` is a request that never answers. The only way out is the
request's own abort signal (or `reset()`), and the caller sees the signal's own
reason — so an abort still looks like an abort, a timeout like a timeout:

```ts twoslash
import { corgi } from '@itsy/corgi/chonk';
import { isAbortError } from '@itsy/corgi';
import { mockFetch } from '@itsy/corgi/testing';

const http = mockFetch();
// ---cut---
// A search client that cancels its previous request when a new one starts:
const search = corgi.create({ fetch: http.fetch, abortPrevious: true });

http.get('/search', { hang: true }); // the first search will just sit there
const stale = search.get('/search', { query: { q: 'a' } }).catch((e: unknown) => e);

http.get('/search', { json: ['fresh'] }); // replace the hanging route
const fresh = await search.get('/search', { query: { q: 'ab' } }); // cancels the first

isAbortError(await stale); // true — cancelled with a real AbortError
```

::: info `reset()` rejects leftover hangs
They're rejected with `abortError()`. If your runner then reports an unhandled
rejection, some code fired a request and never did `.catch` - a real bug the
mock surfaced. To clear only the recorded calls mid-test, use `resetCalls()`.
:::

### Aborts after the headers

The signal still counts once the response is in, as with a real fetch: abort
before the body is fully read, and reading it rejects with the signal's reason.
A body that was already read (or cancelled) is unaffected. So plain replies are
enough to test that a plugin passes aborts on to the body, not just the headers:

```ts twoslash
import { corgi, isAbortError } from '@itsy/corgi';
import { mockFetch } from '@itsy/corgi/testing';

const http = mockFetch();
const api = corgi.create({ fetch: http.fetch });
// ---cut---
http.get('/report', { json: { rows: [] } });

const controller = new AbortController();
const res = await api.raw('/report', { signal: controller.signal });
controller.abort(); // after the headers, before the body was read

isAbortError(await res.json().catch((e: unknown) => e)); // true
```

## Fake errors that pass the guards

Corgi recognizes its errors by `name`, and hand-rolled fakes will miss important details:
a hand-made 404 `Response` has an empty `statusText` and `url`, and a
204 with a body throws. The factories get it right:

```ts twoslash
import { isHttpError } from '@itsy/corgi';
import { httpError } from '@itsy/corgi/testing';

// A real HttpError, no request needed — feed it to your error-handling code:
const err = httpError(503, { message: 'down' }, { url: '/status' });
err.message; //    'HTTP 503 Service Unavailable (/status)'
isHttpError(err); // true
```

::: tip Error helpers
There are fake error helpers for each of the error guards in Corgi - `httpError`, `abortError`, `timeoutError`, and `networkError`!

<small class="read-more">[Read more: the `/testing` API reference →](/api/testing)</small>
:::

## A complete example

Everything above in one file, with `node --test` as the runner and its hooks
driving the mock's lifecycle. The code under test is the usual worst case: a
module-scope client the test never constructs - exactly what `install()` is
for.

```ts
// user-service.ts — the code under test. A module-scope client, no fetch passed in:
import { corgi } from '@itsy/corgi';

const api = corgi.create({ baseURL: 'https://api.example.com' });

export const getUser = (id: number) => api.get<{ id: number; name: string }>(`/users/${id}`);
export const findUsers = (q: string) => api.get<string[]>('/users', { query: { q } });
```

```ts
// user-service.test.ts — run with: node --test
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { isHttpError } from '@itsy/corgi';
import { mockFetch } from '@itsy/corgi/testing';
import { getUser, findUsers } from './user-service.ts';

const http = mockFetch();
let restore: () => void;

// Take over the global before anything fetches. The module-scope client above
// looks up globalThis.fetch on every call, so it hits the mock from here on —
// even though it was created before this hook ran.
before(() => {
  restore = http.install();
});

// Routes are per-test state: wipe them, then register next to the assertions.
beforeEach(() => http.reset());

after(() => {
  http.reset(); // cancels any leftover { hang: true }
  restore(); // hands the real fetch back
});

test('getUser parses the profile', async () => {
  http.get('/users/1', { json: { id: 1, name: 'Ada' } });
  assert.deepEqual(await getUser(1), { id: 1, name: 'Ada' });
});

test('findUsers sends the query corgi built', async () => {
  http.get('/users', { json: [] });
  await findUsers('ada');
  assert.equal(http.lastCall?.query.get('q'), 'ada');
});

test('a 503 reaches the caller as a real HttpError', async () => {
  http.get('/users/1', { status: 503 });
  await assert.rejects(getUser(1), (err: unknown) => isHttpError(err));
});
```

`node --test` runs each test file in its own process by default, so even a
forgotten `restore()` couldn't leak into another suite - but the pairing keeps
the file correct under `--test-isolation=none`, watch mode, and any runner that
shares a process. Swap the hook imports and the same shape works in vitest or
jest; nothing in the mock knows which runner is driving.
