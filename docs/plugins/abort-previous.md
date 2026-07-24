# abort-previous

The classic **search-as-you-type** primitive: whenever a new request starts, the
previous in-flight one (from the same client) is aborted. (Being stateful, it's
client-level — see the [Plugins overview](/plugins/) for how plugins are applied.)

```ts twoslash
import { corgi } from '@itsy/corgi';
import { abortPrevious } from '@itsy/corgi/abort-previous';

const search = corgi.create({ plugins: [abortPrevious()] });

// Each keystroke supersedes the last; the abandoned request rejects with AbortError.
async function onType(q: string) {
  try {
    return await search.get('/search', { query: { q } });
  } catch (err) {
    // In typeahead you normally ignore the expected AbortError.
  }
}
```

## How it works

- Tagged `ORDER.cancel` (the outermost slot), so a superseding call cancels the
  **entire** prior chain — including any retries or timeout it had running.
- Keyless by design: **one plugin instance == one logical stream** (e.g. one
  search box). Create separate clients for separate streams.
- A fresh `AbortController` is minted per call, so cancellation keeps working
  indefinitely (unlike reusing a single controller, which stays "aborted" forever
  after the first cancel).
- The caller's own `signal` is merged in, so your own aborts still work.

## It's stateful — keep it client-level

`abortPrevious` stores the current request in a closure created when the client's
pipeline is built. That's why it **must** live at the client level:

```ts twoslash
import { corgi } from '@itsy/corgi';
import { abortPrevious } from '@itsy/corgi/abort-previous';
import { withTimeout } from '@itsy/corgi/timeout';
// ---cut---
const search = corgi.create({ plugins: [abortPrevious(), withTimeout(5000)] });
```

::: warning On the server
Because it holds state, build the client **per request** on a server — never share
one at module scope, or unrelated requests would cancel each other.
:::
