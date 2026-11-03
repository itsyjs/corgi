// Plugins that swap in their own signal must keep it live past the response:
// the client reads the body after the pipeline settles.
import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { corgi, isAbortError, isTimeoutError } from '#index';
import { abortPrevious } from '#abort-previous';
import { withTimeout } from '#timeout';
import { withTimeout as withTimeoutModern } from '#timeout-modern';
import { mockFetch, type MockCall, type MockReply } from '#testing';

// Headers at once, the JSON body `ms` later. Like a real fetch body, it errors
// with the signal's reason if the request aborts first.
const slowBody =
  (json: unknown, ms: number) =>
  ({ init: { signal } }: MockCall): MockReply => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: new ReadableStream({
      start(body) {
        const timer = setTimeout(() => {
          body.enqueue(new TextEncoder().encode(JSON.stringify(json)));
          body.close();
        }, ms);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            body.error(signal.reason);
          },
          { once: true },
        );
      },
    }),
  });

// The mock answers in microtasks, so one macrotask later only the body is left.
const headersIn = () => new Promise((resolve) => setTimeout(resolve));

suite('aborts reach a body still downloading', () => {
  for (const [name, inner] of [
    ['alone', []],
    ['over withTimeout', [withTimeout(1000)]],
    ['over withTimeout (modern)', [withTimeoutModern(1000)]],
  ] as const) {
    test(`abortPrevious ${name}: a supersede cuts the previous body`, async () => {
      const http = mockFetch();
      const api = corgi.create({ fetch: http.fetch, plugins: [abortPrevious(), ...inner] });
      http.get('/old', slowBody({ q: 'old' }, 200));
      http.get('/new', { json: { q: 'new' } });

      const old = assert.rejects(api.get('/old'), (err: unknown) => isAbortError(err));
      await headersIn();
      assert.deepEqual(await api.get('/new'), { q: 'new' });
      await old;
    });
  }

  for (const [name, plugin] of [
    ['abortPrevious', abortPrevious()],
    ['withTimeout', withTimeout(1000)],
    ['withTimeout (modern)', withTimeoutModern(1000)],
  ] as const) {
    test(`${name}: a caller abort reaches the body`, async () => {
      const http = mockFetch();
      const api = corgi.create({ fetch: http.fetch, plugins: [plugin] });
      http.get('/x', slowBody({ ok: true }, 200));
      const controller = new AbortController();

      const pending = assert.rejects(api.get('/x', { signal: controller.signal }), (err: unknown) => isAbortError(err));
      await headersIn();
      controller.abort();
      await pending;
    });
  }

  for (const [name, timeout] of [
    ['withTimeout', withTimeout],
    ['withTimeout (modern)', withTimeoutModern],
  ] as const) {
    test(`${name}: the deadline covers the body`, async () => {
      const http = mockFetch();
      const api = corgi.create({ fetch: http.fetch, plugins: [timeout(20)] });
      http.get('/x', slowBody({ ok: true }, 200));
      await assert.rejects(api.get('/x'), (err: unknown) => isTimeoutError(err));
    });
  }

  test('abortPrevious: a held raw() body is cut once the next call starts', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, plugins: [abortPrevious()] });
    http.get('/old', slowBody({ q: 'old' }, 50));
    http.get('/new', { json: { q: 'new' } });

    const held = await api.raw('/old');
    await api.get('/new');
    await assert.rejects(held.json(), (err: unknown) => isAbortError(err));
  });

  test('abortPrevious: a shared caller signal never holds more than one listener', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, plugins: [abortPrevious()] });
    http.get('/x', { json: { ok: true } });
    const { signal } = new AbortController();

    for (let i = 0; i < 5; i++) await api.get('/x', { signal });
    const listeners = getEventListeners(signal, 'abort').length;
    assert.ok(listeners <= 1, `${listeners} abort listeners left on the shared signal`);
  });
});
