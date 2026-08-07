import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { corgi, isHttpError, isAbortError } from '../src/index.ts';
import { json, slow } from './helpers.ts';

suite('corgi', () => {
  test('get parses JSON into the returned value', async () => {
    const api = corgi.create({ fetch: async () => json({ id: 1, name: 'Ada' }) });
    const user = await api.get<{ id: number; name: string }>('/u');
    assert.deepEqual(user, { id: 1, name: 'Ada' });
  });

  test('builds baseURL + query, serializes JSON body, merges headers, sets method', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const api = corgi.create({
      baseURL: 'https://api.test/v1',
      headers: { 'x-a': '1' },
      fetch: async (url, init) => {
        captured = { url: String(url), init: init! };
        return json({});
      },
    });

    await api.post('/users', {
      query: { page: 2, tag: ['x', 'y'] },
      body: { name: 'Ada' },
      headers: { 'x-b': '2' },
    });

    assert.equal(captured!.url, 'https://api.test/v1/users?page=2&tag=x&tag=y');
    const h = new Headers(captured!.init.headers);
    assert.equal(h.get('content-type'), 'application/json');
    assert.equal(h.get('x-a'), '1');
    assert.equal(h.get('x-b'), '2');
    assert.equal(captured!.init.body, JSON.stringify({ name: 'Ada' }));
    assert.equal(captured!.init.method, 'POST');
  });

  test('throws HttpError on non-2xx with a usable response and parsed data', async () => {
    const api = corgi.create({ fetch: async () => json({ error: 'boom' }, { status: 500 }) });

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
    const api = corgi.create({ fetch: async () => new Response('nope', { status: 404 }) });
    const res = await api.raw('/x');
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'nope');
  });

  test('throwOnError:false returns the parsed body even on non-2xx', async () => {
    const api = corgi.create({ fetch: async () => json({ error: 'boom' }, { status: 500 }) });
    const data = await api.get('/x', { throwOnError: false });
    assert.deepEqual(data, { error: 'boom' });
  });

  test('throwOnError predicate throws selectively by status', async () => {
    // One client, one policy: throw 5xx, hand back 4xx bodies.
    const api = corgi.create({
      fetch: async (url) => json({ where: String(url) }, { status: String(url).endsWith('/boom') ? 500 : 404 }),
      throwOnError: (status) => status >= 500,
    });

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
    const api = corgi.create({ fetch: async () => json({ a: 1 }) });
    const text = await api.get('/x', { responseType: 'text' });
    assert.equal(text, '{"a":1}');
  });

  test('transform maps the parsed value and drives the return type', async () => {
    const api = corgi.create({ fetch: async () => json({ id: 5 }) });
    const id = await api.get('/x', { transform: (v) => (v as { id: number }).id });
    assert.equal(id, 5);
  });

  test('a caller-supplied signal passes through and aborts the request', async () => {
    const api = corgi.create({ fetch: slow });
    const controller = new AbortController();
    const pending = api.get('/x', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (err: unknown) => isAbortError(err));
  });

  test('extend combines headers and keeps defaults', async () => {
    let captured: Headers | undefined;
    const base = corgi.create({
      headers: { 'x-base': 'b' },
      fetch: async (_url, init) => {
        captured = new Headers(init!.headers);
        return json({});
      },
    });
    const child = base.extend({ headers: { 'x-child': 'c' } });
    await child.get('/x');
    assert.equal(captured!.get('x-base'), 'b');
    assert.equal(captured!.get('x-child'), 'c');
  });

  test('extend drops an inherited header when given an empty value', async () => {
    let captured: Headers | undefined;
    const base = corgi.create({
      headers: { authorization: 'Bearer t', 'x-keep': 'k' },
      fetch: async (_url, init) => {
        captured = new Headers(init!.headers);
        return json({});
      },
    });

    await base.extend({ headers: { authorization: '' } }).get('/x');
    assert.equal(captured!.has('authorization'), false); // removed, not sent empty
    assert.equal(captured!.get('x-keep'), 'k'); // siblings survive

    await base.get('/x'); // and the parent is untouched
    assert.equal(captured!.get('authorization'), 'Bearer t');
  });

  test('an empty per-call content-type strips the auto JSON one', async () => {
    let captured: Headers | undefined;
    const api = corgi.create({
      fetch: async (_url, init) => {
        captured = new Headers(init!.headers);
        return json({});
      },
    });
    // Lets the runtime set its own content-type (e.g. a multipart boundary).
    await api.post('/x', { body: { a: 1 }, headers: { 'content-type': '' } });
    assert.equal(captured!.has('content-type'), false);
  });

  test('a ReadableStream body is passed through with duplex: half', async () => {
    let captured: RequestInit | undefined;
    const api = corgi.create({
      fetch: async (_url, init) => {
        captured = init!;
        return json({});
      },
    });
    const body = new ReadableStream();
    await api.post('/x', { body });
    assert.equal(captured!.body, body); // not JSON-stringified
    assert.equal((captured as RequestInit & { duplex?: string }).duplex, 'half');
  });

  test('HEAD and 204 responses resolve to undefined', async () => {
    const head = corgi.create({ fetch: async () => json({ a: 1 }) });
    assert.equal(await head.head('/x'), undefined);

    const noContent = corgi.create({ fetch: async () => new Response(null, { status: 204 }) });
    assert.equal(await noContent.get('/x'), undefined);
  });

  test('HttpError.data is the parsed text for a non-JSON error body', async () => {
    const api = corgi.create({
      fetch: async () => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain' } }),
    });
    let err: unknown;
    await api.get('/x').catch((e: unknown) => {
      err = e;
    });
    if (!isHttpError(err)) return assert.fail(`expected HttpError, got ${String(err)}`);
    assert.equal(err.data, 'boom');
  });

  test('an absolute URL ignores baseURL', async () => {
    let captured: string | undefined;
    const api = corgi.create({
      baseURL: 'https://api.test/v1',
      fetch: async (url) => {
        captured = String(url);
        return json({});
      },
    });
    await api.get('https://other.com/x');
    assert.equal(captured, 'https://other.com/x');
  });
});
