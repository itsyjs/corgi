import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeBody } from '../src/body.ts';

suite('serializeBody', () => {
  test('null/undefined mean no body (not the string "null")', () => {
    assert.deepEqual(serializeBody(null), { body: null });
    assert.deepEqual(serializeBody(undefined), { body: undefined });
  });

  test('plain object/array becomes JSON with a content-type', () => {
    const out = serializeBody({ a: 1 });
    assert.equal(out.body, JSON.stringify({ a: 1 }));
    assert.equal(out.contentType, 'application/json');

    const arr = serializeBody([1, 2]);
    assert.equal(arr.body, '[1,2]');
    assert.equal(arr.contentType, 'application/json');
  });

  test('platform bodies pass through untouched (no content-type override)', () => {
    const fd = new FormData();
    assert.equal(serializeBody(fd).body, fd);
    assert.equal(serializeBody(fd).contentType, undefined);

    const usp = new URLSearchParams({ a: '1' });
    assert.equal(serializeBody(usp).body, usp);
    assert.equal(serializeBody(usp).contentType, undefined);

    assert.equal(serializeBody('raw string').body, 'raw string');
  });

  test('binary + stream + Buffer bodies pass through untouched', () => {
    const blob = new Blob(['x']);
    assert.equal(serializeBody(blob).body, blob);
    assert.equal(serializeBody(blob).contentType, undefined);

    const ab = new ArrayBuffer(8);
    assert.equal(serializeBody(ab).body, ab);

    const view = new Uint8Array([1, 2, 3]);
    assert.equal(serializeBody(view).body, view);

    const stream = new ReadableStream();
    assert.equal(serializeBody(stream).body, stream);

    // Node Buffer is a Uint8Array subclass -> caught by ArrayBuffer.isView.
    const buf = Buffer.from('x');
    assert.equal(serializeBody(buf).body, buf);
    assert.equal(serializeBody(buf).contentType, undefined);
  });
});
