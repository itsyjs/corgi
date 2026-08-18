# Testing

Everything exported at `@itsy/corgi/testing`: a fake `fetch` for tests, plus
four helpers that build the errors Corgi produces. For a usage walkthrough, see
[the testing guide](/guide/testing).

## `mockFetch`

```ts
// @itsy/corgi/testing
function mockFetch(): MockFetch;

interface MockFetch {
  readonly fetch: typeof fetch;
  install(): () => void;
  on(method: string, pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  get(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  post(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  put(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  patch(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  delete(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  head(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  any(reply: MockReply | MockReply[]): MockFetch;
  readonly calls: readonly MockCall[];
  readonly lastCall: MockCall | undefined;
  callsTo(pattern: MockPattern, method?: string): readonly MockCall[];
  readonly unmatchedCalls: readonly MockCall[];
  readonly unusedRoutes: readonly string[];
  settled(): Promise<void>;
  reset(): void;
  resetCalls(): void;
}
```

- **`fetch`** — the fake itself. Pass it to `corgi.create({ fetch: http.fetch })`,
  or make it the global via `install()` to reach clients your test didn't
  create. Takes a string, `URL`, or `Request`, like real fetch.
- **`install()`** — sets `globalThis.fetch = http.fetch` and returns a restore
  function that puts back exactly what was there (including "nothing").
  Installing again while installed returns the same restore; restoring twice is
  a no-op; two mocks nest LIFO. `reset()` never touches the global.
- **`get` / `post` / `put` / `patch` / `delete` / `head`** — register a route:
  "a GET matching this pattern answers with this reply". `on(method, …)` for
  anything else.
- **`any(reply)`** — matches every request. Register it first, as a fallback.
- **`calls` / `lastCall`** — every request received, oldest first — including
  ones that matched no route.
- **`callsTo(pattern, method?)`** — the recorded calls a pattern matches, with
  the exact semantics patterns have at registration (string → path, RegExp →
  raw url, function → full `MockCall`; `:id`/`*` throw here too). `method` is
  any-case; omitted matches all. A fresh snapshot, unlike the live `calls`.
- **`unmatchedCalls`** — the subset of `calls` (same objects) that matched no
  route and rejected with `'MockRouteError'`. A request whose signal was
  already aborted is not here — it rejected before matching. Cleared with the
  log.
- **`unusedRoutes`** — routes never dispatched, as `'GET /users'`-style strings
  in registration order. An `any()` fallback may be legitimately unused, and a
  re-registered route counts as unused again (the replacement never served).
  Pairs with `unmatchedCalls` for
  [teardown hygiene](/guide/testing#teardown-hygiene).
- **`settled()`** — resolves once every request the mock started has finished
  and nothing new started right after. For code that fires a request you can't
  await; a request that triggers the next one keeps it waiting — through
  promise chains, `queueMicrotask`, or one `setTimeout(0)` hop (real delays are
  not chased). It skips `{ hang: true }` (which never finishes) and can't see a
  client sleeping between retry attempts — see
  [waiting for a request you can't await](/guide/testing#waiting-for-a-request-you-can-t-await).
- **`reset()`** — for `afterEach`: forgets routes and calls, and cancels any
  `{ hang: true }` requests still waiting. The cancellation is an `abortError()`
  whose message explains itself, since it usually surfaces from a teardown hook.
  Does not undo `install()` — the restore function owns the global.
- **`resetCalls()`** — clears only the recorded calls (and with them
  `unmatchedCalls`).

The last-registered matching route wins, and re-registering a pattern replaces
it. An unmatched request rejects with an error named `'MockRouteError'` that
lists your routes — deliberately not a 404 (Corgi would wrap it into a
normal-looking `HttpError`) and not a `TypeError` (retry would retry it).

## `MockPattern`

```ts
type MockPattern = string | RegExp | ((call: MockCall) => boolean);
```

- **A string** matches the request **path** exactly, ignoring origin and query.
  With `://` in it, it matches origin + path instead. `:id` segments and a
  trailing `*` throw — they aren't supported, and matching them as literal text
  would be worse.
- **A RegExp** tests the whole url — for dynamic paths like `/\/users\/\d+$/`.
- **A function** gets the full [`MockCall`](#mockcall) — match on query,
  headers, or body.

## `MockReply`

```ts
type MockReply =
  | { json: unknown; status?: number; headers?: HeadersInit; delay?: number }
  | { text: string; status?: number; headers?: HeadersInit; delay?: number }
  | { status: number; body?: BodyInit | null; headers?: HeadersInit; delay?: number }
  | { hang: true }
  | Response
  | Error
  | ((call: MockCall) => MockReply | Promise<MockReply>);
```

- **`{ json }`** — a 200 with a JSON body (`content-type` set for you).
- **`{ text }`** — a 200 with a plain-text body.
- **`{ status }`** — any status, optional raw body. `statusText` is filled in
  (`404` gets `'Not Found'`).
- **`delay`** — milliseconds to wait before answering (validated at
  registration; `0` means none). `settled()` waits through it, and aborting the
  request cancels the wait. Not on `Response`/`Error` replies — for a delayed
  failure use an async function reply; see
  [slow responses](/guide/testing#slow-responses).
- **`{ hang: true }`** — never answers; only the request's abort signal (or
  `reset()`) ends it.
- **A `Response`** — each request gets a fresh copy, so one `Response` can
  safely answer many requests (and survive retry, which discards and cancels
  the responses it throws away). Registering one whose body you already read
  throws, since there's nothing left to copy — build a fresh one, or use a
  function reply.
- **An `Error`** — the request rejects with it.
- **A function** — computes any of the above per request, sync or async.

An **array** answers in order, and the last entry repeats forever —
`[{ status: 503 }, { json: ok }]` is the shape for retry tests. An `HttpError`
is refused as a reply; see [the warning below](#httperror).

## `MockCall`

```ts
interface MockCall {
  method: string; //          upper-cased; 'GET' when unspecified
  url: string; //             exactly what Corgi requested — often a relative path
  pathname: string; //        just the path — parsed for you, works for relative urls
  query: URLSearchParams; //  just the query — same
  headers: Headers;
  body: string | null; //     the string body, if there was one
  json<T = unknown>(): T; //  parse `body` as JSON (throws a clear error if it can't)
  init: RequestInit; //       the raw options fetch was called with
  request?: Request; //       set when fetch was called with a Request object
}
```

One received request. `url` is untouched (often relative, like
`/users?page=2`); `pathname` and `query` are parsed out for easy asserting.
String bodies land in `body`; a `FormData`, `Blob`, or stream stays on
`init.body`.

## Error factories

Corgi recognizes its errors by `name`, and hand-built fakes get the details
wrong. These four make the real thing:

### `httpError`

```ts
function httpError<T = unknown>(
  status: number,
  data?: T,
  init?: { statusText?: string; url?: string; headers?: HeadersInit },
): HttpError<T>;
```

The error a Corgi request throws when the server answers 4xx/5xx. Use it to
test code that _handles_ those errors — an error mapper, a fallback UI, a
logger — without making any request:

```ts twoslash
import { httpError } from '@itsy/corgi/testing';

const err = httpError(404, { error: 'no such user' }, { url: '/users/9' });
err.message; // 'HTTP 404 Not Found (/users/9)'
err.data; //    { error: 'no such user' }
```

`statusText` comes from the status table, `data` becomes both `err.data` and a
readable `err.response` body, and `init.url` sets `err.url`. A hand-made
`Response` gets all three wrong — empty `statusText`, empty `url`, message
rendering as `HTTP 404  ()`.

::: warning Not a valid reply
`mockFetch` plays the network, and a network returns _responses_ — the
`HttpError` is created by Corgi afterwards, from the error status. A ready-made
`HttpError` as a reply would skip that step (and retry's decisions), so
registering one throws. Answer with the status instead:

```ts twoslash
import { mockFetch } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
// http.get('/users/9', httpError(404));  <- throws at registration

// Reply with the response; Corgi builds and throws the HttpError itself:
http.get('/users/9', { status: 404, json: { error: 'no such user' } });
```

:::

### `networkError`

```ts
function networkError(message?: string): TypeError; // default message: 'fetch failed'
```

The error `fetch` itself throws when the network fails — DNS error, connection
refused, offline. Use it as a reply to simulate exactly that:

```ts twoslash
import { corgi } from '@itsy/corgi/chonk';
import { mockFetch, networkError } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
const api = corgi.create({ fetch: http.fetch, retry: 1 });

// The network dies once, then recovers — retry carries the request through:
http.get('/users', [networkError(), { json: [] }]);
const users = await api.get('/users');
```

The default message (`'fetch failed'`) is the one real failures carry — retry
reads it to tell network failures from programming mistakes, so an invented
message can quietly stop your test from retrying.

### `abortError`

```ts
function abortError(message?: string): DOMException; // name: 'AbortError'
```

The error a cancelled request rejects with — what `AbortController.abort()`
produces and `isAbortError` checks for:

```ts twoslash
import { mockFetch, abortError } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
// Reject the request as a cancellation — does your code stay quiet,
// or does it log a scary error for a request it cancelled itself?
http.get('/search', abortError());
```

### `timeoutError`

```ts
function timeoutError(message?: string): DOMException; // name: 'TimeoutError'
```

The same, for deadlines — what `withTimeout` and `AbortSignal.timeout()`
produce and `isTimeoutError` checks for:

```ts twoslash
import { isTimeoutError } from '@itsy/corgi';
import { mockFetch, timeoutError } from '@itsy/corgi/testing';
const http = mockFetch();
// ---cut---
http.get('/slow', { hang: true }); // never answers on its own

const controller = new AbortController();
const pending = http.fetch('/slow', { signal: controller.signal });

controller.abort(timeoutError()); // end it AS a timeout, deterministically
isTimeoutError(await pending.catch((e: unknown) => e)); // true
```

<small class="read-more">[Read more: the testing guide →](/guide/testing)</small>
