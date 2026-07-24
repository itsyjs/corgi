# Errors & guards

## `HttpError`

Thrown by the client when a response has a non-2xx status (unless
`throwOnError: false`).

```ts
class HttpError extends Error {
  readonly name: 'HttpError';
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly response: Response; // a clone, taken before reading — still readable
  readonly data: unknown; //     best-effort parse of the error body
}
```

- `response` is a **clone** taken before the body was read, so
  `await err.response.text()` / `.json()` still works.
- `data` is a best-effort parse (JSON or text) of the error body — typed `unknown`
  because error shapes aren't known at compile time.

```ts twoslash
import { corgi, isHttpError } from '@itsy/corgi';
// ---cut---
try {
  await corgi.get('https://api.example.com/nope');
} catch (err) {
  if (isHttpError(err)) {
    console.error(err.status, err.data);
  }
}
```

## `isHttpError`

```ts
function isHttpError(error: unknown): error is HttpError;
```

Type guard for `HttpError`. Checked by **name**, not `instanceof`, so it stays
correct across iframes, web workers, and vm contexts, and duplicate bundled copies —
both cases where `instanceof` silently returns `false`.

## `isTimeoutError`

```ts
function isTimeoutError(error: unknown): boolean;
```

Did a request time out (as opposed to being cancelled by the caller)? A per-attempt
timeout aborts with a `DOMException` named `"TimeoutError"` — from either
[timeout implementation](/plugins/timeout). Name-based, not `instanceof`.

## `isAbortError`

```ts
function isAbortError(error: unknown): boolean;
```

Was a request aborted by the caller (or a superseding
[`abortPrevious`](/plugins/abort-previous) call)? Caller aborts use the name
`"AbortError"`.

```ts twoslash
import { isTimeoutError, isAbortError } from '@itsy/corgi';
declare const err: unknown;
// ---cut---
if (isTimeoutError(err)) {
  // deadline fired
} else if (isAbortError(err)) {
  // cancelled by the caller / superseded
}
```

## `ValidationError`

Thrown by [`schema()`](/api/plugins#schema) on a failed validation — distinct from
`HttpError` and network errors. See [schema](/plugins/schema#errors). Detect with
`isValidationError` (also name-based).
