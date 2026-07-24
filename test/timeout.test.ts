import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, compose, isTimeoutError, isAbortError } from '../src/index.ts';
import { withTimeout } from '../src/timeout.ts';
import { slow, json } from './helpers.ts';

suite('withTimeout', () => {
  test('client timeout rejects with a TimeoutError', async () => {
    const api = corgi.create({ fetch: slow, plugins: [withTimeout(10)] });
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isTimeoutError(err),
    );
  });

  test('withTimeout forwards an already-aborted caller signal immediately', async () => {
    const controller = new AbortController();
    controller.abort(); // aborted BEFORE the request starts
    const pipeline = compose(withTimeout(1000))(slow);
    await assert.rejects(
      () => pipeline('/x', { signal: controller.signal }),
      (err: unknown) => isAbortError(err),
    );
  });

  test('a mid-flight caller abort wins over the timeout (AbortError, not TimeoutError)', async () => {
    const controller = new AbortController();
    const pipeline = compose(withTimeout(1000))(slow);
    const pending = pipeline('/x', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err) && !isTimeoutError(err));
  });

  test('a fast response is not affected by the timeout', async () => {
    const api = corgi.create({ fetch: async () => json({ ok: true }), plugins: [withTimeout(1000)] });
    assert.deepEqual(await api.get('/x'), { ok: true });
  });

  test('ms of 0 or Infinity disables the timeout (request forwarded untouched)', async () => {
    for (const ms of [0, Infinity]) {
      const api = corgi.create({ fetch: async () => json({ ok: true }), plugins: [withTimeout(ms)] });
      assert.deepEqual(await api.get('/x'), { ok: true });
    }
  });
});
