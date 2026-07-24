# API reference

Every public export, by entry point. Types are erased at build (zero runtime
bytes); values are the shipped code.

## Entry points

| import                                                     | exports                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [`@itsy/corgi`](#itsy-corgi)                               | `corgi`, `corgi`, `compose`, `order`, `ORDER`, `HttpError`, `isHttpError`, `isTimeoutError`, `isAbortError` + types |
| [`@itsy/corgi/timeout`](/api/plugins#withtimeout)          | `withTimeout` (2022-safe)                                                                                           |
| [`@itsy/corgi/timeout-modern`](/api/plugins#withtimeout)   | `withTimeout` (Baseline 2024)                                                                                       |
| [`@itsy/corgi/retry`](/api/plugins#withretry)              | `withRetry`, type `RetryOptions`                                                                                    |
| [`@itsy/corgi/abort-previous`](/api/plugins#abortprevious) | `abortPrevious`                                                                                                     |
| [`@itsy/corgi/schema`](/api/plugins#schema)                | `schema`, `parseWith`, `ValidationError`, `isValidationError`, type `StandardSchemaV1`                              |
| [`@itsy/corgi/chonk`](/guide/chonk)                        | enhanced `corgi` + `corgi`, `CorgiChonkOptions`, and re-exports of everything above                                 |

## `@itsy/corgi`

The root entry: the client, the composition engine, and errors.

- **[The Corgi](/api/corgi-interface)** — the callable + verb shortcuts + `raw`/`extend`.
- **[Options & types](/api/types)** — `RequestOptions`, `CorgiOptions`, `MappedResponse`, `ParseAs`, `Query`.
- **[Errors & guards](/api/errors)** — `HttpError` and the name-based guards.
- **[Composition engine](/api/composition)** — `compose`, `order`, `ORDER`, `Fetcher`, `Plugin`.

## Plugins (opt-in)

The middleware, each on its own import path:
**[Plugins reference →](/api/plugins)**
