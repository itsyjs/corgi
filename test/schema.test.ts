import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi } from '../src/index.ts';
import { schema, parseWith, isValidationError, type StandardSchemaV1 } from '../src/schema.ts';
import { json } from './helpers.ts';

// A minimal hand-rolled Standard Schema (what Zod/Valibot/ArkType produce). The
// type param drives InferOutput, so `schema(User)` returns Promise<{ id: number }>.
const User: StandardSchemaV1<unknown, { id: number }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) =>
      typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'number'
        ? { value: value as { id: number } }
        : { issues: [{ message: 'expected { id: number }' }] },
    types: undefined,
  },
};

suite('schema', () => {
  test('schema() transform validates and types the response', async () => {
    const api = corgi.create({ fetch: async () => json({ id: 5 }) });
    const user = await api.get('/u', { transform: schema(User) });
    assert.equal(user.id, 5);
  });

  test('schema() transform throws ValidationError on bad data', async () => {
    const api = corgi.create({ fetch: async () => json({ nope: true }) });
    await assert.rejects(
      () => api.get('/u', { transform: schema(User) }),
      (err: unknown) => isValidationError(err),
    );
  });

  test('parseWith works as a standalone .then() helper', async () => {
    const api = corgi.create({ fetch: async () => json({ id: 9 }) });
    const user = await parseWith(User, api.get('/u'));
    assert.equal(user.id, 9);
  });
});
