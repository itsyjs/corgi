/**
 * abort-previous.ts — `abortPrevious`, exported at "@itsy/corgi/abort-previous".
 *
 * The classic search-as-you-type primitive: a new request aborts the previous
 * in-flight one from the same pipeline. Keyless by design — one plugin instance
 * == one logical stream. Spiritual successor to @itsy/abortable, minus that
 * library's bug of reusing a single AbortController (which stays "aborted"
 * forever after the first cancel); here every call mints a fresh one.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/**
 * Abort the previous in-flight request whenever a new one starts.
 *
 * Tagged `ORDER.cancel` (the outermost slot) so a superseding call cancels the
 * entire prior chain — including any retries or timeout it had running. The
 * superseded request rejects with an `AbortError` (detect with `isAbortError`;
 * it reads the same as a caller cancel).
 *
 *   import { corgi, isAbortError } from '@itsy/corgi'
 *   import { abortPrevious } from '@itsy/corgi/abort-previous'
 *
 *   // Plugins are client-level — build the client once and reuse it.
 *   const search = corgi.create({ plugins: [abortPrevious()] })
 *   try {
 *     const hits = await search.get('/search', { query: { q } }) // each call aborts the last
 *   } catch (err) {
 *     if (isAbortError(err)) return // superseded — expected, ignore
 *     throw err
 *   }
 *
 * Stateful: the current request lives in a closure built when the pipeline is
 * composed, so keep it at the client level (one instance == one logical stream,
 * e.g. one search box). On a server, build the client per request — sharing one
 * at module scope lets unrelated requests cancel each other.
 */
export function abortPrevious(): Plugin {
  return order(ORDER.cancel, (next: Fetcher): Fetcher => {
    // One slot per plugin instance; undefined when nothing is in flight.
    let current: AbortController | undefined;

    return (url, init = {}) => {
      current?.abort(new DOMException('Superseded by a newer request', 'AbortError'));

      // Fresh controller per call — never reuse one (that was @itsy/abortable's bug).
      const controller = new AbortController();
      current = controller;

      // Merge the caller's signal in manually (not via AbortSignal.any, which
      // has Node bugs): forward its abort, carrying its reason, and handle the
      // already-aborted case up front since a `{ once: true }` listener wouldn't fire.
      const callerSignal = init.signal ?? undefined;
      if (callerSignal?.aborted) controller.abort(callerSignal.reason);
      const onAbort = () => controller.abort(callerSignal!.reason);
      callerSignal?.addEventListener('abort', onAbort, { once: true });

      return next(url, { ...init, signal: controller.signal }).finally(() => {
        callerSignal?.removeEventListener('abort', onAbort);
        // Only the latest call may clear the slot — never wipe a newer request's controller.
        if (current === controller) current = undefined;
      });
    };
  });
}
