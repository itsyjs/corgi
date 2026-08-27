import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isAbortError, isHttpError, isTimeoutError, type Plugin } from '#index';
import { swr } from '#swr';
import { abortPrevious } from '#abort-previous';
import { withRetry } from '#retry';
import { withTimeout } from '#timeout';
import { mockFetch, networkError } from '#testing';

suite('swr', () => {
  test('a fresh hit is served from memory — no second request', async () => {
    const http = mockFetch();
    http.get('/rates', [{ json: { v: 1 } }, { json: { v: 2 } }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    assert.deepEqual(await api.get('/rates'), { v: 1 });
    assert.deepEqual(await api.get('/rates'), { v: 1 }); // minted from the store — content-type survived
    assert.equal(http.calls.length, 1);
  });

  test('a stale hit serves the old copy instantly and refreshes in the background', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { json: { v: 2 } }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: 300_000 })], fetch: http.fetch });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000); // past fresh, inside stale
    assert.deepEqual(await api.get('/x'), { v: 1 }); // the TRIGGERING caller gets the stale copy…
    await http.settled();
    assert.equal(http.calls.length, 2); // …and the refresh landed for the next one

    assert.deepEqual(await api.get('/x'), { v: 2 }); // inside the refresh's own fresh window
    assert.equal(http.calls.length, 2);
  });

  test('past fresh + stale the entry is dead: the call blocks on the network', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { json: { v: 2 } }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: 300_000 })], fetch: http.fetch });

    assert.deepEqual(await api.get('/x'), { v: 1 });
    t.mock.timers.setTime(360_000);
    assert.deepEqual(await api.get('/x'), { v: 2 }); // blocking refetch, new body
    assert.equal(http.calls.length, 2);
  });

  test('fresh: 0 is pure dedupe — concurrent calls share, sequential calls refetch', async () => {
    const http = mockFetch();
    http.get('/d', { json: { v: 1 }, delay: 10 });
    http.get('/other', { json: { v: 9 }, delay: 10 });
    const api = corgi.create({ plugins: [swr({ fresh: 0 })], fetch: http.fetch });

    const [a, b, c] = await Promise.all([api.get('/d'), api.get('/d'), api.get('/other')]);
    assert.deepEqual(a, { v: 1 });
    assert.deepEqual(b, { v: 1 });
    assert.deepEqual(c, { v: 9 });
    assert.equal(http.calls.length, 2); // /d shared one trip; /other kept its own

    await api.get('/d'); // nothing in flight now — a fresh window of 0 serves nothing
    assert.equal(http.calls.length, 3);
  });

  test('non-GETs pass straight through', async () => {
    const http = mockFetch();
    http.post('/p', { json: { ok: true } });
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    await api.post('/p');
    await api.post('/p');
    assert.equal(http.calls.length, 2);
  });

  test('HEAD is not a GET — it passes through uncached', async () => {
    const http = mockFetch();
    http.head('/h', { status: 200 });
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    assert.equal(await api.head('/h'), undefined);
    assert.equal(await api.head('/h'), undefined);
    assert.equal(http.calls.length, 2);
  });

  test('non-2xx responses are not stored', async () => {
    const http = mockFetch();
    http.get('/e', [{ status: 500 }, { json: { ok: true } }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    await assert.rejects(api.get('/e'), (err: unknown) => isHttpError(err) && err.status === 500);
    assert.deepEqual(await api.get('/e'), { ok: true }); // the failure wasn't cached
    assert.equal(http.calls.length, 2);
  });

  test('a failed refresh is dropped silently and the stale copy lives on', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { status: 500 }, { json: { v: 2 } }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: 300_000 })], fetch: http.fetch });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh comes back 500 — dropped
    await http.settled();
    assert.equal(http.calls.length, 2);

    assert.deepEqual(await api.get('/x'), { v: 1 }); // still the stale copy (mild stale-if-error)…
    await http.settled(); // …and that call fired a NEW refresh, which succeeds
    assert.deepEqual(await api.get('/x'), { v: 2 });
    assert.equal(http.calls.length, 3);
  });

  test("the refresh is detached from the triggering caller's signal", async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { json: { v: 2 }, delay: 20 }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: 300_000 })], fetch: http.fetch });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    const controller = new AbortController();
    assert.deepEqual(await api.get('/x', { signal: controller.signal }), { v: 1 }); // stale, instant
    controller.abort(); // caller cleans up after itself — must not kill the in-flight refresh
    await http.settled();

    assert.deepEqual(await api.get('/x'), { v: 2 }); // the refresh survived the abort
    assert.equal(http.calls.length, 2);
  });

  test('with abortPrevious composed, refreshes and user calls leave each other alone', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/slow', [{ json: { v: 1 } }, { json: { v: 2 }, delay: 20 }]);
    http.get('/other', { json: { ok: true } });
    const api = corgi.create({
      plugins: [abortPrevious(), swr({ fresh: 60_000, stale: 300_000 })],
      fetch: http.fetch,
    });

    assert.deepEqual(await api.get('/slow'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/slow'), { v: 1 }); // stale hit — slow refresh now in flight
    assert.deepEqual(await api.get('/other'), { ok: true }); // superseding call resolves normally
    await http.settled();

    assert.deepEqual(await api.get('/slow'), { v: 2 }); // and the refresh still landed
    assert.equal(http.calls.length, 3);
  });

  test('a cached 204 mints and parses like the original (undefined)', async () => {
    const http = mockFetch();
    http.get('/n', { status: 204 });
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    assert.equal(await api.get('/n'), undefined);
    assert.equal(await api.get('/n'), undefined); // minted with a null body — no constructor throw
    assert.equal(http.calls.length, 1);
  });

  test('extend() re-composes: the derived client starts with an empty cache', async () => {
    const http = mockFetch();
    http.get('/x', { json: { v: 1 } });
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    await api.get('/x');
    await api.extend().get('/x'); // fresh closure, fresh (empty) store
    assert.equal(http.calls.length, 2);
  });

  test('stale: Infinity serves forever once warm and keeps revalidating', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { json: { v: 2 } }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: Infinity })], fetch: http.fetch });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(1e12); // ~31 years past fresh — still never blocks
    assert.deepEqual(await api.get('/x'), { v: 1 });
    await http.settled();

    assert.deepEqual(await api.get('/x'), { v: 2 }); // refresh landed, fresh window restarted
    assert.equal(http.calls.length, 2);
  });

  test('errorBackoff: a failed refresh suppresses re-attempts while stale keeps serving', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { status: 500 }, { json: { v: 2 } }]);
    const api = corgi.create({
      plugins: [swr({ fresh: 60_000, stale: Infinity, errorBackoff: 10_000 })],
      fetch: http.fetch,
    });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh -> 500, backoff stamped
    await http.settled();
    assert.equal(http.calls.length, 2);

    t.mock.timers.setTime(125_000); // inside the 10s backoff
    assert.deepEqual(await api.get('/x'), { v: 1 }); // stale served, NO re-attempt
    await http.settled();
    assert.equal(http.calls.length, 2);

    t.mock.timers.setTime(131_000); // backoff over
    assert.deepEqual(await api.get('/x'), { v: 1 }); // re-attempt fires…
    await http.settled();
    assert.deepEqual(await api.get('/x'), { v: 2 }); // …lands, and cleared the backoff
    assert.equal(http.calls.length, 3);
  });

  test('accept gates what enters the store', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { json: { garbage: true } }, { json: { v: 3 } }]);
    const api = corgi.create({
      plugins: [
        swr({
          fresh: 60_000,
          stale: Infinity,
          accept: async (res) => ((await res.json()) as { v?: number }).v !== undefined,
        }),
      ],
      fetch: http.fetch,
    });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh is a 200 with garbage -> refused
    await http.settled();
    assert.deepEqual(await api.get('/x'), { v: 1 }); // old entry kept serving…
    await http.settled(); // …and that hit fired another refresh, which is good again
    assert.deepEqual(await api.get('/x'), { v: 3 });
    assert.equal(http.calls.length, 3);
  });

  test('a refused cold miss still resolves for the caller and is not stored', async () => {
    const http = mockFetch();
    http.get('/x', [{ json: { bad: 1 } }, { json: { bad: 2 } }]);
    const seen: unknown[] = [];
    const api = corgi.create({
      plugins: [swr({ fresh: 60_000, accept: () => false, onError: (info) => seen.push(info) })],
      fetch: http.fetch,
    });

    assert.deepEqual(await api.get('/x'), { bad: 1 }); // caller still gets the response…
    assert.deepEqual(await api.get('/x'), { bad: 2 }); // …but nothing was stored
    assert.equal(http.calls.length, 2);
    assert.equal(seen.length, 0); // foreground failures are the caller's — no hook
  });

  test('onError reports background failures — and only background ones', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    const seen: { url: string; error?: unknown; response?: Response }[] = [];
    const api = corgi.create({
      plugins: [swr({ fresh: 60_000, stale: Infinity, onError: (info) => seen.push(info) })],
      fetch: http.fetch,
    });

    http.get('/dead', networkError());
    await assert.rejects(api.get('/dead')); // cold miss: the CALLER saw this failure
    assert.equal(seen.length, 0);

    http.get('/x', [{ json: { v: 1 } }, { status: 500 }, networkError(), { json: { v: 2 } }]);
    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh -> 500 (default accept refuses)
    await http.settled();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.url, '/x');
    assert.equal(seen[0]?.response?.status, 500);
    assert.equal(seen[0]?.error, undefined);

    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh -> network error (rejected)
    await http.settled();
    assert.equal(seen.length, 2);
    assert.ok(seen[1]?.error instanceof TypeError);
    assert.equal(seen[1]?.response, undefined);
  });

  // settled() can't see withRetry's between-attempts sleep (see testing.ts), so for
  // detached refreshes we poll: settle, hop a real timer past the ~1ms backoff, repeat.
  const settledThrough = async (http: { settled(): Promise<void>; calls: readonly unknown[] }, calls: number) => {
    for (let i = 0; i < 50 && http.calls.length < calls; i++) {
      await http.settled();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await http.settled();
  };

  test('a background refresh inherits retry', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { status: 500 }, { json: { v: 2 } }]);
    const api = corgi.create({
      plugins: [swr({ fresh: 60_000, stale: Infinity }), withRetry({ retries: 1, backoff: 1, maxDelay: 2 })],
      fetch: http.fetch,
    });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh: 500, then the retry lands v2
    await settledThrough(http, 3);
    assert.equal(http.calls.length, 3);

    assert.deepEqual(await api.get('/x'), { v: 2 }); // stored by the retried refresh
    assert.equal(http.calls.length, 3);
  });

  test('a foreground miss inherits retry', async () => {
    const http = mockFetch();
    http.get('/x', [{ status: 500 }, { json: { ok: true } }]);
    const api = corgi.create({
      plugins: [swr({ fresh: 60_000 }), withRetry({ retries: 1, backoff: 1, maxDelay: 2 })],
      fetch: http.fetch,
    });

    assert.deepEqual(await api.get('/x'), { ok: true }); // first attempt 500, retry succeeds…
    assert.deepEqual(await api.get('/x'), { ok: true }); // …and the result was stored
    assert.equal(http.calls.length, 2);
  });

  test('a hung refresh is cut off by timeout, reported, and releases the single-flight lock', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { hang: true }, { json: { v: 2 } }]);
    const seen: { url: string; error?: unknown; response?: Response }[] = [];
    const api = corgi.create({
      plugins: [swr({ fresh: 60_000, stale: Infinity, onError: (info) => seen.push(info) }), withTimeout(10)],
      fetch: http.fetch,
    });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh hangs…
    await new Promise((resolve) => setTimeout(resolve, 30)); // …until the 10ms deadline fires
    assert.equal(seen.length, 1);
    assert.ok(isTimeoutError(seen[0]?.error));

    assert.deepEqual(await api.get('/x'), { v: 1 }); // lock released: a NEW refresh fires…
    await http.settled();
    assert.deepEqual(await api.get('/x'), { v: 2 }); // …and lands
    assert.equal(http.calls.length, 3);
    http.reset();
  });

  test('without a timeout, a hung refresh holds the single-flight lock', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 0 });
    const http = mockFetch();
    http.get('/x', [{ json: { v: 1 } }, { hang: true }]);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000, stale: Infinity })], fetch: http.fetch });

    assert.deepEqual(await api.get('/x'), { v: 1 });

    t.mock.timers.setTime(120_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // refresh hangs, holding the lock
    t.mock.timers.setTime(240_000);
    assert.deepEqual(await api.get('/x'), { v: 1 }); // stale keeps serving…
    assert.deepEqual(await api.get('/x'), { v: 1 });
    await http.settled();
    assert.equal(http.calls.length, 2); // …and no new attempt ever starts (pair with withTimeout)
    http.reset();
  });

  test('plugins inside swr run per network trip and do not fragment the cache key', async () => {
    const http = mockFetch();
    http.get('/x', { json: { v: 1 } });
    const bust: Plugin = (next) => (url, init) => next(url + '?v=1', init);
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 }), bust], fetch: http.fetch });

    assert.deepEqual(await api.get('/x'), { v: 1 });
    assert.deepEqual(await api.get('/x'), { v: 1 }); // hit — keyed on the PRE-rewrite url
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0]?.url, '/x?v=1'); // the trip itself was rewritten
  });

  test('the key is the full url, so distinct query strings are distinct entries', async () => {
    const http = mockFetch();
    http.get('/s', (call) => ({ json: { q: call.query.get('q') } }));
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    assert.deepEqual(await api.get('/s', { query: { q: 'a' } }), { q: 'a' });
    assert.deepEqual(await api.get('/s', { query: { q: 'b' } }), { q: 'b' }); // not a hit on ?q=a
    assert.deepEqual(await api.get('/s', { query: { q: 'a' } }), { q: 'a' }); // now a hit
    assert.equal(http.calls.length, 2);
  });

  test('a cached serve parses exactly like a fresh one (transform and responseType)', async () => {
    const http = mockFetch();
    http.get('/n', { json: { n: 1 } });
    http.get('/t', { text: 'hello' });
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });
    const shout = (v: unknown) => `n=${(v as { n: number }).n}`;

    assert.equal(await api.get('/n', { transform: shout }), 'n=1');
    assert.equal(await api.get('/n', { transform: shout }), 'n=1'); // transform runs on the cached serve

    assert.equal(await api.get('/t', { responseType: 'text' }), 'hello');
    assert.equal(await api.get('/t', { responseType: 'text' }), 'hello');
    assert.equal(await (await api.get('/t', { responseType: 'blob' })).text(), 'hello');
    assert.equal(http.calls.length, 2);
  });

  test('when the caller that OWNS a shared trip aborts, the joiners reject too', async () => {
    // Documented tradeoff: the shared request carries the first caller's init,
    // signal included, so an abort takes down everyone waiting on that trip.
    const http = mockFetch();
    http.get('/x', { json: { v: 1 }, delay: 30 });
    const api = corgi.create({ plugins: [swr({ fresh: 60_000 })], fetch: http.fetch });

    const controller = new AbortController();
    const owner = api.get('/x', { signal: controller.signal });
    const joiner = api.get('/x'); // joins the in-flight trip
    controller.abort();

    await assert.rejects(owner, (err: unknown) => isAbortError(err));
    await assert.rejects(joiner, (err: unknown) => isAbortError(err));

    http.get('/x', { json: { v: 2 } });
    assert.deepEqual(await api.get('/x'), { v: 2 }); // the slot was released, not wedged
  });
});
