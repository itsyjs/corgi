import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isHttpError, isAbortError } from '#index';
import { mockFetch } from '#testing';

// This suite doubles as the dogfood consumer for `@itsy/corgi/testing`: every
// test drives the REAL pipeline through `mockFetch` instead of a hand-rolled
// captured/counter closure — url building is asserted off `lastCall`, not off
// a `let captured` re-declared per test.

suite('corgi', () => {
  test('get parses JSON into the returned value', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/u', { json: { id: 1, name: 'Ada' } });
    const user = await api.get<{ id: number; name: string }>('/u');
    assert.deepEqual(user, { id: 1, name: 'Ada' });
  });

  test('builds baseURL + query, serializes JSON body, merges headers, sets method', async () => {
    const http = mockFetch();
    const api = corgi.create({
      baseURL: 'https://api.test/v1',
      headers: { 'x-a': '1' },
      fetch: http.fetch,
    });
    http.post('/v1/users', { json: {} });

    await api.post('/users', {
      query: { page: 2, tag: ['x', 'y'] },
      body: { name: 'Ada' },
      headers: { 'x-b': '2' },
    });

    const call = http.lastCall!;
    assert.equal(call.url, 'https://api.test/v1/users?page=2&tag=x&tag=y');
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.equal(call.headers.get('x-a'), '1');
    assert.equal(call.headers.get('x-b'), '2');
    assert.equal(call.body, JSON.stringify({ name: 'Ada' }));
    assert.deepEqual(call.json(), { name: 'Ada' });
    assert.equal(call.method, 'POST');
  });

  test('throws HttpError on non-2xx with a usable response and parsed data', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { json: { error: 'boom' }, status: 500 });

    // Capture the rejection ourselves (assert.rejects wants a *sync* validator).
    let err: unknown;
    await api.get('/x').then(
      () => assert.fail('expected the request to reject'),
      (e: unknown) => {
        err = e;
      },
    );

    if (!isHttpError(err)) return assert.fail(`expected HttpError, got ${String(err)}`);
    assert.equal(err.status, 500);
    assert.deepEqual(err.data, { error: 'boom' });
    // response was cloned before reading .data, so it's still readable:
    assert.deepEqual(await err.response.json(), { error: 'boom' });
  });

  test('raw returns the Response without parsing or throwing', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { status: 404, body: 'nope' });
    const res = await api.raw('/x');
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'nope');
  });

  test('throwOnError:false returns the parsed body even on non-2xx', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { json: { error: 'boom' }, status: 500 });
    const data = await api.get('/x', { throwOnError: false });
    assert.deepEqual(data, { error: 'boom' });
  });

  test('throwOnError predicate throws selectively by status', async () => {
    // One client, one policy: throw 5xx, hand back 4xx bodies.
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch, throwOnError: (status) => status >= 500 });
    http.any((call) => ({ json: { where: call.url }, status: call.url.endsWith('/boom') ? 500 : 404 }));

    // 404 is below the threshold -> resolves with the parsed body (not thrown).
    assert.deepEqual(await api.get('/missing'), { where: '/missing' });

    // 500 is at/above the threshold -> throws HttpError.
    let err: unknown;
    await api.get('/boom').then(
      () => assert.fail('expected the request to reject'),
      (e: unknown) => {
        err = e;
      },
    );
    if (!isHttpError(err)) return assert.fail(`expected HttpError, got ${String(err)}`);
    assert.equal(err.status, 500);
  });

  test('responseType narrows parsing (text)', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { json: { a: 1 } });
    const text = await api.get('/x', { responseType: 'text' });
    assert.equal(text, '{"a":1}');
  });

  test('transform maps the parsed value and drives the return type', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { json: { id: 5 } });
    const id = await api.get('/x', { transform: (v) => (v as { id: number }).id });
    assert.equal(id, 5);
  });

  test('a caller-supplied signal passes through and aborts the request', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { hang: true });
    const controller = new AbortController();
    const pending = api.get('/x', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err));
  });

  test('extend combines headers and keeps defaults', async () => {
    const http = mockFetch();
    const base = corgi.create({ headers: { 'x-base': 'b' }, fetch: http.fetch });
    http.get('/x', { json: {} });

    const child = base.extend({ headers: { 'x-child': 'c' } });
    await child.get('/x');
    assert.equal(http.lastCall!.headers.get('x-base'), 'b');
    assert.equal(http.lastCall!.headers.get('x-child'), 'c');
  });

  test('extend drops an inherited header when given an empty value', async () => {
    const http = mockFetch();
    const base = corgi.create({ headers: { authorization: 'Bearer t', 'x-keep': 'k' }, fetch: http.fetch });
    http.get('/x', { json: {} });

    await base.extend({ headers: { authorization: '' } }).get('/x');
    assert.equal(http.lastCall!.headers.has('authorization'), false); // removed, not sent empty
    assert.equal(http.lastCall!.headers.get('x-keep'), 'k'); // siblings survive

    await base.get('/x'); // and the parent is untouched
    assert.equal(http.lastCall!.headers.get('authorization'), 'Bearer t');
  });

  test('an empty per-call content-type strips the auto JSON one', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.post('/x', { json: {} });
    // Lets the runtime set its own content-type (e.g. a multipart boundary).
    await api.post('/x', { body: { a: 1 }, headers: { 'content-type': '' } });
    assert.equal(http.lastCall!.headers.has('content-type'), false);
  });

  test('a ReadableStream body is passed through with duplex: half', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.post('/x', { json: {} });
    const body = new ReadableStream();
    await api.post('/x', { body });
    const call = http.lastCall!;
    assert.equal(call.init.body, body); // not JSON-stringified — and not consumed by the mock
    assert.equal(call.body, null); // the string arm stays null for a stream
    assert.equal((call.init as RequestInit & { duplex?: string }).duplex, 'half');
  });

  test('HEAD and 204 responses resolve to undefined', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.head('/x', { json: { a: 1 } });
    assert.equal(await api.head('/x'), undefined);

    http.get('/none', { status: 204 });
    assert.equal(await api.get('/none'), undefined);
  });

  test('HttpError.data is the parsed text for a non-JSON error body', async () => {
    const http = mockFetch();
    const api = corgi.create({ fetch: http.fetch });
    http.get('/x', { text: 'boom', status: 500 });
    let err: unknown;
    await api.get('/x').catch((e: unknown) => {
      err = e;
    });
    if (!isHttpError(err)) return assert.fail(`expected HttpError, got ${String(err)}`);
    assert.equal(err.data, 'boom');
  });

  test('an absolute URL ignores baseURL', async () => {
    const http = mockFetch();
    const api = corgi.create({ baseURL: 'https://api.test/v1', fetch: http.fetch });
    http.get('https://other.com/x', { json: {} });
    await api.get('https://other.com/x');
    assert.equal(http.lastCall!.url, 'https://other.com/x');
  });

  test('HttpError.data is undefined when the error body cannot be parsed', async () => {
    const http = mockFetch();
    http.get('/bad', { status: 500, body: '{oops', headers: { 'content-type': 'application/json' } });
    const api = corgi.create({ fetch: http.fetch });

    await assert.rejects(api.get('/bad'), (err: unknown) => {
      assert.ok(isHttpError(err));
      assert.equal(err.data, undefined); // best-effort parse gave up, the throw still happened
      return true;
    });
  });

  test('patch and delete send their verbs', async () => {
    const http = mockFetch();
    http.patch('/x', { json: { ok: true } });
    http.delete('/x', { json: { gone: true } });
    const api = corgi.create({ fetch: http.fetch });

    assert.deepEqual(await api.patch('/x', { body: { a: 1 } }), { ok: true });
    assert.equal(http.lastCall?.method, 'PATCH');
    assert.deepEqual(await api.delete('/x'), { gone: true });
    assert.equal(http.lastCall?.method, 'DELETE');
  });
});
