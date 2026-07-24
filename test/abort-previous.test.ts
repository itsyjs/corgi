import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isAbortError } from '../src/index.ts';
import { abortPrevious } from '../src/abort-previous.ts';
import { slow, json } from './helpers.ts';

suite('abortPrevious', () => {
  test('a new call aborts the previous in-flight one', async () => {
    const api = corgi.create({ plugins: [abortPrevious()], fetch: slow });

    const first = api.raw('/a');
    const firstRejects = assert.rejects(first, (err: unknown) => isAbortError(err));

    // Second call supersedes the first; keep it from resolving/rejecting loudly.
    const second = api.raw('/b');
    second.catch(() => {});

    await firstRejects;
  });

  test('a completed call does not abort the next one', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [abortPrevious()],
      fetch: async () => {
        calls++;
        return json({ n: calls });
      },
    });

    assert.deepEqual(await api.get('/a'), { n: 1 });
    assert.deepEqual(await api.get('/b'), { n: 2 });
  });

  test("a caller's own signal still aborts the request (signal is merged, not dropped)", async () => {
    const api = corgi.create({ plugins: [abortPrevious()], fetch: slow });
    const controller = new AbortController();
    const pending = api.raw('/x', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err));
  });
});
