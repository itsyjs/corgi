# Plugins

The opt-in middleware, each on its own import path. Conceptual guides:
[Plugins overview](/plugins/) · [Write your own](/plugins/custom). Per-plugin:
[timeout](/plugins/timeout) · [retry](/plugins/retry) ·
[abort-previous](/plugins/abort-previous) · [schema](/plugins/schema).

## `withTimeout`

```ts
// @itsy/corgi/timeout          (hand-rolled, 2022-safe)
// @itsy/corgi/timeout-modern   (AbortSignal.any + AbortSignal.timeout, Baseline 2024)
function withTimeout(ms: number): Plugin;
```

Per-attempt deadline, tagged `ORDER.timeout`. Both modules export the same
signature and behaviour. `ms` of `0`/`Infinity` disables it. Detect with
[`isTimeoutError`](/api/errors#istimeouterror).

## `withRetry`

```ts
// @itsy/corgi/retry
function withRetry(options?: RetryOptions | number): Plugin;

interface RetryOptions {
  retries?: number; //   default 2 (up to 3 total tries)
  backoff?: number; //   base ms, default 300
  maxDelay?: number; //  default 10_000
  methods?: readonly string[]; //  default: the idempotent set
  statuses?: readonly number[]; // default: 408/429/500/502/503/504
  onRetry?: (info: { attempt: number; delay: number; error?: unknown; response?: Response }) => void;
}
```

A bare number is shorthand for `{ retries: n }`. Tagged `ORDER.retry`. Only retries
idempotent methods with replayable bodies. Full behaviour: [retry](/plugins/retry).

## `abortPrevious`

```ts
// @itsy/corgi/abort-previous
function abortPrevious(): Plugin;
```

Aborts the previous in-flight request when a new one starts. Tagged `ORDER.cancel`
(outermost). **Stateful** — keep it at the client level. Full behaviour:
[abort-previous](/plugins/abort-previous).

## `schema`

Not middleware, but a `transform`. Grouped here as an opt-in add-on.

```ts
// @itsy/corgi/schema
function schema<S extends StandardSchemaV1>(
  s: S,
): (value: unknown, response?: Response) => Promise<StandardSchemaV1.InferOutput<S>>;

function parseWith<S extends StandardSchemaV1>(s: S, input: Promise<unknown>): Promise<StandardSchemaV1.InferOutput<S>>;

class ValidationError extends Error {
  readonly name: 'ValidationError';
  readonly issues: readonly StandardSchemaV1.Issue[];
}

function isValidationError(error: unknown): error is ValidationError;
```

`schema(s)` returns a `transform` that validates the parsed value against any
[Standard Schema](https://standardschema.dev) validator and infers the output type.
`parseWith` is the standalone `.then()` form. Full behaviour:
[schema](/plugins/schema).
