# TypeScript

TypeScript is a first-class citizen. Every call resolves its return type by priority.

`transform` -> `responseType` -> `<T>`

## `<T>` generic

Specify a type for the response, default is `unknown`.

```ts twoslash
import { corgi } from '@itsy/corgi';

interface User {
  id: number;
  name: string;
}

const user = await corgi.get<User>('/users/1');
const raw = await corgi.get('/users/1');
```

::: info
This generic is only used when `responseType` is json-ish
:::

## `responseType`

Set `responseType` and the result type is fixed to the matching platform type.

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
const text = await corgi.get('/page', { responseType: 'text' });
const blob = await corgi.get('/img', { responseType: 'blob' });
const buf = await corgi.get('/bin', { responseType: 'arrayBuffer' });
const stream = await corgi.get('/feed', { responseType: 'stream' });
```

## `transform`

When you pass a `transform`, whatever it returns becomes the result type — it
will override both `responseType` and `<T>`.

```ts twoslash
import { corgi } from '@itsy/corgi';
// ---cut---
const count = await corgi.get('/users', { transform: (v) => (v as unknown[]).length });
```

## Runtime-validated types with `schema()`

`get<User>()` is an unchecked cast — you're promising the shape is right. The
[`schema`](/plugins/schema) plugin turns that promise into a runtime guarantee
using any [Standard Schema](https://standardschema.dev) validator (Zod, Valibot,
ArkType, etc.), and infers the output type from the schema.

```ts
import { corgi } from '@itsy/corgi';
import { schema } from '@itsy/corgi/schema';
import { z } from 'zod';

const User = z.object({ id: z.number(), name: z.string() });

// Validated at runtime AND typed from the schema — `user` is `{ id: number; name: string }`:
const user = await corgi.get('/users/1', { transform: schema(User) });
```

## Options & result types

The full option and result types (`RequestOptions`, `CorgiOptions`, `Call`,
`MappedResponse`, …) are documented in the [API reference](/api/types).
