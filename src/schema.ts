/**
 * schema.ts — runtime validation via Standard Schema, at "@itsy/corgi/schema".
 *
 * This module shows off the client's generic `transform` hook: `schema(MySchema)`
 * returns a transform, so `client.get(url, { transform: schema(User) })` both
 * *validates at runtime* and *infers the return type* — turning `<T>` from an
 * unchecked cast into a real guarantee.
 *
 * Standard Schema (https://standardschema.dev) is a vendor-neutral interface
 * implemented by Zod 3.24+, Valibot, ArkType, and others. We depend only on its
 * TYPE — inlined below — so this stays zero-dependency; the actual validator is
 * whatever library you already use.
 */

/* -------------------------------------------------------------------------- */
/* Inlined Standard Schema v1 spec (types only — erased at build).            */
/* Mirrors @standard-schema/spec so any conforming validator works.          */
/* -------------------------------------------------------------------------- */

/** A schema exposing the `~standard` contract (Zod/Valibot/ArkType/etc.). */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}

export declare namespace StandardSchemaV1 {
  /** The properties the spec requires under the `~standard` key. */
  export interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => Result<Output> | Promise<Result<Output>>;
    readonly types?: Types<Input, Output> | undefined;
  }
  export type Result<Output> = SuccessResult<Output> | FailureResult;
  export interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  export interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  export interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  export interface PathSegment {
    readonly key: PropertyKey;
  }
  export interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];
  export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];
}

/* -------------------------------------------------------------------------- */

/**
 * Thrown when a response fails schema validation. Distinct from `HttpError`
 * (bad status) and network errors, so callers can branch on it. Carries the
 * validator's `issues` for reporting.
 */
export class ValidationError extends Error {
  override readonly name = 'ValidationError';
  readonly issues: readonly StandardSchemaV1.Issue[];

  constructor(issues: readonly StandardSchemaV1.Issue[]) {
    super(issues[0]?.message ?? 'Response failed schema validation');
    this.issues = issues;
  }
}

/** Is this a {@link ValidationError}? Name-based, not `instanceof`. */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof Error && error.name === 'ValidationError';
}

/**
 * Build a `transform` that validates the parsed value against a Standard Schema,
 * returning the schema's inferred output type (and throwing {@link ValidationError}
 * on failure). Drop it straight into a request:
 *
 *   import { z } from 'zod'
 *   import { schema } from '@itsy/corgi/schema'
 *
 *   const User = z.object({ id: z.number(), name: z.string() })
 *   const user = await api.get('/users/1', { transform: schema(User) }) // typed + validated
 *
 * The returned function matches the client's `transform` signature exactly
 * (`(value, response?) => Promise<Output>`); the response argument is accepted
 * but unused here.
 */
export function schema<S extends StandardSchemaV1>(
  s: S,
): (value: unknown, response?: Response) => Promise<StandardSchemaV1.InferOutput<S>> {
  return async (value) => {
    // `validate` may be sync or async; `await` handles both uniformly.
    const result = await s['~standard'].validate(value);
    if (result.issues) throw new ValidationError(result.issues);
    return result.value;
  };
}

/**
 * Standalone convenience for the `.then()` style, when you'd rather not use the
 * `transform` option (this path costs zero client bytes):
 *
 *   const user = await parseWith(User, api.get('/users/1'))
 */
export function parseWith<S extends StandardSchemaV1>(
  s: S,
  input: Promise<unknown>,
): Promise<StandardSchemaV1.InferOutput<S>> {
  return input.then(schema(s));
}
