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
 */
export interface RequestOptions extends Omit<RequestInit, 'body' | 'method' | 'headers'> {
  method?: string;
  headers?: HeadersInit;
  /** Plain object/array is JSON-encoded; BodyInit values pass through untouched. */
  body?: BodyInit | Record<string, unknown> | readonly unknown[] | null;
  /** Object merged into the URL's query string (arrays -> repeated keys). */
  query?: Query;
  /** Prefix-joined with the url (see joinURL); absolute urls bypass it. */
  baseURL?: string;
  /** Force a parse mode instead of sniffing the content-type. */
  responseType?: ParseAs;
  /** Throw `HttpError` on non-2xx. Default true. */
  throwOnError?: boolean;
  /** Post-parse hook: map/validate the value. Its return type becomes the result. */
  transform?: (value: unknown, response: Response) => unknown;
}

/** Corgi-level defaults, merged into every request. */
export interface CorgiOptions {
  baseURL?: string;
  headers?: HeadersInit;
  throwOnError?: boolean;
  /** Middleware plugins for this client. Built into the pipeline once, reused
   * across calls (so stateful plugins like abortPrevious keep their memory).
   * Order-sorted by their `order` hint — see ORDER/byOrder in core.ts. */
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
  head: Call;
  /** Get the raw `Response` — no parsing, no throwing. The no-throw escape hatch. */
  raw: (url: string, options?: RequestOptions) => Promise<Response>;
  /** Derive a new client whose defaults extend this one's (headers/plugins combine). */
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

    const throwOnError = options.throwOnError ?? defaults.throwOnError ?? true;
    if (!res.ok && throwOnError) {
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

/** Merge parent + child client defaults; headers and plugins COMBINE, not replace. */
function mergeCorgiOptions(base: CorgiOptions, extra?: CorgiOptions): CorgiOptions {
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
