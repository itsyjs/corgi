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
