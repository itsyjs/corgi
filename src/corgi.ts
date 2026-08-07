/**
 * corgi.ts — the ergonomic client.
 *
 * This is the "function + options" tier. `corgi.create()` returns a callable that
 * is ALSO an object of method shortcuts (`get`/`post`/...), builds the request
 * (base URL, query, body, headers), runs it through the composed plugin pipeline
 * from core.ts, then parses the response, throws on non-2xx, and applies an
 * optional `transform`.
 *
 * Plugins stay pure `Response -> Response`; the client is the only place that
 * knows about parsing, typed values, and throwing. That clean seam is what lets
 * retry/timeout/etc. read `res.status` freely while the body is left untouched
 * for the client to parse.
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
 * A union that still autocompletes its literal members but accepts any other
 * `U` too. `(string & {})` is the well-known trick: it's assignable to/from
 * `string`, so it widens the union to all strings WITHOUT collapsing the literal
 * arm (which would kill editor autocomplete). Erased at build — costs no bytes.
 */
type LiteralUnion<T extends U, U = string> = T | (U & {});

/**
 * Maps a `responseType` to the value type it produces. `json` (the default)
 * falls through to the caller's `<T>` generic; the rest are fixed platform types.
 * The `[P] extends [...]` tuples stop TypeScript from distributing over unions.
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
 * Per-call options. Extends the standard `RequestInit` (minus the fields we own).
 *
 * Per-call options are pure per-request DATA (url/query/body/headers/parse/
 * transform). Anything that shapes the middleware PIPELINE — `plugins`, a custom
 * `fetch`, timeout — is client-level only (`corgi.create`/`extend`), so the
 * pipeline (and any stateful plugin's memory, e.g. abortPrevious) is built once
 * and reused. Need a one-off variation? Derive a client with `.extend({...})`.
 *
 * No per-call `timeout` field: for a per-call deadline pass the standard
 * `signal: AbortSignal.timeout(ms)` (a TOTAL budget for that call, spanning any
 * retries); for a per-attempt deadline add the `withTimeout` plugin
 * (`@itsy/corgi/timeout[-modern]`, client-level).
 */
export interface RequestOptions extends Omit<RequestInit, 'body' | 'method' | 'headers'> {
  /** HTTP method. Typed as a {@link LiteralUnion} of the standard verbs, so the
   * common ones autocomplete while any custom method string is still accepted.
   * (The verb shortcuts — `get`/`post`/… — set this for you.) */
  method?: LiteralUnion<HttpMethod>;
  /**
   * Per-call headers. Merged case-insensitively, so `Content-Type` and
   * `content-type` collapse to one (never duplicated). Precedence low -> high:
   * the auto `application/json` from a plain-object body < client `headers` <
   * these — a per-call header always wins.
   */
  headers?: HeadersInit;
  /**
   * Request body. A plain object/array is JSON-encoded and sets
   * `content-type: application/json` (unless you set one). Every real `BodyInit` —
   * string, `FormData`, `Blob`/`File`, `URLSearchParams`, `ReadableStream`,
   * `ArrayBuffer`/typed arrays — passes through untouched (the runtime sets the
   * right header, e.g. the multipart boundary for `FormData`). `null`/`undefined`
   * send no body. A `ReadableStream` body gets `duplex: 'half'` automatically
   * (Node/undici require it) — and note a stream body is NOT retryable.
   *
   * The object arm is deliberately wide (`object`, not `Record<string, unknown>`)
   * so a plain `interface` DTO type-checks — `Record<string, unknown>` rejects
   * interfaces for want of an index signature (TS#15300). Trade-off: a non-plain
   * object (a `Map`/`Set`/class instance) also type-checks, but `JSON.stringify`
   * yields whatever it yields (often `{}`) — pass a plain object or a real `BodyInit`.
   */
  body?: BodyInit | object | null;
  /**
   * Merged into the URL's query string (existing params and `#hash` are kept):
   *   - arrays expand to repeated keys — `{ tag: ['a','b'] }` -> `tag=a&tag=b`;
   *   - `null`/`undefined` values (and nullish array items) are OMITTED — never
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
   * Throw {@link HttpError} on any non-2xx response. Default `true`. When `false`,
   * a non-2xx resolves instead of throwing and you get the PARSED body — on an
   * error that's the error payload, still typed as your `<T>`, so narrow it
   * yourself. For the raw `Response` (no parse, no throw) use `.raw()`.
   *
   * Pass a PREDICATE `(status) => boolean` for per-status control: return `true`
   * to throw, `false` to resolve with the parsed body. Handy when an API returns
   * a meaningful body on some 4xx you want to read while still throwing on 5xx —
   * e.g. `throwOnError: (s) => s >= 500`. The non-thrown body is typed as your
   * `<T>` (status isn't returned alongside it), so this shines when you WANT the
   * error body; to branch on status and remap, a `try/catch` + `isHttpError` still reads cleaner.
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
   * `content-type`. An empty value REMOVES a header instead of setting it, so
   * `extend({ headers: { authorization: '' } })` drops an inherited one. */
  headers?: HeadersInit;
  /** Client-wide throw policy. Boolean, or a `(status) => boolean` predicate to
   * throw selectively (e.g. `(s) => s >= 500` — throw server errors, hand back
   * 4xx bodies). A per-call `throwOnError` overrides this. See {@link RequestOptions.throwOnError}. */
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
 *
 * Runtime note: a no-body response (status 204/205/304, or any HEAD request)
 * resolves to `undefined` regardless of `<T>` — guard the value before using it.
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
 * The root `corgi` export: a ready-to-use zero-config {@link Corgi} (callable, with
 * verb shortcuts) that ALSO carries `create` — the factory for a fresh configured
 * instance. This is the whole public surface: `corgi('/x')` / `corgi.get('/x')` for
 * one-offs, `corgi.create({ ... })` when you want shared defaults or plugins.
 */
export interface CorgiAPI extends Corgi {
  /** Create a fresh, independently-configured `Corgi` (base URL, headers, plugins…). */
  create: (defaults?: CorgiOptions) => Corgi;
}

export function createCorgi(defaults: CorgiOptions = {}): Corgi {
  const base = resolveFetch(defaults.fetch);

  // Build the client pipeline ONCE, and reuse it for every call. This is
  // deliberate and load-bearing: a stateful plugin such as abortPrevious() keeps
  // its "current request" in a closure created HERE (when the plugin is applied),
  // so a single shared pipeline is what lets a new call cancel the previous one.
  // `compose` order-sorts, so the sequence is correct however they're listed.
  const clientPipeline = compose(...(defaults.plugins ?? []))(base);

  async function exec(url: string, options: RequestOptions): Promise<Response> {
    const finalURL = withQuery(joinURL(options.baseURL ?? defaults.baseURL, url), options.query);
    const { body, contentType } = serializeBody(options.body);
    const headers = mergeHeaders(
      // Auto content-type goes first so an explicit caller header always wins.
      contentType ? { 'content-type': contentType } : undefined,
      defaults.headers,
      options.headers,
    );

    // Assemble the RequestInit. Rather than enumerate every fetch field, we merge
    // client defaults with per-call options (options win), strip the keys we own,
    // and let EVERYTHING ELSE pass straight through — signal, credentials, mode,
    // cache, redirect, keepalive, duplex, priority, and any future RequestInit
    // fields, for free. `body`/`headers`/`method` are handled explicitly above/below.
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

  async function run(url: string, options: RequestOptions = {}): Promise<unknown> {
    const res = await exec(url, options);

    // `throwOnError` may be a boolean or a `(status) => boolean` predicate; a
    // per-call value overrides the client default, which overrides the `true` default.
    const throwOnError = options.throwOnError ?? defaults.throwOnError ?? true;
    const shouldThrow = typeof throwOnError === 'function' ? throwOnError(res.status) : throwOnError;
    if (!res.ok && shouldThrow) {
      // Clone before reading so `err.response` remains fully readable afterwards.
      const data = await parseResponse(res.clone(), options.method).catch(() => undefined);
      throw new HttpError(res, data);
    }

    const value = await parseResponse(res, options.method, options.responseType);
    // The post-parse hook. `schema(MySchema)` from '@itsy/corgi/schema' is just
    // one transform among many (camelize, date-revive, envelope-unwrap, ...).
    return options.transform ? await options.transform(value, res) : value;
  }

  // `run` already backs every overload case, so attach the verb shortcuts +
  // helpers directly onto it (functions are objects) and assert the typed `Corgi`
  // shape once. `Promise<unknown>` is contained here; callers see `Corgi`.
  const withMethod =
    (method: string) =>
    (url: string, options?: RequestOptions): Promise<unknown> =>
      run(url, { ...options, method });

  const client = Object.assign(run, {
    get: withMethod('GET'),
    post: withMethod('POST'),
    put: withMethod('PUT'),
    patch: withMethod('PATCH'),
    delete: withMethod('DELETE'),
    head: withMethod('HEAD'),
    raw: (url: string, options?: RequestOptions): Promise<Response> => exec(url, options ?? {}),
    extend: (extra?: CorgiOptions): Corgi => createCorgi(mergeCorgiOptions(defaults, extra)),
  }) as unknown as Corgi;

  return client;
}

/**
 * Merge parent + child client defaults; headers and plugins COMBINE, not replace.
 *
 * Internal (not re-exported from './index.ts'): `/chonk` reuses it to merge its own
 * option bag, hence the generic — `T` carries the extra chonk keys through.
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
 * The one export you need. `corgi` is a zero-config singleton for one-off calls,
 * and `corgi.create(...)` builds a configured instance:
 *
 *   import { corgi } from '@itsy/corgi'
 *   const user = await corgi.get<User>('https://api.example.com/users/1')
 *
 *   const api = corgi.create({ baseURL: 'https://api.example.com', plugins: [withRetry()] })
 *   const me = await api.get<User>('/me')
 *
 * The singleton holds no per-request state, so it's safe to share anywhere
 * (including servers). Stateful plugins (retry keeps none; cancel-previous does)
 * belong on a `corgi.create({ plugins: [...] })` instance.
 */
export const corgi: CorgiAPI = Object.assign(createCorgi(), { create: createCorgi });
