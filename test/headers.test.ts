import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHeaders } from '../src/headers.ts';

suite('mergeHeaders', () => {
  test('collapses Content-Type vs content-type case-insensitively (later source wins)', () => {
    const h = mergeHeaders({ 'Content-Type': 'a' }, { 'content-type': 'b' });
    assert.equal(h.get('content-type'), 'b'); // last wins — NOT "a, b", NOT two keys
    let count = 0;
    h.forEach(() => count++);
    assert.equal(count, 1);
  });

  test('ignores falsy sources and normalizes object / array / Headers inputs', () => {
    const h = mergeHeaders(undefined, [['x-a', '1']], new Headers({ 'x-b': '2' }), { 'x-c': '3' });
    assert.equal(h.get('x-a'), '1');
    assert.equal(h.get('x-b'), '2');
    assert.equal(h.get('x-c'), '3');
  });
});
