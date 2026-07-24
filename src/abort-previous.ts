/**
 * abort-previous.ts — `abortPrevious`, exported at "@itsy/corgi/abort-previous".
 *
 * The classic "search-as-you-type" primitive: whenever a new request starts, the
 * previous in-flight one (from the same pipeline) is aborted. Keyless by design —
 * one plugin instance == one logical stream (e.g. one search box). This is the
 * spiritual successor to @itsy/abortable, and it fixes that library's bug of
 * reusing a single AbortController (which stays "aborted" forever after the first
 * cancel); here we mint a FRESH controller per call.
 *
 * State note: the "current request" lives in this plugin's closure. Because
 * `corgi` builds its pipeline once, that state persists across calls — so
 * put `abortPrevious()` at the CLIENT level. On a server, build the client
 * per-request (never share one at module scope) or unrelated requests would
 * cancel each other.
 */

import type { Fetcher, Plugin } from './core.ts';
import { ORDER, order } from './core.ts';

/**
 * Abort the previous in-flight request whenever a new one starts.
 *
 * Tagged `ORDER.cancel` (the outermost slot) so a superseding call cancels the
 * ENTIRE prior chain — including any retries or timeout it had running.
 *
 *   import { withTimeout } from '@itsy/corgi/timeout'
 *   const search = corgi({ plugins: [abortPrevious(), withTimeout(5000)] })
 *   search.get('/search', { query: { q } }) // each keystroke aborts the last
 *
 * The superseded request rejects with an `AbortError`; in typeahead you normally
 * ignore that rejection (it's expected, not a real failure).
 */
export function abortPrevious(): Plugin {
  return order(ORDER.cancel, (next: Fetcher): Fetcher => {
    // One slot for this plugin instance. Undefined when nothing is in flight.
    let current: AbortController | undefined;

    return (url, init = {}) => {
      // A new call supersedes the old one: abort whatever was running.
      current?.abort(new DOMException('Superseded by a newer request', 'AbortError'));

      // Fresh controller per call — never reuse one (that was @itsy/abortable's bug).
      const controller = new AbortController();
      current = controller;

      // Merge the caller's own signal in manually (not via AbortSignal.any, which
      // has Node bugs): forward its abort, carrying its reason, and handle the
      // already-aborted case up front since a `{ once: true }` listener wouldn't fire.
      const caller = init.signal ?? undefined;
      if (caller?.aborted) controller.abort(caller.reason);
      const onAbort = () => controller.abort(caller!.reason);
      caller?.addEventListener('abort', onAbort, { once: true });

      return next(url, { ...init, signal: controller.signal }).finally(() => {
        caller?.removeEventListener('abort', onAbort);
        // Clear the slot only if we're still the latest call, so we never wipe a
        // newer request's controller that has since taken the slot.
        if (current === controller) current = undefined;
      });
    };
  });
}
