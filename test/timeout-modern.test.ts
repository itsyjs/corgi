// The builtin-based timeout is a behavioural drop-in for '../src/timeout.ts'.
// These mirror timeout.test.ts to prove parity (AbortSignal.any/timeout requires
// a Baseline-2024 runtime; the test runner is well past that).
import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, compose, isTimeoutError, isAbortError } from '../src/index.ts';
import { withTimeout } from '../src/timeout-modern.ts';
import { slow, json } from './helpers.ts';

suite('withTimeout (modern)', () => {
  test('client timeout rejects with a TimeoutError', async () => {
    const api = corgi.create({ fetch: slow, plugins: [withTimeout(10)] });
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isTimeoutError(err),
    );
  });

  test('an already-aborted caller signal fails immediately with AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    const pipeline = compose(withTimeout(1000))(slow);
    await assert.rejects(
      () => pipeline('/x', { signal: controller.signal }),
      (err: unknown) => isAbortError(err),
    );
  });

  test('a mid-flight caller abort wins over the timeout (AbortError)', async () => {
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

  test('ms of 0 or Infinity disables the timeout', async () => {
    for (const ms of [0, Infinity]) {
      const api = corgi.create({ fetch: async () => json({ ok: true }), plugins: [withTimeout(ms)] });
      assert.deepEqual(await api.get('/x'), { ok: true });
    }
  });
});
