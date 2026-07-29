# schema

Runtime validation via [Standard Schema](https://standardschema.dev), the
vendor-neutral interface implemented by Zod 3.24+, Valibot, ArkType, and others.
`schema()` turns the `<T>` cast into a real guarantee.

`@itsy/corgi/schema` depends only on the Standard Schema _type_ (inlined), so it
stays zero-dependency. The actual validator is whatever library you already use.

## `schema()` as a transform

`schema(MySchema)` returns a `transform`, use it directly with a request.

```ts
import { corgi } from '@itsy/corgi';
import { schema } from '@itsy/corgi/schema';
import { z } from 'zod';

const User = z.object({ id: z.number(), name: z.string() });

// `user` is typed `{ id: number; name: string }` AND validated at runtime:
const user = await corgi.get('/users/1', { transform: schema(User) });
```

::: info Return type comes from the schema
Because `transform` drives the return type, no generic is needed — the type comes
from the schema.
:::

## Errors

A failed validation throws a `ValidationError` carrying the validator's `issues`,
distinct from [`HttpError`](/api/errors) and network errors.

```ts twoslash
import { isValidationError } from '@itsy/corgi/schema';
declare const err: unknown;
// ---cut---
if (isValidationError(err)) {
  for (const issue of err.issues) {
    console.warn(issue.message, issue.path);
  }
}
```

## Any Standard Schema validator works

```ts
// Zod, Valibot, ArkType all expose the same `~standard` contract:
import * as v from 'valibot';
import { corgi } from '@itsy/corgi';
import { schema } from '@itsy/corgi/schema';

const User = v.object({ id: v.number(), name: v.string() });
await corgi.get('/users/1', { transform: schema(User) });
```

## `parseWith()` — the `.then()` style

If you'd rather not use the `transform` option.

```ts
import { corgi } from '@itsy/corgi';
import { parseWith } from '@itsy/corgi/schema';
import { z } from 'zod';

const User = z.object({ id: z.number(), name: z.string() });

const user = await parseWith(User, corgi.get('/users/1'));
```
