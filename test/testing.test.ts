import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi } from '#index';
import { withRetry } from '#retry';
import { withTimeout } from '#timeout';
import { isAbortError, isHttpError, isTimeoutError } from '#error';
import { abortError, httpError, mockFetch, networkError, timeoutError } from '#testing';

// Tiny backoff so retry-driving tests stay fast.
const fast = { retries: 3, backoff: 1, maxDelay: 2 } as const;

suite('mockFetch: matching', () => {
  test('a string pattern matches the pathname of a RELATIVE url (no baseURL — the default case)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/users', { json: [{ id: 1 }] });

    assert.deepEqual(await api.get('/users', { query: { page: 2 } }), [{ id: 1 }]);
    // The transport saw the raw relative url; pathname/query were still parsed.
    assert.equal(http.lastCall?.url, '/users?page=2');
    assert.equal(http.lastCall?.pathname, '/users');
    assert.equal(http.lastCall?.query.get('page'), '2');
  });

  test('the same string pattern matches unchanged when the client has a baseURL', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, baseURL: 'https://api.test/v1' });
    http.get('/v1/users', { json: 'ok' });

    assert.equal(await api.get('/users'), 'ok');
    assert.equal(http.lastCall?.url, 'https://api.test/v1/users');
    assert.equal(http.lastCall?.pathname, '/v1/users');
  });

  test('a protocol-relative url parses and matches by pathname', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/z', { json: 'ok' });

    assert.equal(await api.get('//host.test/z'), 'ok');
    assert.equal(http.lastCall?.url, '//host.test/z');
    assert.equal(http.lastCall?.pathname, '/z');
  });

  test('a string containing :// matches origin + pathname instead', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('http://host.test/z', { json: 'origin' });

    assert.equal(await api.get('//host.test/z?q=1'), 'origin'); // query ignored
    await assert.rejects(
      () => api.get('//other.test/z'),
      (err: Error) => err.name === 'MockRouteError',
    );
  });

  test('a RegExp tests the RAW un-normalized url, and a /g flag cannot poison the next dispatch', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.post(/\/notifications\/[^/]+\/archive$/g, { json: { ok: true } });

    assert.deepEqual(await api.post('/notifications/abc123/archive'), { ok: true });
    assert.deepEqual(await api.post('/notifications/def456/archive'), { ok: true }); // lastIndex reset
  });

  test('a predicate receives the full MockCall', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get((call) => call.query.get('q') === 'hit', { json: 'found' });

    assert.equal(await api.get('/search', { query: { q: 'hit' } }), 'found');
    await assert.rejects(
      () => api.get('/search', { query: { q: 'miss' } }),
      (err: Error) => err.name === 'MockRouteError',
    );
  });

  test(':name segments and trailing * throw at registration (reserved syntax)', () => {
    const http = mockFetch();
    assert.throws(() => http.get('/users/:id', { json: 1 }), /reserved.*RegExp or a predicate/s);
    assert.throws(() => http.get('/users/*', { json: 1 }), /reserved.*RegExp or a predicate/s);
  });

  test('newest-registered wins; any() registered first is a fallback that later routes shadow', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.any({ json: 'fallback' });
    http.get('/special', { json: 'special' });

    assert.equal(await api.get('/special'), 'special');
    assert.equal(await api.get('/anything-else'), 'fallback');
    assert.equal(await api.post('/other', { body: { a: 1 } }), 'fallback'); // any method
  });

  test('re-registering a pattern OVERRIDES it — fresh queue, no append', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', [{ json: 'old-1' }, { json: 'old-2' }]);
    assert.equal(await api.get('/x'), 'old-1'); // one entry consumed…
    http.get('/x', { json: 'new' });
    assert.equal(await api.get('/x'), 'new'); // …but the override starts fresh
    assert.equal(await api.get('/x'), 'new');
  });

  test('method matters: a GET route does not answer POST', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { json: 'get' });
    await assert.rejects(
      () => api.post('/x'),
      (err: Error) => err.name === 'MockRouteError',
    );
  });
});

suite('mockFetch: replies', () => {
  test('{ json } sets the content-type corgi sniffs — the value comes back parsed', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { json: { deep: [1, 2] } });
    assert.deepEqual(await api.get('/x'), { deep: [1, 2] });
  });

  test('{ text } comes back as a string', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/footer', { text: '<p>footer</p>' });
    assert.equal(await api.get('/footer', { responseType: 'text' }), '<p>footer</p>');
  });

  test('{ status } fills statusText from the reason-phrase table', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/down', { status: 503 });
    let err: unknown;
    await api.get('/down').catch((e: unknown) => {
      err = e;
    });
    if (!isHttpError(err)) return assert.fail('expected HttpError');
    assert.equal(err.statusText, 'Service Unavailable');
  });

  test('every dispatched Response carries the RAW request url — HttpError messages stay readable', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/missing', { status: 404, json: { error: 'nope' } });

    let err: unknown;
    await api.get('/missing', { query: { id: 9 } }).catch((e: unknown) => {
      err = e;
    });
    if (!isHttpError(err)) return assert.fail('expected HttpError');
    assert.equal(err.url, '/missing?id=9'); // raw, not http://corgi.invalid/…
    assert.equal(err.message, 'HTTP 404 Not Found (/missing?id=9)');
    assert.deepEqual(err.data, { error: 'nope' });

    const raw = await api.raw('/missing');
    assert.equal(raw.url, '/missing');
  });

  test('an array reply is a queue; the last entry sticks once exhausted', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/seq', [{ status: 503 }, { json: 'ok' }]);

    await assert.rejects(() => api.get('/seq'), isHttpError);
    assert.equal(await api.get('/seq'), 'ok');
    assert.equal(await api.get('/seq'), 'ok'); // sticks
  });

  test('a queued reply drives a real withRetry to success', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.get('/flaky', [{ status: 503 }, { json: { ok: true } }]);

    assert.deepEqual(await api.get('/flaky'), { ok: true });
    assert.equal(http.calls.length, 2); // both attempts recorded
  });

  test('networkError() is retried like a genuine network failure', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.get('/net', [networkError(), { json: 'recovered' }]);

    assert.equal(await api.get('/net'), 'recovered');
    assert.equal(http.calls.length, 2);
  });

  test("the Retry-After '0.001' lever exercises DEFAULT backoff retry in milliseconds", async () => {
    const http = mockFetch();
    // Default backoff (300ms jittered) — the header must be what keeps this fast.
    const api = corgi.create({ plugins: [withRetry({ retries: 2 })], fetch: http.fetch });
    http.get('/busy', [
      { status: 503, headers: { 'retry-after': '0.001' } },
      { status: 503, headers: { 'retry-after': '0.001' } },
      { json: 'through' },
    ]);

    const started = performance.now();
    assert.equal(await api.get('/busy'), 'through');
    assert.equal(http.calls.length, 3);
    assert.ok(performance.now() - started < 200, 'fractional Retry-After was not honored');
  });

  test('a stored Response reply survives repeat dispatch AND retry body-cancel', async () => {
    const http = mockFetch();
    const stored = new Response('"same"', { status: 200, headers: { 'content-type': 'application/json' } });
    const plain = corgi.create({ fetch: http.fetch });
    http.get('/same', stored);
    assert.equal(await plain.get('/same'), 'same');
    assert.equal(await plain.get('/same'), 'same'); // second dispatch: body still readable

    // And under retry, which CANCELS the body of every discarded response:
    const failing = new Response('"busy"', { status: 503, headers: { 'content-type': 'application/json' } });
    const api = corgi.create({ plugins: [withRetry(fast)], fetch: http.fetch });
    http.get('/busy', failing);
    let err: unknown;
    await api.get('/busy').catch((e: unknown) => {
      err = e;
    });
    if (!isHttpError(err)) return assert.fail('expected HttpError');
    assert.equal(err.status, 503);
    assert.deepEqual(err.data, 'busy'); // the FINAL dispatch's body parsed fine
  });

  test('a Response whose body was already read is refused at REGISTRATION', async () => {
    const http = mockFetch();
    const drained = new Response('"gone"');
    await drained.text();
    // At dispatch this would surface as `TypeError: Body is unusable`, which
    // withRetry would treat as a flaky network and retry.
    assert.throws(() => http.get('/x', drained), /already been read.*nothing left to replay/s);
  });

  test('a Response re-registered AFTER it was replayed is still accepted (no false positive)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    const shared = new Response('"shared"', { headers: { 'content-type': 'application/json' } });

    http.get('/a', shared);
    assert.equal(await api.get('/a'), 'shared');
    assert.equal(shared.bodyUsed, true); // drained into the buffer, not lost

    http.get('/b', shared); // must NOT throw — the buffered copy is replayable
    assert.equal(await api.get('/b'), 'shared');
  });

  test('an Error reply rejects the dispatch as a transport failure', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/boom', new Error('wire cut'));
    await assert.rejects(() => api.get('/boom'), /wire cut/);
  });

  test('a function reply computes per dispatch (and may return another reply form)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.post('/echo', (call) => ({ json: { got: call.json<{ n: number }>().n } }));

    assert.deepEqual(await api.post('/echo', { body: { n: 7 } }), { got: 7 });
    assert.deepEqual(await api.post('/echo', { body: { n: 8 } }), { got: 8 });
  });

  test('an HttpError in reply position throws at REGISTRATION, teaching the layer split', () => {
    const http = mockFetch();
    assert.throws(() => http.get('/x', httpError(500)), /pipeline's OUTPUT.*throwOnError/s);
  });

  test('an HttpError returned from a function reply throws at DISPATCH', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', () => httpError(500));
    await assert.rejects(() => api.get('/x'), /pipeline's OUTPUT/);
  });

  test('a body on a null-body status throws helpfully at registration', () => {
    const http = mockFetch();
    assert.throws(() => http.get('/x', { status: 204, body: 'nope' }), /204.*cannot carry a body/s);
    assert.throws(() => http.get('/x', { json: 1, status: 304 }), /304.*cannot carry a body/s);
    http.get('/x', { status: 204 }); // bodyless is fine
  });

  test('a status outside 200-599 throws helpfully at registration', () => {
    const http = mockFetch();
    assert.throws(() => http.get('/x', { status: 700 }), /only accepts 200-599/);
    assert.throws(() => http.get('/x', { status: 199 }), /only accepts 200-599/);
  });

  test('an unrecognized reply shape and an empty queue throw at registration', () => {
    const http = mockFetch();
    assert.throws(() => http.get('/x', {} as never), /unrecognized reply/);
    assert.throws(() => http.get('/x', []), /empty reply array/);
  });
});

suite('mockFetch: recording', () => {
  test('an unmatched request rejects with MockRouteError listing routes — after ONE dispatch, with no retry delay', async () => {
    const http = mockFetch();
    // Huge backoff: if MockRouteError were classified as transient, this test would hang for seconds.
    const api = corgi.create({ plugins: [withRetry({ retries: 3, backoff: 60_000 })], fetch: http.fetch });
    http.get('/registered', { json: 1 });

    const started = performance.now();
    let err: unknown;
    await api.get('/typo').catch((e: unknown) => {
      err = e;
    });
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'MockRouteError');
    assert.match(err.message, /no route matched GET \/typo/);
    assert.match(err.message, /GET \/registered/);
    assert.equal(http.calls.length, 1); // not retried
    assert.ok(performance.now() - started < 200, 'MockRouteError burned retry backoff');
    assert.equal(http.lastCall?.url, '/typo'); // recorded — the debugging thread when code swallows the rejection
  });

  test('MockRouteError hints when a route matches the url under a DIFFERENT method', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/users', { json: [] });

    const err = await api.post('/users').catch((e: unknown) => e as Error);
    assert.equal((err as Error).name, 'MockRouteError');
    assert.match((err as Error).message, /a GET route matches this url/);
    assert.match((err as Error).message, /registered for POST \(http\.post\)/);
  });

  test('no hint when nothing matches the url under any method', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/other', { json: [] });

    const err = await api.post('/users').catch((e: unknown) => e as Error);
    assert.equal((err as Error).name, 'MockRouteError');
    assert.doesNotMatch((err as Error).message, /Note:/);
  });

  test('a throwing predicate cannot mask the MockRouteError during hint probing', async () => {
    // findRoute skips matches() on method mismatch, so the hint probe runs the
    // predicate against a call it was never written for — its throw must read
    // as "no match", not replace the error it decorates.
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get(
      () => {
        throw new Error('predicate assumes GET-only calls');
      },
      { json: [] },
    );

    const err = await api.post('/users').catch((e: unknown) => e as Error);
    assert.equal((err as Error).name, 'MockRouteError');
    assert.doesNotMatch((err as Error).message, /predicate assumes/);
  });

  test('a Request input is normalized: url, method, headers, body come off the Request', async () => {
    const http = mockFetch();
    http.post('/from-request', { json: 'ok' });
    const request = new Request('http://app.test/from-request', {
      method: 'POST',
      headers: { 'x-source': 'request' },
      body: '{"n":1}',
    });

    const res = await http.fetch(request);
    assert.equal(res.status, 200);
    assert.equal(http.lastCall?.method, 'POST');
    assert.equal(http.lastCall?.url, 'http://app.test/from-request');
    assert.equal(http.lastCall?.headers.get('x-source'), 'request');
    assert.equal(http.lastCall?.body, '{"n":1}');
    assert.deepEqual(http.lastCall?.json(), { n: 1 });
    assert.equal(http.lastCall?.request, request);
  });

  test('init overrides the Request fields, like new Request(input, init)', async () => {
    const http = mockFetch();
    http.put('/from-request', { json: 'ok' });
    const request = new Request('http://app.test/from-request', {
      method: 'POST',
      headers: { 'x-source': 'request' },
      body: 'request-body',
    });

    await http.fetch(request, { method: 'PUT', headers: { 'x-source': 'init' }, body: 'init-body' });
    assert.equal(http.lastCall?.method, 'PUT');
    assert.equal(http.lastCall?.headers.get('x-source'), 'init');
    assert.equal(http.lastCall?.body, 'init-body');
  });

  test('a URL input records its href', async () => {
    const http = mockFetch();
    http.get('/u', { json: 'ok' });
    await http.fetch(new URL('http://app.test/u?q=1'));
    assert.equal(http.lastCall?.url, 'http://app.test/u?q=1');
    assert.equal(http.lastCall?.query.get('q'), '1');
  });

  test('a non-string body stays on init.body; MockCall.body is null and json() explains', async () => {
    const http = mockFetch();
    const form = new FormData();
    form.set('a', '1');
    http.post('/upload', { json: 'ok' });

    await http.fetch('/upload', { method: 'POST', body: form });
    assert.equal(http.lastCall?.body, null);
    assert.equal(http.lastCall?.init.body, form);
    assert.throws(() => http.lastCall?.json(), /no string body/);
  });

  test('json() names the request on malformed JSON', async () => {
    const http = mockFetch();
    http.post('/x', { json: 'ok' });
    await http.fetch('/x', { method: 'POST', body: '{oops' });
    assert.throws(() => http.lastCall?.json(), /POST \/x body is not valid JSON/);
  });
});

suite('mockFetch: introspection', () => {
  test('unusedRoutes lists never-dispatched routes in REGISTRATION order, and served ones drop out', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.any({ json: 'fallback' }); // registered first so specific routes shadow it
    http.get('/a', { json: 1 });
    http.post('/b', { json: 2 });

    assert.deepEqual(http.unusedRoutes, ['ANY *', 'GET /a', 'POST /b']);
    await api.get('/a');
    assert.deepEqual(http.unusedRoutes, ['ANY *', 'POST /b']);
  });

  test('the motivating scenario: a typo’d route + swallowed rejection is caught by BOTH views', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/usres', { json: [] }); // typo — never matches

    // Code under test swallows the rejection, the way real fallback code does.
    const result = await api.get('/users').catch(() => null);
    assert.equal(result, null); // the test would pass silently without teardown hygiene…

    assert.deepEqual(http.unusedRoutes, ['GET /usres']); // …but the route never served
    assert.deepEqual(
      http.unmatchedCalls.map((call) => `${call.method} ${call.url}`),
      ['GET /users'], // …and the real request went unmatched
    );
  });

  test('reset() empties unusedRoutes; a fresh mock reports none', () => {
    const http = mockFetch();
    assert.deepEqual(http.unusedRoutes, []);
    http.get('/x', { json: 1 });
    http.reset();
    assert.deepEqual(http.unusedRoutes, []);
  });

  test('re-registering an exercised pattern counts as unused again (replace semantics)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { json: 'old' });
    await api.get('/x');
    assert.deepEqual(http.unusedRoutes, []);

    http.get('/x', { json: 'new' }); // replacement route has served nothing
    assert.deepEqual(http.unusedRoutes, ['GET /x']);
  });

  test('unmatchedCalls holds the SAME objects as calls, and only the unmatched ones', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/known', { json: 1 });

    await api.get('/known');
    await api.get('/unknown').catch(() => {});
    assert.equal(http.calls.length, 2);
    assert.equal(http.unmatchedCalls.length, 1);
    assert.equal(http.unmatchedCalls[0], http.calls[1]); // identity, not a copy
  });

  test('resetCalls() and reset() both clear unmatchedCalls (always a subset of calls)', async () => {
    const http = mockFetch();
    await http.fetch('/nope').catch(() => {});
    assert.equal(http.unmatchedCalls.length, 1);
    http.resetCalls();
    assert.equal(http.unmatchedCalls.length, 0);

    await http.fetch('/nope').catch(() => {});
    http.reset();
    assert.equal(http.unmatchedCalls.length, 0);
  });

  test('a pre-aborted call is recorded in calls but NOT unmatched — it never reached routing', async () => {
    const http = mockFetch();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => http.fetch('/x', { signal: controller.signal }), isAbortError);
    assert.equal(http.calls.length, 1);
    assert.equal(http.unmatchedCalls.length, 0);
  });

  test('callsTo matches a string by pathname across queries, origins, and methods', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, baseURL: 'https://api.test' });
    http.any({ json: 'ok' });

    await api.get('/users', { query: { page: 1 } });
    await api.post('/users', { body: { name: 'Ada' } });
    await api.get('/other');

    assert.equal(http.callsTo('/users').length, 2); // query and origin ignored, like routing
    assert.equal(http.callsTo('/users', 'post').length, 1); // method any-case
    assert.deepEqual(http.callsTo('/users', 'POST')[0]?.json(), { name: 'Ada' });
    assert.equal(http.callsTo('/nope').length, 0);
  });

  test('callsTo RegExp and predicate forms mirror routing semantics', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.any({ json: 'ok' });

    await api.get('/users/1');
    await api.get('/users/2');
    await api.get('/teams/9');

    const byId = /\/users\/\d+$/g; // /g flag must not poison repeat filtering
    assert.equal(http.callsTo(byId).length, 2);
    assert.equal(http.callsTo(byId).length, 2); // lastIndex reset, same answer twice
    assert.equal(http.callsTo((call) => call.pathname.startsWith('/teams')).length, 1);
  });

  test('callsTo rejects reserved string syntax — a :id pattern would silently match nothing', () => {
    const http = mockFetch();
    assert.throws(() => http.callsTo('/users/:id'), /reserved.*RegExp or a predicate/s);
  });
});

suite('mockFetch: install', () => {
  test('install() reaches a client created BEFORE it ran; restore puts the exact original back', async () => {
    const original = globalThis.fetch;
    const api = corgi.create({ baseURL: 'https://api.test' }); // no fetch of its own — late-bound global
    const http = mockFetch();
    const restore = http.install();
    try {
      http.get('/users', { json: [{ id: 1 }] });
      assert.deepEqual(await api.get('/users'), [{ id: 1 }]);
    } finally {
      restore();
    }
    assert.equal(globalThis.fetch, original); // identity, not a lookalike
  });

  test('restore is idempotent, and install() while installed returns the SAME restore', () => {
    const original = globalThis.fetch;
    const http = mockFetch();
    const restore = http.install();
    // A second install must not capture the mock itself as "previous".
    assert.equal(http.install(), restore);
    restore();
    restore(); // no-op
    assert.equal(globalThis.fetch, original);

    // install → restore → install starts a fresh capture that still escapes.
    const again = http.install();
    assert.notEqual(again, restore);
    again();
    assert.equal(globalThis.fetch, original);
  });

  test('an originally-ABSENT global fetch is restored to absent (delete, not undefined)', () => {
    const g = globalThis as { fetch?: typeof fetch };
    const original = g.fetch;
    try {
      delete g.fetch;
      const http = mockFetch();
      const restore = http.install();
      assert.equal(typeof g.fetch, 'function');
      restore();
      assert.equal('fetch' in globalThis, false);
    } finally {
      g.fetch = original; // reinstate the real one for the rest of the suite
    }
  });

  test('reset() does not uninstall — global ownership is a separate lifecycle', async () => {
    const original = globalThis.fetch;
    const http = mockFetch();
    const restore = http.install();
    try {
      http.reset();
      http.get('/still-mocked', { json: 'yes' });
      const res = await fetch('https://x.test/still-mocked');
      assert.equal(res.status, 200);
    } finally {
      restore();
    }
    assert.equal(globalThis.fetch, original);
  });

  test('two mocks nest LIFO: each restore reinstates what that install captured', () => {
    const original = globalThis.fetch;
    const a = mockFetch();
    const b = mockFetch();
    const restoreA = a.install();
    const restoreB = b.install(); // captures a's transport
    assert.equal(globalThis.fetch, b.fetch);
    restoreB();
    assert.equal(globalThis.fetch, a.fetch);
    restoreA();
    assert.equal(globalThis.fetch, original);
  });
});

suite('mockFetch: signals & hangs', () => {
  test('an already-aborted signal rejects with its reason BEFORE matching', async () => {
    const http = mockFetch();
    let dispatched = 0;
    http.any(() => {
      dispatched++;
      return { json: 'never' };
    });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => http.fetch('/x', { signal: controller.signal }), isAbortError);
    assert.equal(dispatched, 0); // no reply consumed
    assert.equal(http.calls.length, 1); // but the attempt IS recorded
  });

  test('{ hang: true } rejects with the signal reason VERBATIM — abort stays abort, timeout stays timeout', async () => {
    const http = mockFetch();
    http.get('/slow', { hang: true });

    const aborter = new AbortController();
    const aborted = http.fetch('/slow', { signal: aborter.signal });
    aborter.abort();
    await assert.rejects(aborted, isAbortError);

    const timeouter = new AbortController();
    const timedOut = http.fetch('/slow', { signal: timeouter.signal });
    timeouter.abort(timeoutError());
    await assert.rejects(timedOut, isTimeoutError);
  });

  test('reset() rejects an outstanding hang with an abortError() that DIAGNOSES itself', async () => {
    const http = mockFetch();
    http.get('/slow', { hang: true });
    const pending = http.fetch('/slow');
    // Let the async dispatch reach the hang before tearing down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.reset();

    const error = await pending.catch((e: unknown) => e);
    assert.ok(isAbortError(error)); // the guards still hold — it IS an AbortError
    // …but this lands in a teardown hook with a stack pointing into the mock, so
    // the message has to carry the explanation the stack can't.
    assert.match((error as Error).message, /mockFetch\.reset\(\) cancelled a request/);
    assert.match((error as Error).message, /UNHANDLED REJECTION/);
  });

  test('resetCalls() clears the log but touches nothing in flight', async () => {
    const http = mockFetch();
    http.get('/slow', { hang: true });
    http.get('/quick', { json: 'ok' });
    await http.fetch('/quick');
    const pending = http.fetch('/slow');

    http.resetCalls();
    assert.equal(http.calls.length, 0);
    const state = await Promise.race([
      pending.then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    assert.equal(state, 'pending'); // the hang survived
    http.reset(); // and clean it up
    await assert.rejects(pending, isAbortError);
  });

  test('reset() clears routes and calls', async () => {
    const http = mockFetch();
    http.get('/x', { json: 1 });
    await http.fetch('/x');
    http.reset();
    assert.equal(http.calls.length, 0);
    await assert.rejects(
      () => http.fetch('/x'),
      (err: Error) => err.name === 'MockRouteError' && /no routes registered/.test(err.message),
    );
  });
});

suite('mockFetch: delay', () => {
  test('{ delay } answers after roughly that long (lower bound only — no flaky ceiling)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/slowish', { json: 'late', delay: 30 });

    const started = performance.now();
    assert.equal(await api.get('/slowish'), 'late');
    assert.ok(performance.now() - started >= 25, 'reply arrived before the delay elapsed');
  });

  test('settled() waits through a delayed reply', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/slowish', { json: 'late', delay: 40 });

    let value: unknown = null;
    void api.get('/slowish').then((v) => {
      value = v;
    });

    await http.settled(); // the tracker only settles when the dispatch does
    assert.equal(value, 'late');
  });

  test('aborting mid-delay rejects promptly with the signal reason VERBATIM', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/slowish', { json: 'never seen', delay: 5000 });

    const controller = new AbortController();
    const started = performance.now();
    const pending = api.get('/slowish', { signal: controller.signal });
    controller.abort(timeoutError()); // any reason — must come through untranslated
    await assert.rejects(pending, isTimeoutError);
    // Promptness is the observable face of the timer hygiene: the sleep exits
    // early instead of running out the remaining 5s.
    assert.ok(performance.now() - started < 1000, 'abort waited out the delay');
  });

  test('an invalid delay throws at registration, and at dispatch from a function reply', async () => {
    const http = mockFetch();
    assert.throws(() => http.get('/x', { json: 1, delay: -1 }), /finite number of milliseconds/);
    assert.throws(() => http.get('/x', { json: 1, delay: Number.NaN }), /finite number of milliseconds/);
    assert.throws(() => http.get('/x', { json: 1, delay: Number.POSITIVE_INFINITY }), /hang: true/);

    const api = corgi.create({ fetch: http.fetch });
    http.get('/late-check', () => ({ json: 1, delay: -5 }));
    await assert.rejects(() => api.get('/late-check'), /finite number of milliseconds/);
  });

  test('delay: 0 answers immediately (equivalent to omitting it)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/now', { json: 'now', delay: 0 });
    assert.equal(await api.get('/now'), 'now');
  });

  test('each queue entry carries its own delay', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/seq', [
      { json: 'fast', delay: 0 },
      { json: 'slow', delay: 30 },
    ]);

    assert.equal(await api.get('/seq'), 'fast');
    const started = performance.now();
    assert.equal(await api.get('/seq'), 'slow');
    assert.ok(performance.now() - started >= 25);
  });

  test('a real withTimeout beats a longer delay — the raced signal reaches the sleep', async () => {
    const http = mockFetch();
    const api = corgi.create({ plugins: [withTimeout(10)], fetch: http.fetch });
    http.get('/glacial', { json: 'never seen', delay: 5000 });

    const started = performance.now();
    await assert.rejects(() => api.get('/glacial'), isTimeoutError);
    assert.ok(performance.now() - started < 1000, 'timeout waited out the delay');
  });
});

suite('mockFetch: settled', () => {
  test('settled() waits for a request the test never awaited', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/data', { json: 'payload' });

    let rendered: unknown = null;
    // Fire-and-forget, the way a custom element's connectedCallback does it.
    void api.get('/data').then((value) => {
      rendered = value;
    });

    await http.settled();
    assert.equal(rendered, 'payload');
  });

  test('settled() covers a CHAIN — a response that fires the next request', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/first', { json: 'a' });
    http.get('/second', { json: 'b' });

    let out: unknown = null;
    void api
      .get('/first')
      .then(() => api.get('/second'))
      .then((value) => {
        out = value;
      });

    await http.settled();
    assert.equal(out, 'b');
    assert.equal(http.calls.length, 2);
  });

  test('settled() catches a follow-up the handler defers with setTimeout(0)', async () => {
    // Regression: with a single quiet-turn probe this failed deterministically.
    // The probe timer is created during the microtask drain BEFORE the
    // handler's own timer (the handler sits behind body parsing), so the first
    // probe always fired early and saw a quiet log. Two consecutive quiet
    // turns are required precisely so the handler's timer gets to run first.
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/first', { json: 'a' });
    http.get('/second', { json: 'b' });

    let out: unknown = null;
    void api.get('/first').then(() => {
      setTimeout(() => {
        void api.get('/second').then((value) => {
          out = value;
        });
      }, 0);
    });

    await http.settled();
    assert.equal(out, 'b');
    assert.equal(http.calls.length, 2);
  });

  test('settled() catches a follow-up deferred with queueMicrotask', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/first', { json: 'a' });
    http.get('/second', { json: 'b' });

    let out: unknown = null;
    void api.get('/first').then(() => {
      queueMicrotask(() => {
        void api.get('/second').then((value) => {
          out = value;
        });
      });
    });

    await http.settled();
    assert.equal(out, 'b');
  });

  test('settled() waits for real async work inside a function reply', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/slowish', async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { json: 'late' };
    });

    let value: unknown = null;
    void api.get('/slowish').then((v) => {
      value = v;
    });

    await http.settled(); // not just a microtask flush
    assert.equal(value, 'late');
  });

  test('settled() EXCLUDES { hang: true } — counting it would deadlock every abort test', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/never', { hang: true });
    http.get('/quick', { json: 'ok' });

    let quick: unknown = null;
    void api.get('/never').catch(() => {});
    void api.get('/quick').then((value) => {
      quick = value;
    });

    // The ceiling only matters when settled() deadlocks (= this test failing);
    // clear the losing timer so a passing run doesn't idle 500ms before exit.
    let deadlockTimer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      http.settled().then(() => 'settled'),
      new Promise((resolve) => {
        deadlockTimer = setTimeout(() => resolve('deadlocked'), 500);
      }),
    ]);
    clearTimeout(deadlockTimer);
    assert.equal(outcome, 'settled');
    assert.equal(quick, 'ok'); // the real request still completed first
    http.reset();
  });

  test('settled() CANNOT see a client sleeping between retry attempts (documented limitation)', async () => {
    const http = mockFetch();
    const controller = new AbortController();
    // A backoff far longer than settled()'s poll, so this is deterministic.
    const api = corgi.create({ plugins: [withRetry({ retries: 2, backoff: 1000 })], fetch: http.fetch });
    http.get('/slow-retry', [{ status: 503 }, { json: 'eventually' }]);

    const pending = api.get('/slow-retry', { signal: controller.signal }).catch((e: unknown) => e);
    await http.settled();
    // The wait lives in withRetry, OUTSIDE the transport — so the mock is idle
    // and settled() returns with the request still unfinished. This is why the
    // guide sends retry tests to the `retry-after: '0.001'` lever.
    assert.equal(http.calls.length, 1);

    controller.abort(); // don't leave a 1s timer running past the test
    await pending;
  });
});

suite('error factories', () => {
  test('httpError fills statusText and message; url patches on; data mirrors into the body', async () => {
    const bare = httpError(404);
    assert.ok(isHttpError(bare));
    assert.equal(bare.statusText, 'Not Found');
    assert.equal(bare.message, 'HTTP 404 Not Found ()');

    const full = httpError(404, { error: 'missing' }, { url: '/users/9' });
    assert.equal(full.message, 'HTTP 404 Not Found (/users/9)');
    assert.equal(full.url, '/users/9');
    assert.deepEqual(full.data, { error: 'missing' });
    assert.deepEqual(await full.response.json(), { error: 'missing' }); // body readable, like the real thing
  });

  test('httpError handles null-body statuses and rejects impossible ones', () => {
    const noContent = httpError(304, undefined, { url: '/cached' });
    assert.equal(noContent.status, 304);
    assert.throws(() => httpError(700), /only accepts 200-599/);
  });

  test('httpError accepts overrides', () => {
    const custom = httpError(418, 'short and stout', { statusText: 'Teapot' });
    assert.equal(custom.statusText, 'Teapot');
    assert.equal(custom.data, 'short and stout');
  });

  test('abortError and timeoutError satisfy the name-based guards', () => {
    assert.ok(isAbortError(abortError()));
    assert.ok(isTimeoutError(timeoutError()));
    assert.equal(abortError('gone').message, 'gone');
  });

  test('networkError defaults to undici’s literal message', () => {
    assert.equal(networkError().message, 'fetch failed');
    assert.ok(networkError() instanceof TypeError);
  });
});
