# Corgi chonk

`@itsy/corgi/chonk` includes all plugins and features out of the box, it's ~2.5kb instead of 1.4kb.

<small>In chonk, plugin options are top-level attributes for convenience, so you can do the following.</small>

```ts twoslash
import { corgi } from '@itsy/corgi/chonk';

const api = corgi.create({
  baseURL: 'https://api.example.com',
  timeout: 5000, //        -> withTimeout(5000)
  retry: 3, //             -> withRetry(3)
  abortPrevious: true, //  -> abortPrevious()
});

await api.get('/users');
```

## Derived clients

<small>`extend` takes the same options as `create`, so it's trivial to create new versions per usecase!</small>

```ts twoslash
import { corgi } from '@itsy/corgi/chonk';

const api = corgi.create({ baseURL: 'https://api.example.com', retry: 3 });

// Inherits baseURL and retry, and cancels its own in-flight request on each keystroke:
const searchApi = api.extend({ abortPrevious: true });
```

Plugin options replace the parent's rather than combining — so
`api.extend({ timeout: 1000 })` gives you one timeout, not two, and `abortPrevious: false`
switches an inherited one off.

::: info Each client only cancels its own requests
`abortPrevious` never reaches across clients: when `searchApi` cancels its previous request, it
won't touch anything `api` has in flight. That's usually what you want — one client per search box
— but it also means a client extended _from_ `searchApi` won't cancel `searchApi`'s requests.
:::

<small class="read-more">[Read more: abortPrevious →](/plugins/abort-previous)</small>

## Validation with `schema`

<small>`schema` is re-exported from `/chonk`, so you can import it alongside everything
else.</small>

```ts
import { corgi, schema } from '@itsy/corgi/chonk';
import { z } from 'zod';

const api = corgi.create({ baseURL: 'https://api.example.com', retry: 3 });

const User = z.object({ id: z.number(), name: z.string() });

// `user` is typed `{ id: number; name: string }` AND validated at runtime:
const user = await api.get('/users/1', { transform: schema(User) });
```

<small class="read-more">[Read more: schema →](/plugins/schema)</small>
