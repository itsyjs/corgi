/**
 * url.ts — base-URL joining and query-string building.
 *
 * Both are deliberately small and predictable. The one thing worth knowing:
 * `joinURL` does a PREFIX join, not `new URL(path, base)`. The URL constructor
 * silently drops the base's path when `path` starts with `/`
 * (`new URL('/users', 'https://api.com/v1')` -> `https://api.com/users`, the
 * `/v1` is gone). That's a classic production footgun, so we join manually.
 */

/** A single query value. `null`/`undefined` are OMITTED from the string entirely
 * — never sent as `key=` or a bare `key`. */
export type QueryValue = string | number | boolean | null | undefined;
/** The `query` object. Arrays expand to repeated keys (`{ tag: ['a','b'] }` ->
 * `tag=a&tag=b`); an empty array omits the key. See `RequestOptions.query`. */
export type Query = Record<string, QueryValue | ReadonlyArray<string | number | boolean>>;

/**
 * Join a base URL and a path, preserving the base's own path segment.
 *
 *   joinURL('https://api.com/v1', 'users')   -> 'https://api.com/v1/users'
 *   joinURL('https://api.com/v1/', '/users') -> 'https://api.com/v1/users'
 *   joinURL('/api', 'users')                 -> '/api/users'
 *
 * An absolute URL (or protocol-relative `//host/...`) in `path` bypasses the
 * base entirely — so you can always override on a per-call basis.
 */
export function joinURL(base: string | undefined, path: string): string {
  if (!base) return path;
  // Absolute (`https://...`) or protocol-relative (`//host`) paths ignore base.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('//')) return path;
  // Trim a trailing slash from base and a leading slash from path, then join
  // with exactly one slash between them.
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Merge a query object into a URL, preserving any existing query string and the
 * URL's `#hash`.
 *
 *   - `null`/`undefined` values are skipped entirely (no `?x=undefined`). We do
 *     NOT emit a value-less `?flag` for `null` the way ufo/ofetch do: the web
 *     platform's `URLSearchParams` can't represent a bare key — it normalizes
 *     `?flag` to `flag=` — so neither do we. Nullish == omit, matching axios.
 *   - Arrays expand to repeated keys: `{ tag: ['a','b'] }` -> `tag=a&tag=b`
 *     (the most widely server-compatible convention). An empty array omits the
 *     key; `null`/`undefined` items are skipped.
 *   - Scalar values REPLACE any same-named param already in the URL; array
 *     values also replace first, then append each item.
 *   - Values (and keys) are encoded by `URLSearchParams` (space -> `+`,
 *     `&` -> `%26`, unicode -> UTF-8 %-escapes). Note this also re-normalizes a
 *     pre-existing bare param in the URL: `?test` becomes `test=`.
 */
export function withQuery(url: string, query?: Query): string {
  if (!query) return url;

  // Split off the hash so it always stays at the very end.
  const hashIndex = url.indexOf('#');
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);

  // Split path from any existing query so we can merge into it.
  const queryIndex = withoutHash.indexOf('?');
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? '' : withoutHash.slice(queryIndex + 1));

  for (const [key, value] of Object.entries(query)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      params.delete(key); // caller-supplied array wins over anything already there
      for (const item of value) if (item != null) params.append(key, String(item));
    } else {
      params.set(key, String(value)); // scalar overrides any existing same-named param
    }
  }

  const qs = params.toString();
  return (qs ? `${path}?${qs}` : path) + hash;
}
