# Error handling

Native `fetch` resolves on 404/500 — you have to remember to check. The client
flips that: a non-2xx response **throws** by default, so your happy path stays
clean and failures are explicit.

## The default: throw on non-2xx

```ts twoslash
import { corgi, isHttpError } from '@itsy/corgi';

try {
  const user = await corgi.get('/users/1');
} catch (err) {
  if (isHttpError(err)) {
    err.status; //     e.g. 404
    err.statusText; // e.g. 'Not Found'
    err.url; //        the request URL
    err.data; //       best-effort parsed error body (unknown)
  }
}
```

`err.data` is a best-effort parse of the error body (JSON or text). `err.response`
is a **clone** taken before the body was read, so it's still fully readable:

```ts twoslash
import { corgi, isHttpError } from '@itsy/corgi';
// ---cut---
try {
  await corgi.get('/users/1');
} catch (err) {
  if (isHttpError(err)) {
    const body = await err.response.json(); // still works — response was cloned
  }
}
```

## Branch on status

```ts twoslash
import { corgi, isHttpError } from '@itsy/corgi';
// ---cut---
try {
  await corgi.post('/orders', { body: { sku: 'abc' } });
} catch (err) {
  if (!isHttpError(err)) throw err; // network/other — rethrow
  if (err.status === 401) {
    /* redirect to login */
  } else if (err.status === 422) {
    const problems = err.data; // validation details from the server
  } else if (err.status >= 500) {
    /* show "try again later" */
  }
}
```

## Timeouts vs cancellations

The guards are **name-based**, so they stay correct across iframes, web workers, and
vm contexts, and duplicate bundled copies — where `instanceof` silently returns `false`:

```ts twoslash
import { isTimeoutError, isAbortError } from '@itsy/corgi';
declare const err: unknown;
// ---cut---
if (isTimeoutError(err)) {
  // a per-attempt timeout fired
} else if (isAbortError(err)) {
  // the caller (or a superseding abortPrevious) cancelled
}
```

## Not every failure should throw

Two escape hatches:

**`throwOnError: false`** — get the parsed body even on non-2xx (per call):

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
const data = await api.get('/maybe', { throwOnError: false });
```

**`.raw()`** — the untouched `Response`, no parsing and no throwing. Best for
streaming, manual status handling, or reading headers:

```ts twoslash
import { corgi } from '@itsy/corgi';
const api = corgi.create();
// ---cut---
const res = await api.raw('/download');
if (res.status === 206) {
  /* partial content */
}
```

## Validation errors

If you validate responses with [`schema`](/plugins/schema), a bad payload throws a
`ValidationError` — distinct from `HttpError` (bad status) and network errors — so
you can branch on it:

```ts twoslash
import { isValidationError } from '@itsy/corgi/schema';
declare const err: unknown;
// ---cut---
if (isValidationError(err)) {
  for (const issue of err.issues) console.warn(issue.message, issue.path);
}
```

See the [errors reference](/api/errors) for the full `HttpError` shape.
