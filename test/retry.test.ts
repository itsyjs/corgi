import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isHttpError } from '../src/index.ts';
import { withRetry } from '../src/retry.ts';
import { json } from './helpers.ts';

// Tiny backoff so the suite stays fast.
const fast = { retries: 3, backoff: 1, maxDelay: 2 } as const;

suite('withRetry', () => {
  test('retries a retryable status until it succeeds (GET is idempotent)', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [withRetry(fast)],
      fetch: async () => {
        calls++;
        return calls < 3 ? new Response('', { status: 503 }) : json({ ok: true });
      },
    });
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 3);
  });

  test('retries a network error (TypeError)', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [withRetry(fast)],
      fetch: async () => {
        calls++;
        if (calls < 2) throw new TypeError('network down');
        return json({ ok: true });
      },
    });
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 2);
  });

  test('does NOT retry non-idempotent POST', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [withRetry(fast)],
      fetch: async () => {
        calls++;
        return new Response('', { status: 503 });
      },
    });
    await assert.rejects(
      () => api.post('/x'),
      (err: unknown) => isHttpError(err),
    );
    assert.equal(calls, 1);
  });

  test('gives up after exhausting retries and surfaces the last response', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [withRetry({ retries: 2, backoff: 1, maxDelay: 2 })],
      fetch: async () => {
        calls++;
        return new Response('', { status: 500 });
      },
    });
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => isHttpError(err),
    );
    assert.equal(calls, 3); // 1 initial + 2 retries
  });

  test('honours Retry-After (capped by maxDelay) and calls onRetry', async () => {
    let calls = 0;
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
      fetch: async () => {
        calls++;
        return calls < 2 ? new Response('', { status: 503, headers: { 'retry-after': '100' } }) : json({ ok: true });
      },
    });
    assert.deepEqual(await api.get('/x'), { ok: true });
    assert.equal(calls, 2);
    // Retry-After 100s -> 100_000ms, capped to maxDelay 5ms. delay=5 proves the
    // header path was taken (not the backoff jitter).
    assert.deepEqual(seen, [{ attempt: 1, delay: 5 }]);
  });

  test('does NOT retry a caller AbortError', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [withRetry(fast)],
      fetch: async () => {
        calls++;
        throw new DOMException('aborted', 'AbortError');
      },
    });
    await assert.rejects(
      () => api.get('/x'),
      (err: unknown) => err instanceof Error && err.name === 'AbortError',
    );
    assert.equal(calls, 1);
  });

  test('does NOT retry a non-replayable (stream) body, even for idempotent methods', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [withRetry(fast)],
      fetch: async () => {
        calls++;
        return new Response('', { status: 503 });
      },
    });
    await assert.rejects(
      () => api.put('/x', { body: new ReadableStream() }),
      (err: unknown) => isHttpError(err),
    );
    assert.equal(calls, 1);
  });

  test('retries an idempotent PUT with a replayable body', async () => {
    let calls = 0;
    const api = corgi.create({
      plugins: [withRetry(fast)],
      fetch: async () => {
        calls++;
        return calls < 2 ? new Response('', { status: 503 }) : json({ ok: true });
      },
    });
    assert.deepEqual(await api.put('/x', { body: { a: 1 } }), { ok: true });
    assert.equal(calls, 2);
  });
});
