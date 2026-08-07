import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isTimeoutError, isAbortError, type Plugin } from '../src/chonk.ts';
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

/**
 * A fetch that resolves after `ms` but still honours its signal — lets us assert a
 * request was NOT cancelled (it resolves) as deterministically as that it was.
 */
const settling =
  (ms: number): typeof fetch =>
  (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => resolve(json({ ok: true })), ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    });

suite('chonk: extend', () => {
  test('`abortPrevious` can be turned on by extend; the parent is unaffected', async () => {
    const api = corgi.create({ baseURL: 'https://foo.bar', fetch: settling(20) });
    const searchApi = api.extend({ abortPrevious: true });

    // The derived client cancels its own previous call...
    const firstRejects = assert.rejects(searchApi.raw('/a'), (err: unknown) => isAbortError(err));
    searchApi.raw('/b').catch(() => {});
    await firstRejects;

    // ...while the parent, which never opted in, cancels nothing.
    await assert.doesNotReject(Promise.all([api.raw('/a'), api.raw('/b')]));
  });

  test('`timeout` and `retry` can be turned on by extend', async () => {
    await assert.rejects(
      () => corgi.create({ fetch: slow }).extend({ timeout: 10 }).get('/x'),
      (err: unknown) => isTimeoutError(err),
    );

    let calls = 0;
    const api = corgi
      .create({
        fetch: async () => {
          calls++;
          return calls < 3 ? json({ e: 1 }, { status: 503 }) : json({ ok: true });
        },
      })
      .extend({ retry: { retries: 2, backoff: 1, maxDelay: 2 } });
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 3);
  });

  test('`timeout` on extend REPLACES the parent’s — it does not stack a second layer', async () => {
    // Parent 5ms, child 500ms. The caller aborts at 50ms, so the rejection reason
    // says which timeout is live: `AbortError` = only the child's 500ms plugin is
    // installed; `TimeoutError` = the parent's 5ms layer survived alongside it.
    const api = corgi.create({ fetch: slow, timeout: 5 }).extend({ timeout: 500 });
    const controller = new AbortController();
    const pending = api.get('/x', { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, (err: unknown) => isAbortError(err) && !isTimeoutError(err));
    clearTimeout(timer);
  });

  test('`retry` on extend REPLACES the parent’s — it does not stack a second layer', async () => {
    let calls = 0;
    const api = corgi.create({
      retry: { retries: 3, backoff: 1, maxDelay: 2 },
      fetch: async () => {
        calls++;
        return json({ e: 1 }, { status: 503 });
      },
    });

    // One `withRetry(0)` => a single attempt. Two nested layers would give 4.
    await assert.rejects(() => api.extend({ retry: 0 }).get('/x'));
    assert.equal(calls, 1);

    // And the parent still has its own retries, untouched by the derivation.
    calls = 0;
    await assert.rejects(() => api.get('/x'));
    assert.equal(calls, 4);
  });

  test('`abortPrevious: false` on extend disables the parent’s', async () => {
    const api = corgi.create({ abortPrevious: true, fetch: settling(20) });
    const plain = api.extend({ abortPrevious: false });

    // Neither call cancels the other: both resolve.
    await assert.doesNotReject(Promise.all([plain.raw('/a'), plain.raw('/b')]));

    // The parent keeps its cancel slot.
    const firstRejects = assert.rejects(api.raw('/a'), (err: unknown) => isAbortError(err));
    api.raw('/b').catch(() => {});
    await firstRejects;
  });

  test('parent and child hold independent abortPrevious slots', async () => {
    // The slot lives in the closure `compose` builds per client, so a derived
    // client is its own logical stream — it never supersedes the parent's calls.
    const api = corgi.create({ abortPrevious: true, fetch: settling(20) });
    const child = api.extend({ headers: { 'x-child': '1' } });
    await assert.doesNotReject(Promise.all([api.raw('/a'), child.raw('/b')]));
  });

  test('overriding one option leaves the others intact', async () => {
    let calls = 0;
    const api = corgi
      .create({
        timeout: 5,
        retry: { retries: 1, backoff: 1, maxDelay: 2 },
        fetch: (url, init) => {
          calls++;
          // First attempt is slower than the parent's 5ms but well under 500ms.
          return calls === 1 ? settling(40)(url, init) : Promise.resolve(json({ ok: true }));
        },
      })
      .extend({ timeout: 500 });

    // Retry survived the extend, and the first attempt was no longer timed out at 5ms.
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 1);
  });

  test('non-plugin defaults still extend: baseURL, headers, and user plugins', async () => {
    const seen: string[] = [];
    let url = '';
    let headers: Headers | undefined;

    const record =
      (tag: string): Plugin =>
      (next) =>
      (u, init) => {
        seen.push(tag);
        return next(u, init);
      };

    const api = corgi
      .create({
        baseURL: 'https://foo.bar',
        headers: { 'x-base': 'b', 'x-both': 'parent' },
        plugins: [record('parent')],
        retry: 0,
        fetch: (u, init) => {
          url = String(u);
          headers = new Headers(init?.headers);
          return Promise.resolve(json({ ok: true }));
        },
      })
      .extend({
        headers: { 'x-child': 'c', 'x-both': 'child' },
        plugins: [record('child')],
        abortPrevious: true,
      });

    assert.deepEqual(await api.get('/users'), { ok: true });
    assert.equal(url, 'https://foo.bar/users');
    assert.equal(headers?.get('x-base'), 'b');
    assert.equal(headers?.get('x-child'), 'c');
    assert.equal(headers?.get('x-both'), 'child', 'child wins per key');
    assert.deepEqual(seen, ['parent', 'child'], 'user plugins concatenate parent-first');
  });

  test('chonk options never leak into the RequestInit handed to fetch', async () => {
    let init: RequestInit | undefined;
    const api = corgi
      .create({
        fetch: (_url, requestInit) => {
          init = requestInit;
          return Promise.resolve(json({ ok: true }));
        },
      })
      .extend({ retry: 1, timeout: 500, abortPrevious: true });

    await api.get('/x');
    assert.ok(init);
    for (const key of ['retry', 'timeout', 'abortPrevious']) {
      assert.ok(!(key in init), `\`${key}\` must not reach fetch`);
    }
  });

  test('extend chains, and extend() with no argument keeps the parent’s options', async () => {
    let calls = 0;
    const api = corgi
      .create({
        fetch: async () => {
          calls++;
          return calls < 2 ? json({ e: 1 }, { status: 503 }) : json({ ok: true });
        },
      })
      .extend({ retry: { retries: 1, backoff: 1, maxDelay: 2 } })
      .extend({ timeout: 500 })
      .extend();

    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 2);
  });
});
