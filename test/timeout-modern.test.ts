// The builtin-based timeout is a behavioural drop-in for '../src/timeout.ts'.
// These mirror timeout.test.ts to prove parity (AbortSignal.any/timeout requires
// a Baseline-2024 runtime; the test runner is well past that).
import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, compose, isTimeoutError, isAbortError } from '#index';
import { withTimeout } from '#timeout-modern';
import { mockFetch } from '#testing';

suite('withTimeout (modern)', () => {
  test('client timeout rejects with a TimeoutError', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, plugins: [withTimeout(10)] });
    http.get('/x', { hang: true });
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isTimeoutError(err),
    );
    http.reset();
  });

  test('an already-aborted caller signal fails immediately with AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    const http = mockFetch();
    http.get('/x', { hang: true });
    const pipeline = compose(withTimeout(1000))(http.fetch);
    await assert.rejects(
      () => pipeline('/x', { signal: controller.signal }),
      (err: unknown) => isAbortError(err),
    );
    http.reset();
  });

  test('a mid-flight caller abort wins over the timeout (AbortError)', async () => {
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

  test('ms of 0 or Infinity disables the timeout', async () => {
    for (const ms of [0, Infinity]) {
      const http = mockFetch();
      const api = corgi.create({ fetch: http.fetch, plugins: [withTimeout(ms)] });
      http.get('/x', { json: { ok: true } });
      assert.deepEqual(await api.get('/x'), { ok: true });
    }
  });
});
