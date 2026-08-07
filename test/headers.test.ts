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

  test('an empty value REMOVES a key an earlier source set', () => {
    const h = mergeHeaders({ authorization: 'Bearer t' }, { authorization: '' });
    assert.equal(h.has('authorization'), false); // gone, not empty-valued
    let count = 0;
    h.forEach(() => count++);
    assert.equal(count, 0);
  });

  test('removal works from every input shape, and is case-insensitive', () => {
    // All three normalize through `new Headers`, so the rule needs no special-casing.
    const sources: HeadersInit[] = [{ 'x-a': '' }, [['x-a', '']], new Headers({ 'x-a': '' })];
    for (const source of sources) {
      assert.equal(mergeHeaders({ 'x-a': '1' }, source).has('x-a'), false);
    }
    assert.equal(mergeHeaders({ 'X-A': '1' }, { 'x-a': '' }).has('x-a'), false);
  });

  test('removing an unset key is a no-op, and a later source can re-add', () => {
    assert.equal(mergeHeaders({ 'x-a': '' }).has('x-a'), false);
    assert.equal(mergeHeaders({ 'x-a': '1' }, { 'x-a': '' }, { 'x-a': '2' }).get('x-a'), '2');
  });
});
