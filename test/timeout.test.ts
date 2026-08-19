import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, compose, isTimeoutError, isAbortError } from '#index';
import { withTimeout } from '#timeout';
import { mockFetch } from '#testing';

suite('withTimeout', () => {
  test('client timeout rejects with a TimeoutError', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, plugins: [withTimeout(10)] });
    http.get('/x', { hang: true }); // never answers — only the timeout ends it
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isTimeoutError(err),
    );
    http.reset();
  });

  test('withTimeout forwards an already-aborted caller signal immediately', async () => {
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE the request starts
    const http = mockFetch();
    http.get('/x', { hang: true });
    const pipeline = compose(withTimeout(1000))(http.fetch);
    await assert.rejects(
      () => pipeline('/x', { signal: controller.signal }),
      (err: unknown) => isAbortError(err),
    );
    http.reset();
  });

  test('a mid-flight caller abort wins over the timeout (AbortError, not TimeoutError)', async () => {
    const controller = new AbortController();
    const http = mockFetch();
    http.get('/x', { hang: true });
    const pipeline = compose(withTimeout(1000))(http.fetch);
    const pending = pipeline('/x', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err) && !isTimeoutError(err));
    http.reset();
  });

  test('a fast response is not affected by the timeout', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, plugins: [withTimeout(1000)] });
    http.get('/x', { json: { ok: true } });
    assert.deepEqual(await api.get('/x'), { ok: true });
  });

  test('ms of 0 or Infinity disables the timeout (request forwarded untouched)', async () => {
    for (const ms of [0, Infinity]) {
      const http = mockFetch();
      const api = corgi.create({ fetch: http.fetch, plugins: [withTimeout(ms)] });
      http.get('/x', { json: { ok: true } });
      assert.deepEqual(await api.get('/x'), { ok: true });
    }
  });
});
