import { suite, test } from 'node:test';
import assert from 'node:assert/strict';
import { compose, order, ORDER, corgi, type Fetcher, type Plugin } from '../src/index.ts';

suite('compose', () => {
  test('compose applies plugins outermost-first', async () => {
    const calls: string[] = [];
    const tap =
      (name: string): Plugin =>
      (next: Fetcher): Fetcher =>
      async (url, init) => {
        calls.push(`>${name}`);
        const res = await next(url, init);
        calls.push(`<${name}`);
        return res;
      };

    const base: Fetcher = async () => new Response('ok');
    const pipeline = compose(tap('a'), tap('b'))(base);
    await pipeline('/x');

    // a is outermost: enters first, exits last.
    assert.deepEqual(calls, ['>a', '>b', '<b', '<a']);
  });

  test('compose with no base uses a bind-safe global fetch (no Illegal invocation)', () => {
    // Just constructing the pipeline must not throw; calling it would hit the network.
    const pipeline = compose()();
    assert.equal(typeof pipeline, 'function');
  });

  test('compose sorts tagged plugins by ORDER, regardless of array order', async () => {
    const calls: string[] = [];
    const tap = (name: string, slot: number): Plugin =>
      order(
        slot,
        (next: Fetcher): Fetcher =>
          async (url, init) => {
            calls.push(`>${name}`);
            const res = await next(url, init);
            calls.push(`<${name}`);
            return res;
          },
      );

    const base: Fetcher = async () => new Response('ok');
    // Listed inner-first, but compose must run `outer` (cancel, 100) outermost.
    const pipeline = compose(tap('inner', ORDER.timeout), tap('outer', ORDER.cancel))(base);
    await pipeline('/x');

    assert.deepEqual(calls, ['>outer', '>inner', '<inner', '<outer']);
  });

  test('compose is stable: untagged plugins keep insertion order and sit at DEFAULT_ORDER', async () => {
    const calls: string[] = [];
    const tap = (name: string, slot?: number): Plugin => {
      const fn =
        (next: Fetcher): Fetcher =>
        async (url, init) => {
          calls.push(name);
          return next(url, init);
        };
      return slot === undefined ? (fn as Plugin) : order(slot, fn);
    };

    const base: Fetcher = async () => new Response('ok');
    // Two untagged (default 250, kept in insertion order) then a timeout-tagged one
    // (400) which must land innermost.
    const pipeline = compose(tap('a'), tap('b'), tap('inner', ORDER.timeout))(base);
    await pipeline('/x');

    assert.deepEqual(calls, ['a', 'b', 'inner']);
  });

  test('corgi applies plugins in ORDER, regardless of array order', async () => {
    const calls: string[] = [];
    const tap = (name: string, slot: number): Plugin =>
      order(
        slot,
        (next: Fetcher): Fetcher =>
          async (url, init) => {
            calls.push(`>${name}`);
            const res = await next(url, init);
            calls.push(`<${name}`);
            return res;
          },
      );

    // Listed inner-first, but the client must run `outer` (cancel, 100) outermost.
    const api = corgi.create({
      fetch: async () => new Response('ok'),
      plugins: [tap('inner', ORDER.timeout), tap('outer', ORDER.cancel)],
    });
    await api.raw('/x');

    assert.deepEqual(calls, ['>outer', '>inner', '<inner', '<outer']);
  });
});

suite('order', () => {
  test('order() tags a plugin with its slot', () => {
    const p = order(ORDER.retry, (next: Fetcher): Fetcher => next);
    assert.equal(p.order, ORDER.retry);
  });
});
