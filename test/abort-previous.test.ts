import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isAbortError } from '../src/index.ts';
import { abortPrevious } from '../src/abort-previous.ts';
import { mockFetch } from '../src/testing.ts';

suite('abortPrevious', () => {
  test('a new call aborts the previous in-flight one', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [abortPrevious()], fetch: http.fetch });
    http.get('/a', { hang: true }); // the first call just sits there…
    http.get('/b', { json: 'ok' }); // …until the second supersedes it

    const first = api.raw('/a');
    const firstRejects = assert.rejects(first, (err: unknown) => isAbortError(err));

    const second = await api.raw('/b'); // resolves normally
    assert.equal(second.status, 200);

    await firstRejects;
  });

  test('a completed call does not abort the next one', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [abortPrevious()], fetch: http.fetch });
    http.get('/a', { json: { n: 1 } });
    http.get('/b', { json: { n: 2 } });

    assert.deepEqual(await api.get('/a'), { n: 1 });
    assert.deepEqual(await api.get('/b'), { n: 2 });
    assert.equal(http.calls.length, 2);
  });

  test("a caller's own signal still aborts the request (signal is merged, not dropped)", async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [abortPrevious()], fetch: http.fetch });
    http.get('/x', { hang: true });
    const controller = new AbortController();
    const pending = api.raw('/x', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err));
    http.reset();
  });
});
