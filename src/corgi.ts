/**
 * corgi.ts — the ergonomic client.
 *
 * `corgi.create()` returns a callable that is also an object of verb shortcuts:
 * it builds the request (base URL, query, body, headers), runs it through the
 * composed plugin pipeline from core.ts, then parses, throws on non-2xx, and
 * applies an optional `transform`. Plugins stay pure `Response -> Response`;
 * the client is the only place that knows about parsing, typed values, and
 * throwing.
 */

import { compose, resolveFetch, type Plugin } from './core.ts';
import { serializeBody } from './body.ts';
import { mergeHeaders } from './headers.ts';
import { joinURL, withQuery, type Query } from './url.ts';
import { parseResponse, type ParseAs } from './parse.ts';
import { HttpError } from './error.ts';

/** The standard HTTP methods, used to give `method` autocomplete. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * Autocompletes its literal members while accepting any other `U`. The
 * `(U & {})` trick widens the union without collapsing the literal arm (which
 * would kill autocomplete). Erased at build — costs no bytes.
 */
type LiteralUnion<T extends U, U = string> = T | (U & {});

/**
 * Maps a `responseType` to the value type it produces. `json` (the default)
 * falls through to the caller's `<T>`; the rest are fixed platform types. The
 * `[P] extends [...]` tuples stop TypeScript distributing over unions.
 */
export type MappedResponse<P extends ParseAs, T> = [P] extends ['text']
  ? string
  : [P] extends ['blob']
    ? Blob
    : [P] extends ['arrayBuffer']
      ? ArrayBuffer
      : [P] extends ['formData']
        ? FormData
        : [P] extends ['stream']
          ? ReadableStream<Uint8Array>
          : T;

/**
 * Per-call options. Extends the standard `RequestInit` minus the fields corgi
 * owns.
 *
 * Per-call options are pure per-request data. Anything that shapes the
 * middleware pipeline — `plugins`, a custom `fetch` — is client-level only
 * (`corgi.create`/`extend`), so the pipeline (and any stateful plugin's memory)
 * is built once and reused; derive a one-off variation with `.extend({...})`.
 *
 * No per-call `timeout` field: pass `signal: AbortSignal.timeout(ms)` for a
 * total deadline spanning retries, or add the client-level `withTimeout` plugin
 * for a per-attempt one.
 */
export interface RequestOptions extends Omit<RequestInit, 'body' | 'method' | 'headers'> {
  /** Typed as a {@link LiteralUnion} of the standard verbs: the common ones
   * autocomplete, any custom method string is still accepted. The verb
   * shortcuts set this for you. */
  method?: LiteralUnion<HttpMethod>;
  /**
   * Per-call headers, merged case-insensitively (`Content-Type` and
   * `content-type` collapse to one). Precedence low -> high: the auto
   * `application/json` from a plain-object body < client `headers` < these.
   */
  headers?: HeadersInit;
  /**
   * Request body. A plain object/array is JSON-encoded and sets
   * `content-type: application/json` (unless you set one). Every real
   * `BodyInit` — string, `FormData`, `Blob`/`File`, `URLSearchParams`,
   * `ReadableStream`, `ArrayBuffer`/typed arrays — passes through untouched
   * (the runtime sets e.g. the multipart boundary). `null`/`undefined` send no
   * body. A `ReadableStream` body gets `duplex: 'half'` automatically
   * (Node/undici require it) and is not retryable.
   *
   * The object arm is `object`, not `Record<string, unknown>`, so a plain
   * `interface` DTO type-checks (`Record` rejects interfaces for want of an
   * index signature, TS#15300). Trade-off: a `Map`/`Set`/class instance also
   * type-checks but stringifies as `{}` — pass a plain object or a real
   * `BodyInit`.
   */
  body?: BodyInit | object | null;
  /**
   * Merged into the URL's query string (existing params and `#hash` are kept):
   *   - arrays expand to repeated keys — `{ tag: ['a','b'] }` -> `tag=a&tag=b`;
   *   - `null`/`undefined` values (and nullish array items) are omitted — never
   *     sent as `key=` or a bare `key` (matches axios); an empty array omits the key;
   *   - a scalar replaces a same-named existing param; an array replaces then appends;
   *   - keys/values are `URLSearchParams`-encoded (space -> `+`, unicode -> UTF-8).
   */
  query?: Query;
  /** Prefix-joined with the url — the base's own path is kept (unlike `new URL`,
   * which drops it); an absolute or protocol-relative url bypasses it. */
  baseURL?: string;
  /** Force a parse mode instead of sniffing the content-type — see {@link ParseAs}.
   * Forcing `'json'` on a non-JSON body throws a `SyntaxError` (the default
   * sniffing path never does). */
  responseType?: ParseAs;
  /**
   * Throw {@link HttpError} on any non-2xx response. Default `true`. When
   * `false`, a non-2xx resolves with the parsed body — on an error that's the
   * error payload, still typed as your `<T>`, so narrow it yourself. For the
   * raw `Response` (no parse, no throw) use `.raw()`.
   *
   * A predicate `(status) => boolean` gives per-status control (`true` =
   * throw): `throwOnError: (s) => s >= 500` reads meaningful 4xx bodies while
   * still throwing on 5xx. To branch on status and remap, `try/catch` +
   * `isHttpError` reads cleaner.
   */
  throwOnError?: boolean | ((status: number) => boolean);
  /** Post-parse hook: map/validate the value. Its return type becomes the result.
   * Runs after parsing; overrides both `responseType` and `<T>`. Powers `schema()`. */
  transform?: (value: unknown, response: Response) => unknown;
}

/** Corgi-level defaults, merged into every request. */
export interface CorgiOptions {
  baseURL?: string;
  /** Default headers for every request. Merged case-insensitively; a per-call
   * `headers` entry overrides the same key here, which overrides the auto JSON
   * `content-type`. An empty value removes a header instead of setting it, so
   * `extend({ headers: { authorization: '' } })` drops an inherited one. */
  headers?: HeadersInit;
  /** Client-wide throw policy; a per-call `throwOnError` overrides it. See
   * {@link RequestOptions.throwOnError}. */
  throwOnError?: boolean | ((status: number) => boolean);
  /** Middleware plugins for this client. Built into the pipeline once, reused
   * across calls (so stateful plugins like abortPrevious keep their memory).
   * Order-sorted by their `order` hint — see {@link ORDER}. */
  plugins?: readonly Plugin[];
  fetch?: typeof fetch;
  credentials?: RequestCredentials;
  mode?: RequestMode;
  cache?: RequestCache;
  redirect?: RequestRedirect;
  referrer?: string;
  referrerPolicy?: ReferrerPolicy;
}

/**
 * The call signature set, shared by the client itself and each verb shortcut.
 * Overloads resolve the return type by priority: `transform` > `responseType` > `<T>`.
 * A no-body response (204/205/304, or any HEAD request) resolves to `undefined`
 * regardless of `<T>` — guard the value before using it.
 */
export interface Call {
  /** With a `transform`, the result type is whatever the transform returns. */
  <R>(
    url: string,
    options: RequestOptions & { transform: (value: unknown, response: Response) => R | Promise<R> },
  ): Promise<R>;
  /** With a `responseType`, the result type is mapped from it (e.g. blob -> Blob). */
  <T = unknown, P extends ParseAs = 'json'>(
    url: string,
    options: RequestOptions & { responseType: P },
  ): Promise<MappedResponse<P, T>>;
  /** Otherwise, the result is your `<T>` (defaulting to `unknown`, never `any`). */
  <T = unknown>(url: string, options?: RequestOptions): Promise<T>;
}

/** A configured client: callable for one-offs, plus verb shortcuts and helpers. */
export interface Corgi extends Call {
  get: Call;
  post: Call;
  put: Call;
  patch: Call;
  delete: Call;
  /** HEAD carries no body, so this always resolves to `undefined`. */
  head: (url: string, options?: RequestOptions) => Promise<undefined>;
  /** Get the raw `Response` — no parsing, no throwing. The no-throw escape hatch. */
  raw: (url: string, options?: RequestOptions) => Promise<Response>;
  /** Derive a new client whose defaults extend this one's. Scalars (baseURL,
   * throwOnError…) override; `headers` merge (child wins per key) and `plugins`
   * concatenate (parent's first, then child's). */
  extend: (defaults?: CorgiOptions) => Corgi;
}

/**
 * The root `corgi` export: a zero-config {@link Corgi} that also carries
 * `create`. `corgi('/x')` / `corgi.get('/x')` for one-offs,
 * `corgi.create({ ... })` for shared defaults or plugins.
 */
export interface CorgiAPI extends Corgi {
  /** Create a fresh, independently-configured `Corgi` (base URL, headers, plugins…). */
  create: (defaults?: CorgiOptions) => Corgi;
}

export function createCorgi(defaults: CorgiOptions = {}): Corgi {
  const base = resolveFetch(defaults.fetch);

  // Built once per client, on purpose: a stateful plugin (abortPrevious, swr)
  // keeps its state in a closure created here, so every call must reuse this
  // pipeline. `compose` order-sorts the plugins.
  const clientPipeline = compose(...(defaults.plugins ?? []))(base);

  async function fetchResponse(url: string, options: RequestOptions): Promise<Response> {
    const finalURL = withQuery(joinURL(options.baseURL ?? defaults.baseURL, url), options.query);
    const { body, contentType } = serializeBody(options.body);
    const headers = mergeHeaders(
      // Auto content-type goes first so an explicit caller header always wins.
      contentType ? { 'content-type': contentType } : undefined,
      defaults.headers,
      options.headers,
    );

    // Merge client defaults with per-call options (options win), strip the keys
    // corgi owns, and let everything else — signal, credentials, keepalive,
    // any future RequestInit field — pass straight through.
    const {
      baseURL: _baseURL,
      query: _query,
      plugins: _plugins,
      fetch: _fetch,
      responseType: _responseType,
      throwOnError: _throwOnError,
      transform: _transform,
      body: _body,
      headers: _headers,
      method,
      ...passthrough
    } = { ...defaults, ...options };

    const init: RequestInit = { ...passthrough, method, headers };
    if (body !== undefined) init.body = body;
    // A streaming request body needs `duplex: 'half'` on Node/undici (the option
    // isn't in every lib.dom version yet, hence the narrow cast).
    if (body instanceof ReadableStream) (init as RequestInit & { duplex?: 'half' }).duplex ??= 'half';

    return clientPipeline(finalURL, init);
  }

  async function request(url: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await fetchResponse(url, options);

    const throwOnError = options.throwOnError ?? defaults.throwOnError ?? true;
    const shouldThrow = typeof throwOnError === 'function' ? throwOnError(response.status) : throwOnError;
    if (!response.ok && shouldThrow) {
      // Clone before reading so `err.response` remains fully readable afterwards.
      const data = await parseResponse(response.clone(), options.method).catch(() => undefined);
      throw new HttpError(response, data);
    }

    const value = await parseResponse(response, options.method, options.responseType);
    // Post-parse hook — `schema()` is one transform among many.
    return options.transform ? await options.transform(value, response) : value;
  }

  // `request` already backs every overload, so attach the shortcuts directly
  // onto it (functions are objects) and assert the typed `Corgi` shape once.
  const withMethod =
    (method: string) =>
    (url: string, options?: RequestOptions): Promise<unknown> =>
      request(url, { ...options, method });

  const client = Object.assign(request, {
    get: withMethod('GET'),
    post: withMethod('POST'),
    put: withMethod('PUT'),
    patch: withMethod('PATCH'),
    delete: withMethod('DELETE'),
    head: withMethod('HEAD'),
    raw: (url: string, options?: RequestOptions): Promise<Response> => fetchResponse(url, options ?? {}),
    extend: (extra?: CorgiOptions): Corgi => createCorgi(mergeCorgiOptions(defaults, extra)),
  }) as unknown as Corgi;

  return client;
}

/**
 * Merge parent + child client defaults; headers and plugins combine, not
 * replace. Internal, but `/chonk` reuses it for its own option bag — the
 * generic `T` carries the extra chonk keys through.
 */
export function mergeCorgiOptions<T extends CorgiOptions>(base: T, extra?: T): T {
  if (!extra) return base;
  return {
    ...base,
    ...extra,
    headers: mergeHeaders(base.headers, extra.headers),
    plugins: [...(base.plugins ?? []), ...(extra.plugins ?? [])],
  };
}

/**
 * The one export you need: a zero-config singleton for one-off calls, plus
 * `corgi.create(...)` for a configured instance.
 *
 *   import { corgi } from '@itsy/corgi'
 *   const user = await corgi.get<User>('https://api.example.com/users/1')
 *
 *   const api = corgi.create({ baseURL: 'https://api.example.com', plugins: [withRetry()] })
 *   const me = await api.get<User>('/me')
 *
 * The singleton holds no per-request state, so it's safe to share anywhere.
 * Stateful plugins (abortPrevious, swr) belong on a `create` instance.
 */
export const corgi: CorgiAPI = Object.assign(createCorgi(), { create: createCorgi });
