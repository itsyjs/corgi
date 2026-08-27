/**
 * headers.ts — merge several header sources into one case-insensitive set.
 *
 * A plain object spread can't do this: `{ 'Content-Type': a }` and
 * `{ 'content-type': b }` are two different keys, so both would be sent.
 * Routing everything through the `Headers` class collapses them.
 */

/**
 * Merge header sources left-to-right; later sources win on conflict. Falsy
 * sources are ignored, so you can pass `undefined` freely:
 *
 *   mergeHeaders(autoContentType, client.headers, perCall.headers)
 *
 * (Auto content-type goes first so an explicit caller header always overrides it.)
 *
 * An empty value removes the key rather than setting it, which is how a later
 * source drops a header an earlier one set:
 *
 *   mergeHeaders({ authorization: 'Bearer t' }, { authorization: '' })  // -> {}
 */
export function mergeHeaders(...sources: Array<HeadersInit | undefined>): Headers {
  const result = new Headers();
  for (const source of sources) {
    if (!source) continue;
    // `new Headers(source)` normalizes objects/arrays/Headers alike; `.set`
    // (not `.append`) means a later source replaces rather than duplicates.
    // The trade of empty-removes: a genuinely empty-string header can't be sent.
    new Headers(source).forEach((value, key) => (value ? result.set(key, value) : result.delete(key)));
  }
  return result;
}
