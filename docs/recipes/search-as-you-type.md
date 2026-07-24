# Search-as-you-type

The classic typeahead problem: the user types fast, you fire a request per
keystroke, and responses come back **out of order** — so a stale result can
overwrite a newer one. [`abortPrevious`](/plugins/abort-previous) fixes it by
cancelling the previous in-flight request whenever a new one starts.

## The client

```ts twoslash
import { corgi, isAbortError } from '@itsy/corgi';
import { abortPrevious } from '@itsy/corgi/abort-previous';
import { withTimeout } from '@itsy/corgi/timeout';

interface Result {
  id: string;
  title: string;
}

const search = corgi.create({
  baseURL: 'https://api.example.com',
  plugins: [abortPrevious(), withTimeout(5000)],
});

async function runSearch(q: string): Promise<Result[] | undefined> {
  try {
    return await search.get<Result[]>('/search', { query: { q } });
  } catch (err) {
    // The superseded request rejects with an AbortError — that's expected, ignore it.
    if (isAbortError(err)) return undefined;
    throw err; // a real failure
  }
}
```

Every call to `runSearch` supersedes the last: the older request is aborted (its
promise rejects with `AbortError`), and only the most recent one can resolve. No
manual `AbortController` bookkeeping.

## Two things that matter

**Keep the client stable.** `abortPrevious` is stateful — it remembers the current
request in the pipeline built by `corgi`. Create the client **once** (module
scope in the browser, or per-user-session), not per keystroke, or there's no shared
state to cancel against.

**On a server, build it per request.** A shared module-scope client would let
unrelated users cancel each other. In a request handler:

```ts twoslash
import { corgi } from '@itsy/corgi';
import { abortPrevious } from '@itsy/corgi/abort-previous';
// ---cut---
function handler() {
  const search = corgi.create({ plugins: [abortPrevious()] }); // fresh per request
  // ...use search for this request only...
}
```
