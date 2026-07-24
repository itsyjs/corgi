# Library size

The root import (`@itsy/corgi` → `corgi`) is **~1.4 KB gzipped**.

That makes it the second-smallest of the popular options while being the most footgun-guarded.

| library         | ~gzip       | throws on non-2xx | [body passthrough](#body-passthrough) | empty-JSON safe      | timeout    | compose engine |
| --------------- | ----------- | ----------------- | ------------------------------------- | -------------------- | ---------- | -------------- |
| redaxios        | ~1 KB       | yes               | partial (corrupts binary/stream)      | yes                  | none       | no             |
| **@itsy/corgi** | **~1.4 KB** | **yes**           | **full**                              | **yes**              | **opt-in** | **yes**        |
| wretch          | ~2 KB       | yes               | partial                               | no (throws on empty) | opt-in     | chainable      |
| ky              | ~4 KB       | yes               | explicit `json:`                      | no (throws on empty) | yes        | hooks          |
| ofetch          | ~6 KB+      | yes               | full                                  | yes                  | native     | interceptors   |
| native `fetch`  | 0           | **no**            | (manual)                              | **no**               | manual     | no             |

## Where the ~1.4 KB goes

Approximate share of the always-shipped client.

| cluster      | ~share | what it does                                                                                                        |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `corgi.ts`   | ~35%   | the client: build URL/query/body/headers, run the pipeline, parse, throw, transform, verb shortcuts, `extend`/`raw` |
| `parse.ts`   | ~17%   | turn a `Response` into a value without the classic parse footguns                                                   |
| `url.ts`     | ~14%   | base-URL join + query-string merge that don't silently corrupt                                                      |
| `error.ts`   | ~12%   | `HttpError` + error guards                                                                                          |
| `body.ts`    | ~7%    | serialize a body without clobbering FormData/binary/stream                                                          |
| `core.ts`    | ~6%    | the compose engine (shared chunk)                                                                                   |
| `headers.ts` | ~3%    | case-insensitive header merge                                                                                       |
| scaffolding  | ~6%    | import/export wiring                                                                                                |

Run `pnpm size` for exact per-export gzip budgets, or `pnpm size:exports` for the
full per-export breakdown of the root import.

## The footgun catalog

> (This section was heavily AI written)

Each entry: **the trap → the exact failure → what @itsy/corgi does.** Source
files carry the same notes inline.

### 1. Native `fetch` resolves on 404/500 — `error.ts`

`fetch` only rejects on network failure; a 500 is a _successful_ promise. You
must remember `if (!res.ok)` on every call.

- **@itsy/corgi:** Corgi throws `HttpError` on any non-2xx,
  with `err.status`, a best-effort parsed `err.data`, and a re-readable
  `err.response` (cloned before the body was read). Opt out per-call with
  `throwOnError: false`, or use `.raw()` for the untouched `Response`.

### 2. `new URL(path, base)` silently drops the base path — `url.ts`

```js
new URL('/users', 'https://api.com/v1'); // → https://api.com/users  (the /v1 is GONE)
new URL('users', 'https://api.com/v1'); // → https://api.com/users  (drops last segment too)
new URL('users', '/api'); // → THROWS (relative base)
```

- **@itsy/corgi:** `joinURL` does a real prefix-join that preserves the base path,
  supports relative bases, and lets an absolute/protocol-relative URL override.

### 3. `res.json()` throws on an empty body — `parse.ts`

A 200/204 with `content-type: application/json` and an empty body (common on
`DELETE` / empty `POST`) makes `res.json()` throw _"Unexpected end of JSON input"_.

- **@itsy/corgi:** reads text first and returns `undefined` for an empty body.

### 4. Guessing JSON blows up on HTML error pages — `parse.ts`

"Smart" parsers assume JSON and then explode on an nginx/Cloudflare HTML 502.

- **@itsy/corgi:** unknown/`text/*` content types return text (never guessed as
  JSON); binary types return a `Blob`. Also short-circuits `204/205/304` and
  `HEAD` (no body to read), and matches `+json` suffixes like
  `application/problem+json` (RFC 7807) and `application/vnd.api+json`.

### 5. JSON-stringifying a body destroys FormData / binary — `body.ts` {#body-passthrough}

`JSON.stringify(new FormData())` is `"{}"` and **wipes the multipart boundary** —
your upload silently sends nothing. Same class of bug for `Blob`, `ArrayBuffer`,
typed arrays, and `ReadableStream`.

- **@itsy/corgi:** only plain objects/arrays are JSON-encoded; every real
  `BodyInit` passes through untouched (and streams get `duplex: 'half'`, which
  Node/undici require or they throw).

This is the **body passthrough** column in the table up top, and it matters
because the failure is _silent_: the request goes out looking fine and sends
garbage — a corrupted upload, a mangled binary payload, an empty stream — with no
error to tell you. **Full** passthrough (us and ofetch) means every real
`BodyInit` — `FormData`, `URLSearchParams`, `Blob`/`File`, `ArrayBuffer`, typed
arrays, `DataView`, `ReadableStream` — is sent exactly as you passed it, and only
plain objects/arrays are JSON-encoded. **Partial** means the library
`JSON.stringify`s any body it doesn't special-case, and grows its list of
exceptions reactively. [redaxios][redaxios-body] stopped stringifying `FormData`
after [#28][rx-formdata] and `Blob` after [#70][rx-blob], so today it keeps
anything with an `.append` method (`FormData`, `URLSearchParams`) or a `.text`
method (`Blob`, `File`) — but `ArrayBuffer`, typed arrays, `DataView`, and
`ReadableStream` were never added and still fall through to `"{}"` / `{"0":…}`
(no bug filed for them at the time of writing). That per-type patching _is_ what
"partial" means: whatever body type nobody has reported yet is a silent footgun.
wretch is the same class of issue; ky sidesteps it by making you opt into JSON
with an explicit `json:` key.

[redaxios-body]: https://github.com/developit/redaxios/blob/1c18883bdb2bd44e1467ffeb8743061c1f6478d1/src/index.js#L173-L176
[rx-formdata]: https://github.com/developit/redaxios/issues/28
[rx-blob]: https://github.com/developit/redaxios/pull/70

### 6. Object spread can't merge headers — `headers.ts`

`{ 'Content-Type': a }` and `{ 'content-type': b }` are two different keys to a
plain object, so both get sent.

- **@itsy/corgi:** routes every source through `Headers`, collapsing
  case-insensitively (last source wins).

### 7. `instanceof` lies across iframes, workers, and duplicate copies — `error.ts`

`instanceof` silently returns `false` when the error came from another context
(an iframe, web worker, or vm) or a second bundled copy of the library.

- **@itsy/corgi:** `isHttpError` / `isTimeoutError` / `isAbortError` check the
  error _name_, so they stay correct everywhere. (axios uses a flag for the same
  reason.)

### 8. Detached `fetch` throws on Cloudflare Workers — `core.ts`

`const f = globalThis.fetch; f(url)` throws _"Illegal invocation"_ on Workers
(the receiver is brand-checked). Hides in dev, bites in prod.

- **@itsy/corgi:** calls the global through an arrow so the receiver stays
  correct on every runtime.

### 9. Timeouts, done right — `timeout.ts` / `timeout-modern.ts`

A naive timeout plugin that replaces `init.signal` orphans the caller's signal
(so `abortPrevious` and total-budget `AbortSignal.timeout` stop working) and leaks
a timer per request.

- **@itsy/corgi:** forwards the caller's abort (preserving its reason so a
  user-cancel stays `AbortError` and a timeout stays `TimeoutError`) and cleans up
  the timer + listener on settle. Two implementations, same behaviour: the
  hand-rolled `/timeout` (2022-safe floor) and the smaller `/timeout-modern`
  (`AbortSignal.any` + `AbortSignal.timeout`, Baseline-2024 runtimes).
