import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isHttpError } from '#index';
import { withRetry } from '#retry';
import { abortError, mockFetch, networkError } from '#testing';

// Tiny backoff so the suite stays fast. Call counts are asserted off the
// mock's call log — every attempt (retries included) is one recorded call.
const fast = { retries: 3, backoff: 1, maxDelay: 2 } as const;

suite('withRetry', () => {
  test('retries a retryable status until it succeeds (GET is idempotent)', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.get('/x', [{ status: 503 }, { status: 503 }, { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 3);
  });

  test('retries a network error (TypeError)', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.get('/x', [networkError('network down'), { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 2);
  });

  test('does NOT retry non-idempotent POST', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.post('/x', { status: 503 });
    await assert.rejects(
      () => api.post('/x'),
      (err: unknown) => isHttpError(err),
    );
    assert.equal(http.calls.length, 1);
  });

  test('gives up after exhausting retries and surfaces the last response', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry({ retries: 2, backoff: 1, maxDelay: 2 })], fetch: http.fetch });
    http.get('/x', { status: 500 }); // sticks: every attempt sees a fresh 500
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isHttpError(err),
    );
    assert.equal(http.calls.length, 3); // 1 initial + 2 retries
  });

  test('honours Retry-After (capped by maxDelay) and calls onRetry', async () => {
    const http = mockFetch();
    const seen: Array<{ attempt: number; delay: number }> = [];
    const api = corgi.create({
      plugins: [
        withRetry({
          retries: 1,
          backoff: 9999, // huge, so a computed jitter delay would NOT be ~5
          maxDelay: 5,
          onRetry: ({ attempt, delay }) => seen.push({ attempt, delay }),
        }),
      ],
      fetch: http.fetch,
    });
    http.get('/x', [{ status: 503, headers: { 'retry-after': '100' } }, { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 2);
    // Retry-After 100s -> 100_000ms, capped to maxDelay 5ms. delay=5 proves the
    // header path was taken (not the backoff jitter).
    assert.deepEqual(seen, [{ attempt: 1, delay: 5 }]);
  });

  test('honours FRACTIONAL Retry-After seconds (contract: the /testing lever)', async () => {
    // `@itsy/corgi/testing` documents `retry-after: '0.001'` as the way to
    // exercise retry against a client whose backoff a test can't configure.
    // This pin keeps a future parse-to-spec cleanup from silently breaking it.
    const http = mockFetch();
    const seen: number[] = [];
    const api = corgi.create({
      plugins: [
        withRetry({
          retries: 1,
          backoff: 60_000, // if the header path were NOT taken, this test would hang for a minute
          onRetry: ({ delay }) => seen.push(delay),
        }),
      ],
      fetch: http.fetch,
    });
    http.get('/x', [{ status: 503, headers: { 'retry-after': '0.001' } }, { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.deepEqual(seen, [1]); // 0.001s -> exactly 1ms, not jitter
  });

  test('does NOT retry a caller AbortError', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.get('/x', abortError('aborted')); // transport-level rejection with the AbortError name
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );
    assert.equal(http.calls.length, 1);
  });

  test('does NOT retry a non-replayable (stream) body, even for idempotent methods', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.put('/x', { status: 503 });
    await assert.rejects(
      () => api.put('/x', { body: new ReadableStream() }),
      (err: unknown) => isHttpError(err),
    );
    assert.equal(http.calls.length, 1);
  });

  test('retries an idempotent PUT with a replayable body', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.put('/x', [{ status: 503 }, { json: { ok: true } }]);
    assert.deepEqual(await api.put('/x', { body: { a: 1 } }), { ok: true });
    assert.equal(http.calls.length, 2);
  });

  test('retry still fires when the client will not throw (throwOnError: false)', async () => {
    // The seam: retry decides on `response.status` INSIDE the pipeline, while the
    // throw decision happens after it. Turning throwing off must not mute retry.
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], throwOnError: false, fetch: http.fetch });
    http.get('/x', [{ status: 503 }, { json: { ok: true } }]);
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(http.calls.length, 2);
  });

  test('a predicate that spares 5xx still lets retry run first', async () => {
    const http = mockFetch();
    const api = corgi.create({
      plugins: [withRetry(fast)],
      throwOnError: (status) => status < 500, // 5xx comes back as a value…
      fetch: http.fetch,
    });
    http.get('/x', [{ status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }]);
    assert.deepEqual(await api.get('/x', { throwOnError: (s) => s < 500 }), undefined);
    assert.equal(http.calls.length, 4); // …only after retry exhausted its attempts
  });
});
