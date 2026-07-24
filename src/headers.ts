/**
 * headers.ts — merge several header sources into one case-insensitive set.
 *
 * You cannot merge headers with a plain object spread: `{ 'Content-Type': a }`
 * and `{ 'content-type': b }` are two different keys to an object, so both would
 * be sent. Routing everything through the `Headers` class collapses them
 * case-insensitively — the only correct way to do this.
 */

/**
 * Merge header sources left-to-right; later sources win on conflict. Falsy
 * sources are ignored, so you can pass `undefined` freely:
 *
 *   mergeHeaders(autoContentType, client.headers, perCall.headers)
 *
 * (Auto content-type goes first so an explicit caller header always overrides it.)
 */
export function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const result = new Headers();
  for (const source of sources) {
    if (!source) continue;
    // `new Headers(source)` normalizes objects/arrays/Headers alike; `.set`
    // (not `.append`) means a later source replaces rather than duplicates.
    new Headers(source).forEach((value, key) => result.set(key, value));
  }
  return result;
}
