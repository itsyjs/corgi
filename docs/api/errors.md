# Errors & guards

## `HttpError`

Thrown by the client when a response has a non-2xx status (unless
`throwOnError: false`).

```ts
class HttpError<T = unknown> extends Error {
  readonly name: 'HttpError';
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly response: Response; // a clone, taken before reading — still readable
  readonly data: T; //           best-effort parse of the error body
}
```

- `response` is a clone taken before the body was read, so
  `await err.response.text()` / `.json()` still works.
- `data` is a best-effort parse (JSON or text) of the error body. It's `unknown` by
  default since error shapes aren't known at compile time, but the class is generic:
  name the payload via the guard to type it without a cast (see below).

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
function isHttpError<T = unknown>(error: unknown): error is HttpError<T>;
```

Type guard for `HttpError`, checked by name rather than `instanceof`
([why](/guide/responses#error-guards)).

Name the error payload to type `err.data` with no cast. The type argument is an
unchecked assertion (the guard only verifies it's an `HttpError`), so pass the
shape you know the endpoint returns:

```ts twoslash
import { corgi, isHttpError } from '@itsy/corgi';
interface ApiError {
  code: string;
  message: string;
}
// ---cut---
try {
  await corgi.get('https://api.example.com/users/1');
} catch (err) {
  if (isHttpError<ApiError>(err)) {
    err.data.code;
    //       ^?
  }
}
```

## `isTimeoutError`

```ts
function isTimeoutError(error: unknown): boolean;
```

True when a deadline fired, from either [timeout implementation](/plugins/timeout)
or an `AbortSignal.timeout`. Both abort with a `DOMException` named
`"TimeoutError"`. Name-based, not `instanceof`.

## `isAbortError`

```ts
function isAbortError(error: unknown): boolean;
```

True when the caller cancelled, or an [`abortPrevious`](/plugins/abort-previous)
call superseded this one. Caller aborts use the name `"AbortError"`.

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

Thrown by [`schema()`](/api/plugins#schema) on a failed validation, distinct from
`HttpError` and network errors. See [schema](/plugins/schema#errors). Detect with
`isValidationError` (also name-based).
