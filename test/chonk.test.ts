import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isTimeoutError, isAbortError } from '../src/chonk.ts';
import { slow, json } from './helpers.ts';

suite('chonk', () => {
  test('`timeout` is a first-class option (-> withTimeout)', async () => {
    const api = corgi.create({ fetch: slow, timeout: 10 });
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isTimeoutError(err),
    );
  });

  test('`retry` is a first-class option (-> withRetry)', async () => {
    let calls = 0;
    const api = corgi.create({
      retry: { retries: 2, backoff: 1, maxDelay: 2 },
      fetch: async () => {
        calls++;
        return calls < 3 ? json({ e: 1 }, { status: 503 }) : json({ ok: true });
      },
    });
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 3);
  });

  test('`abortPrevious` is a first-class option (-> abortPrevious)', async () => {
    const api = corgi.create({ abortPrevious: true, fetch: slow });
    const first = api.raw('/a');
    const firstRejects = assert.rejects(first, (err: unknown) => isAbortError(err));
    const second = api.raw('/b');
    second.catch(() => {});
    await firstRejects;
  });

  test('options compose together and sort into the correct order', async () => {
    // retry + timeout together: a timed-out attempt is retried (timeout is inner).
    let calls = 0;
    const api = corgi.create({
      timeout: 10,
      retry: { retries: 1, backoff: 1, maxDelay: 2 },
      fetch: (_url, init) => {
        calls++;
        // First attempt hangs (times out); second resolves fast.
        return calls === 1 ? slow(_url, init) : Promise.resolve(json({ ok: true }));
      },
    });
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 2);
  });

  test('the corgi singleton is a plain client with no plugins', () => {
    assert.equal(typeof corgi, 'function');
    assert.equal(typeof corgi.get, 'function');
    assert.equal(typeof corgi.create, 'function');
    assert.equal(typeof corgi.extend, 'function');
  });
});
