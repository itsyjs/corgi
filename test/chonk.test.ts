import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isTimeoutError, isAbortError, type Plugin } from '#chonk';
import { mockFetch } from '#testing';

suite('chonk', () => {
  test('`timeout` is a first-class option (-> withTimeout)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, timeout: 10 });
    http.get('/x', { hang: true });
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isTimeoutError(err),
    );
    http.reset();
  });

  test('`retry` is a first-class option (-> withRetry)', async () => {
    const http = mockFetch();
    const api = corgi.create({ retry: { retries: 2, backoff: 1, maxDelay: 2 }, fetch: http.fetch });
    http.get('/x', [{ json: { e: 1 }, status: 503 }, { json: { e: 1 }, status: 503 }, { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 3);
  });

  test('`abortPrevious` is a first-class option (-> abortPrevious)', async () => {
    const http = mockFetch();
    const api = corgi.create({ abortPrevious: true, fetch: http.fetch });
    http.get('/a', { hang: true });
    http.get('/b', { json: 'ok' });
    const first = api.raw('/a');
    const firstRejects = assert.rejects(first, (err: unknown) => isAbortError(err));
    await api.raw('/b'); // supersedes the first
    await firstRejects;
  });

  test('`swr` is a first-class option (-> swr); extend overrides it', async () => {
    const http = mockFetch();
    http.get('/c', [{ json: { v: 1 } }, { json: { v: 2 } }, { json: { v: 3 } }]);
    const api = corgi.create({ swr: 60_000, fetch: http.fetch }); // bare number = { fresh: n }

    assert.deepEqual(await api.get('/c'), { v: 1 });
    assert.deepEqual(await api.get('/c'), { v: 1 }); // cached
    assert.equal(http.calls.length, 1);

    const uncached = api.extend({ swr: 0 }); // override, not stack: fresh 0 = dedupe only
    assert.deepEqual(await uncached.get('/c'), { v: 2 });
    assert.deepEqual(await uncached.get('/c'), { v: 3 }); // nothing served from the store
    assert.equal(http.calls.length, 3);
  });

  test('options compose together and sort into the correct order', async () => {
    // retry + timeout together: a timed-out attempt is retried (timeout is inner).
    const http = mockFetch();
    const api = corgi.create({ timeout: 10, retry: { retries: 1, backoff: 1, maxDelay: 2 }, fetch: http.fetch });
    // First attempt hangs (times out); the retry's attempt resolves fast.
    http.get('/x', [{ hang: true }, { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 2);
  });

  test('the corgi singleton is a plain client with no plugins', () => {
    assert.equal(typeof corgi, 'function');
    assert.equal(typeof corgi.get, 'function');
    assert.equal(typeof corgi.create, 'function');
    assert.equal(typeof corgi.extend, 'function');
  });
});

suite('chonk: extend', () => {
  test('`abortPrevious` can be turned on by extend; the parent is unaffected', async () => {
    const http = mockFetch();
    // `delay` stands in for a request slow enough to still be in flight when the
    // next one starts, but that resolves when nothing cancels it — so "was not
    // cancelled" is as deterministic to assert as "was cancelled".
    http.any({ json: { ok: true }, delay: 20 });
    const api = corgi.create({ baseURL: 'https://foo.bar', fetch: http.fetch });
    const searchApi = api.extend({ abortPrevious: true });

    // The derived client cancels its own previous call...
    const firstRejects = assert.rejects(searchApi.raw('/a'), (err: unknown) => isAbortError(err));
    await searchApi.raw('/b');
    await firstRejects;

    // ...while the parent, which never opted in, cancels nothing.
    await assert.doesNotReject(Promise.all([api.raw('/a'), api.raw('/b')]));
  });

  test('`timeout` and `retry` can be turned on by extend', async () => {
    const timing = mockFetch();
    timing.get('/x', { hang: true });
    await assert.rejects(
      () => corgi.create({ fetch: timing.fetch }).extend({ timeout: 10 }).get('/x'),
      (err: unknown) => isTimeoutError(err),
    );
    timing.reset();

    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch }).extend({ retry: { retries: 2, backoff: 1, maxDelay: 2 } });
    http.get('/x', [{ json: { e: 1 }, status: 503 }, { json: { e: 1 }, status: 503 }, { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 3);
  });

  test('`timeout` on extend REPLACES the parent’s — it does not stack a second layer', async () => {
    // Parent 5ms, child 500ms. The caller aborts at 50ms, so the rejection reason
    // says which timeout is live: `AbortError` = only the child's 500ms plugin is
    // installed; `TimeoutError` = the parent's 5ms layer survived alongside it.
    const http = mockFetch();
    http.get('/x', { hang: true });
    const api = corgi.create({ fetch: http.fetch, timeout: 5 }).extend({ timeout: 500 });
    const controller = new AbortController();
    const pending = api.get('/x', { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, (err: unknown) => isAbortError(err) && !isTimeoutError(err));
    clearTimeout(timer);
    http.reset();
  });

  test('`retry` on extend REPLACES the parent’s — it does not stack a second layer', async () => {
    const http = mockFetch();
    const api = corgi.create({ retry: { retries: 3, backoff: 1, maxDelay: 2 }, fetch: http.fetch });
    http.get('/x', { json: { e: 1 }, status: 503 }); // sticks: every attempt sees a fresh 503

    // One `withRetry(0)` => a single attempt. Two nested layers would give 4.
    await assert.rejects(() => api.extend({ retry: 0 }).get('/x'));
    assert.equal(http.calls.length, 1);

    // And the parent still has its own retries, untouched by the derivation.
    http.resetCalls();
    await assert.rejects(() => api.get('/x'));
    assert.equal(http.calls.length, 4);
  });

  test('`abortPrevious: false` on extend disables the parent’s', async () => {
    const http = mockFetch();
    http.any({ json: { ok: true }, delay: 20 });
    const api = corgi.create({ abortPrevious: true, fetch: http.fetch });
    const plain = api.extend({ abortPrevious: false });

    // Neither call cancels the other: both resolve.
    await assert.doesNotReject(Promise.all([plain.raw('/a'), plain.raw('/b')]));

    // The parent keeps its cancel slot.
    const firstRejects = assert.rejects(api.raw('/a'), (err: unknown) => isAbortError(err));
    await api.raw('/b');
    await firstRejects;
  });

  test('parent and child hold independent abortPrevious slots', async () => {
    // The slot lives in the closure `compose` builds per client, so a derived
    // client is its own logical stream — it never supersedes the parent's calls.
    const http = mockFetch();
    http.any({ json: { ok: true }, delay: 20 });
    const api = corgi.create({ abortPrevious: true, fetch: http.fetch });
    const child = api.extend({ headers: { 'x-child': '1' } });
    await assert.doesNotReject(Promise.all([api.raw('/a'), child.raw('/b')]));
  });

  test('overriding one option leaves the others intact', async () => {
    const http = mockFetch();
    // First attempt is slower than the parent's 5ms but well under 500ms.
    http.get('/x', [{ json: { ok: true }, delay: 40 }, { json: { ok: true } }]);
    const api = corgi
      .create({ timeout: 5, retry: { retries: 1, backoff: 1, maxDelay: 2 }, fetch: http.fetch })
      .extend({ timeout: 500 });

    // Retry survived the extend, and the first attempt was no longer timed out at 5ms.
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 1);
  });

  test('non-plugin defaults still extend: baseURL, headers, and user plugins', async () => {
    const seen: string[] = [];
    const record =
      (tag: string): Plugin =>
      (next) =>
      (u, init) => {
        seen.push(tag);
        return next(u, init);
      };

    const http = mockFetch();
    http.get('/users', { json: { ok: true } });
    const api = corgi
      .create({
        baseURL: 'https://foo.bar',
        headers: { 'x-base': 'b', 'x-both': 'parent' },
        plugins: [record('parent')],
        retry: 0,
        fetch: http.fetch,
      })
      .extend({
        headers: { 'x-child': 'c', 'x-both': 'child' },
        plugins: [record('child')],
        abortPrevious: true,
      });

    assert.deepEqual(await api.get('/users'), { ok: true });
    const call = http.lastCall!;
    assert.equal(call.url, 'https://foo.bar/users');
    assert.equal(call.headers.get('x-base'), 'b');
    assert.equal(call.headers.get('x-child'), 'c');
    assert.equal(call.headers.get('x-both'), 'child', 'child wins per key');
    assert.deepEqual(seen, ['parent', 'child'], 'user plugins concatenate parent-first');
  });

  test('chonk options never leak into the RequestInit handed to fetch', async () => {
    const http = mockFetch();
    http.get('/x', { json: { ok: true } });
    const api = corgi.create({ fetch: http.fetch }).extend({ retry: 1, timeout: 500, abortPrevious: true });

    await api.get('/x');
    const init = http.lastCall?.init;
    assert.ok(init);
    for (const key of ['retry', 'timeout', 'abortPrevious']) {
      assert.ok(!(key in init), `\`${key}\` must not reach fetch`);
    }
  });

  test('extend chains, and extend() with no argument keeps the parent’s options', async () => {
    const http = mockFetch();
    http.get('/x', [{ json: { e: 1 }, status: 503 }, { json: { ok: true } }]);
    const api = corgi
      .create({ fetch: http.fetch })
      .extend({ retry: { retries: 1, backoff: 1, maxDelay: 2 } })
      .extend({ timeout: 500 })
      .extend();

    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 2);
  });
});
