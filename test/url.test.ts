import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { joinURL, withQuery, type Query } from '../src/url.ts';

// ---------------------------------------------------------------------------
// joinURL — prefix join (NOT `new URL`), so the base path is never dropped.
// ---------------------------------------------------------------------------
const joinCases: Array<[base: string | undefined, path: string, out: string]> = [
  ['https://a.com/v1', 'users', 'https://a.com/v1/users'],
  ['https://a.com/v1/', '/users', 'https://a.com/v1/users'],
  ['https://a.com/v1//', 'users', 'https://a.com/v1/users'], // collapse doubled slashes
  ['/api', 'users', '/api/users'], // relative base
  [undefined, '/x', '/x'], // no base -> path as-is
  ['https://a.com/v1', 'users?x=1', 'https://a.com/v1/users?x=1'], // a query in the path survives
  ['https://a.com/v1', '', 'https://a.com/v1/'], // empty path -> trailing slash
  ['https://a.com/v1', 'https://b.com/x', 'https://b.com/x'], // absolute path bypasses base
  ['https://a.com/v1', '//cdn.com/x', '//cdn.com/x'], // protocol-relative bypasses base
];

suite('joinURL', () => {
  for (const [base, path, out] of joinCases) {
    test(`${JSON.stringify(base)} + ${JSON.stringify(path)} -> ${JSON.stringify(out)}`, () => {
      assert.equal(joinURL(base, path), out);
    });
  }
});

// ---------------------------------------------------------------------------
// withQuery — merge into existing query, preserve #hash, encode via
// URLSearchParams.
//
// NOTE on `null`: we skip it (like axios), we do NOT emit a bare `?flag`. The
// web platform's URLSearchParams can't represent a value-less key (it normalizes
// `?flag` -> `flag=`), so neither do we. This is deliberate — see the two "pin"
// cases at the end.
// ---------------------------------------------------------------------------
const queryCases: Array<[url: string, query: Query | undefined, out: string]> = [
  // basics
  ['/x', { a: 1, b: undefined, c: null }, '/x?a=1'], // nullish skipped
  ['/x?z=1', { a: 2 }, '/x?z=1&a=2'], // append to existing
  ['/x', { t: ['a', 'b'] }, '/x?t=a&t=b'], // array -> repeated keys
  ['/x#frag', { a: 1 }, '/x?a=1#frag'], // hash preserved
  ['/x', undefined, '/x'], // no query -> untouched

  // encoding (the reason we route through URLSearchParams)
  ['/', { email: 'some email.com' }, '/?email=some+email.com'], // space -> +
  ['/', { 'key with space': 'spaced value' }, '/?key+with+space=spaced+value'], // keys encode too
  ['/', { s: '&', s2: '%26' }, '/?s=%26&s2=%2526'], // reserved + already-% re-encoded
  ['/', { u: '好' }, '/?u=%E5%A5%BD'], // unicode -> UTF-8 %-escapes

  // replace semantics
  ['/x?foo=1', { foo: 2 }, '/x?foo=2'], // scalar REPLACES existing same key
  ['/x?t=old', { t: ['a', 'b'] }, '/x?t=a&t=b'], // array replaces existing, then appends

  // scalar coverage
  ['/x', { n: 0, b: false }, '/x?n=0&b=false'], // 0 kept; booleans stringified

  // array item coverage
  ['/x', { t: ['3', ''] }, '/x?t=3&t='], // empty-string item kept (it isn't nullish)
  ['/x?t=1', { t: [] }, '/x'], // empty array omits the key (removes existing)

  // hash + existing query together
  ['/x?z=1#frag', { a: 2 }, '/x?z=1&a=2#frag'],

  // existing query on an absolute URL
  ['http://a.com?v=1', { x: 2 }, 'http://a.com?v=1&x=2'],

  // --- pinned (deliberate) behaviours ---
  ['/x', { flag: null }, '/x'], // null -> omitted, NOT a bare `?flag` (see note above)
  ['/x?test', { a: 1 }, '/x?test=&a=1'], // URLSearchParams normalizes a bare `?test` -> `test=`
];

suite('withQuery', () => {
  for (const [url, query, out] of queryCases) {
    test(`${JSON.stringify(url)} + ${JSON.stringify(query)} -> ${JSON.stringify(out)}`, () => {
      assert.equal(withQuery(url, query), out);
    });
  }
});
