import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseResponse } from '../src/parse.ts';

const jsonRes = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } });

suite('parseResponse', () => {
  test('parses JSON bodies', async () => {
    assert.deepEqual(await parseResponse(jsonRes('{"a":1}')), { a: 1 });
  });

  test('empty JSON body yields undefined instead of throwing', async () => {
    assert.equal(await parseResponse(jsonRes('')), undefined);
  });

  test('text content-type returns a string', async () => {
    const res = new Response('hello', { headers: { 'content-type': 'text/plain' } });
    assert.equal(await parseResponse(res), 'hello');
  });

  test('no-body statuses and HEAD short-circuit to undefined', async () => {
    assert.equal(await parseResponse(new Response(null, { status: 204 })), undefined);
    assert.equal(await parseResponse(jsonRes('{"a":1}'), 'HEAD'), undefined);
  });

  test('responseType override wins over content-type', async () => {
    // JSON content-type but asked for text -> raw string.
    assert.equal(await parseResponse(jsonRes('{"a":1}'), 'GET', 'text'), '{"a":1}');
  });

  test('explicit responseType:text keeps a raw empty string; sniffed text empties to undefined', async () => {
    // Explicit override: an empty body stays the raw '' ...
    const explicit = new Response('', { headers: { 'content-type': 'text/plain' } });
    assert.equal(await parseResponse(explicit, 'GET', 'text'), '');
    // ... but a SNIFFED text/unknown empty body collapses to undefined.
    const sniffed = new Response('', { headers: { 'content-type': 'text/plain' } });
    assert.equal(await parseResponse(sniffed), undefined);
  });

  test('responseType covers blob / arrayBuffer / formData / stream', async () => {
    assert.ok((await parseResponse(new Response('x'), 'GET', 'blob')) instanceof Blob);
    assert.ok((await parseResponse(new Response('x'), 'GET', 'arrayBuffer')) instanceof ArrayBuffer);

    const fd = new FormData();
    fd.set('a', '1');
    const parsed = await parseResponse(new Response(fd), 'GET', 'formData');
    assert.ok(parsed instanceof FormData);
    assert.equal((parsed as FormData).get('a'), '1');

    const stream = await parseResponse(new Response('x'), 'GET', 'stream');
    assert.ok(stream instanceof ReadableStream);
  });

  test('parses structured-suffix +json content types', async () => {
    const problem = new Response('{"a":1}', { headers: { 'content-type': 'application/problem+json' } });
    assert.deepEqual(await parseResponse(problem), { a: 1 });
    const jsonapi = new Response('{"a":1}', { headers: { 'content-type': 'application/vnd.api+json' } });
    assert.deepEqual(await parseResponse(jsonapi), { a: 1 });
  });

  test('parses application/json with a charset parameter', async () => {
    const res = new Response('{"a":1}', { headers: { 'content-type': 'application/json; charset=utf-8' } });
    assert.deepEqual(await parseResponse(res), { a: 1 });
  });

  test('binary content-type returns a Blob', async () => {
    const res = new Response('x', { headers: { 'content-type': 'application/octet-stream' } });
    assert.ok((await parseResponse(res)) instanceof Blob);
  });

  test('205 and a lowercase "head" method also short-circuit to undefined', async () => {
    assert.equal(await parseResponse(new Response(null, { status: 205 })), undefined);
    assert.equal(await parseResponse(jsonRes('{"a":1}'), 'head'), undefined);
  });

  test('a missing content-type is treated as text, never guessed as JSON', async () => {
    // `new Response('x')` auto-sets text/plain, so mock a genuinely header-less response.
    const res = { status: 200, headers: new Headers(), text: async () => 'plain' } as unknown as Response;
    assert.equal(await parseResponse(res), 'plain');
  });
});
