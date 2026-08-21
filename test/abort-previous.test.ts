import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isAbortError } from '#index';
import { abortPrevious } from '#abort-previous';
import { withRetry } from '#retry';
import { withTimeout } from '#timeout';
import { mockFetch } from '#testing';

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

  test('a supersede kills the whole retry loop, not just the current attempt', async () => {
    // The reason `cancel` (100) sits OUTSIDE retry (300): aborting has to take
    // out the retries the superseded call still had queued, or a dead search
    // keeps hammering the server long after the user typed the next character.
    const http = mockFetch();
    http.get('/a', [{ status: 503 }, { status: 503 }, { json: { late: true } }]);
    http.get('/b', { json: { ok: true } });
    const api = corgi.create({
      plugins: [abortPrevious(), withRetry({ retries: 5, backoff: 30, maxDelay: 60 })],
      fetch: http.fetch,
    });

    const first = api.get('/a');
    const firstRejects = assert.rejects(first, (err: unknown) => isAbortError(err));
    await new Promise((resolve) => setTimeout(resolve, 10)); // attempt 1 fails, a retry is queued
    assert.deepEqual(await api.get('/b'), { ok: true }); // supersede mid-backoff
    await firstRejects;

    const attempts = http.calls.filter((c) => c.pathname === '/a').length;
    await new Promise((resolve) => setTimeout(resolve, 150)); // the queued retries' window
    assert.equal(http.calls.filter((c) => c.pathname === '/a').length, attempts);
  });

  test('a supersede beats a pending timeout deadline', async () => {
    const http = mockFetch();
    http.get('/a', { hang: true });
    http.get('/b', { json: { ok: true } });
    const api = corgi.create({ plugins: [abortPrevious(), withTimeout(1000)], fetch: http.fetch });

    const first = api.get('/a');
    const firstRejects = assert.rejects(first, (err: unknown) => isAbortError(err));
    assert.deepEqual(await api.get('/b'), { ok: true });
    await firstRejects; // AbortError, not the TimeoutError that was still pending
    http.reset();
  });
});
