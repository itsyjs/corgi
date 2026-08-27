/**
 * testing.ts — `mockFetch` + error factories, exported at "@itsy/corgi/testing".
 *
 * The testing seam is the transport: `CorgiOptions.fetch` becomes the base of
 * the pipeline, so tests run the real url joining, query building, body
 * serialization, plugins, retry, cancel, parsing, and `HttpError`. (Mocking the
 * corgi instance itself exercises none of that, and framework spy resets break
 * such mocks.) Framework-agnostic: plain functions, a plain array of calls.
 *
 *   import { corgi } from '@itsy/corgi'
 *   import { mockFetch } from '@itsy/corgi/testing'
 *
 *   const http = mockFetch()
 *   const api = corgi.create({ fetch: http.fetch })
 *
 *   http.get('/users', { json: [{ id: 1 }] })
 *   await api.get('/users', { query: { page: 2 } })
 *   http.lastCall?.query.get('page')   // '2' — the real query builder ran
 *
 * For a module-scope client the test never constructs, make the mock the global
 * instead (`const restore = http.install()` in setup, `restore()` in teardown):
 * the default base fetcher dereferences `globalThis.fetch` on every call.
 */

import { HttpError, isHttpError } from './error.ts';

/**
 * One recorded transport invocation. Every invocation is recorded — matched,
 * unmatched, even pre-aborted — so when the code under test swallows a
 * rejection, the log is still evidence of what was attempted.
 *
 * `url` is the raw string the pipeline produced (query merged, usually relative
 * — `joinURL` never absolutizes). `pathname`/`query` are parsed against a
 * sentinel base (`http://corgi.invalid`, an RFC 2606 reserved TLD) so they work
 * for relative and absolute urls alike; the sentinel never leaks into `url` or
 * error messages.
 */
export interface MockCall {
  /** Upper-cased; `'GET'` when the request didn't specify one. */
  method: string;
  /** The raw url as the pipeline produced it — often relative, never normalized. */
  url: string;
  pathname: string;
  query: URLSearchParams;
  headers: Headers;
  /**
   * The serialized string body, or `null`. Plain-object bodies are JSON strings
   * by the time they reach the transport; a non-string `BodyInit` (`FormData`,
   * `Blob`, a stream) is not stringified — it stays untouched on `init.body`.
   */
  body: string | null;
  /** Parse `body` as JSON. Throws (naming the request) on `null` or bad JSON. */
  json<T = unknown>(): T;
  /** The raw `RequestInit` ({} when the caller passed none). */
  init: RequestInit;
  /** Set only when the transport was called with a `Request` (global-stub path). */
  request?: Request;
}

/**
 * How a route matches a call. A string matches `pathname` exactly, ignoring
 * origin and query (with `://` it matches origin + pathname), so one route works
 * with or without a `baseURL`. `:name` segments and a trailing `*` throw at
 * registration — reserved so a future pattern syntax can't change what existing
 * patterns mean. A RegExp tests the raw, un-normalized `url`; a predicate
 * receives the full {@link MockCall}.
 */
export type MockPattern = string | RegExp | ((call: MockCall) => boolean);

/**
 * What a route answers with.
 *
 *   { json: data }                    200, content-type: application/json
 *   { text: '<p>hi</p>' }            200, content-type: text/plain
 *   { status: 503, headers: {...} }   any status, optional BodyInit body
 *   { json: data, delay: 30 }         any object form, answered after 30ms;
 *                                     aborting cancels the wait
 *   new Response(...)                 stored pristine; a fresh copy is dispatched
 *                                     each time, so a retry can't poison the route
 *   networkError()                    the dispatch rejects (transport-level failure)
 *   { hang: true }                    never settles — exits only via the request's
 *                                     signal or `reset()`
 *   (call) => reply                   computed per dispatch; may be async (sleep,
 *                                     then return networkError() = delayed error)
 *
 * An array is a queue consumed one entry per dispatch, the last entry sticking
 * once exhausted — `[{ status: 503 }, { json: ok }]` exercises retry. A request
 * whose signal was already aborted is recorded but never dispatched, so it
 * consumes nothing.
 *
 * An `HttpError` is rejected in reply position: corgi constructs `HttpError`
 * from a non-2xx `Response`, so replying with one would bypass `throwOnError`
 * and retry-on-5xx — the test would pass for the wrong reason. Reply
 * `{ status }` and let the pipeline throw; `httpError()` builds the error you
 * assert against.
 */
export type MockReply =
  | Response
  | Error
  | { json: unknown; status?: number; headers?: HeadersInit; delay?: number }
  | { text: string; status?: number; headers?: HeadersInit; delay?: number }
  | { status: number; body?: BodyInit | null; headers?: HeadersInit; delay?: number }
  | { hang: true }
  | ((call: MockCall) => MockReply | Promise<MockReply>);

/** The fake transport: one stable `fetch` plus mutable routes and a call log. */
export interface MockFetch {
  /**
   * The transport itself. Hand it to `corgi.create({ fetch: http.fetch })`, use
   * it as a `compose(...)(base)` base, or make it the global via `install()` —
   * it honors the full fetch contract (string, `URL`, or `Request` input). Its
   * identity is stable for the life of the mock: corgi captures the transport
   * once at `create` time, so register routes on the mock, never by swapping
   * the function.
   */
  readonly fetch: typeof fetch;
  /**
   * Make this mock the global `fetch`; returns a restore function. Reaches
   * clients the test didn't create (a module-scope client's default base
   * dereferences `globalThis.fetch` per call), and unlike a bare assignment it
   * can't leak past the suite: the restore puts back exactly what was there,
   * including "nothing".
   *
   *   const restore = http.install()   // in your setup hook
   *   restore()                        // in your after-all hook
   *
   * `install()` while installed returns the same restore; restoring twice is a
   * no-op; nested mocks restore in reverse order. `reset()` never touches the
   * global.
   */
  install(): () => void;
  /** Register a route for an arbitrary method (upper-cased for you). */
  on(method: string, pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  get(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  post(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  put(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  patch(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  delete(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  head(pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch;
  /**
   * Match every method and url — an ordinary route, so registered first (e.g. in
   * a setup file) it's a fallback that later, specific routes shadow.
   */
  any(reply: MockReply | MockReply[]): MockFetch;
  /** Every transport invocation, oldest first — including unmatched and pre-aborted ones. */
  readonly calls: readonly MockCall[];
  readonly lastCall: MockCall | undefined;
  /**
   * The recorded calls a pattern matches, oldest first. Patterns mean exactly
   * what they mean at registration (string → pathname, RegExp → raw url,
   * predicate → the full {@link MockCall}; `:name`/`*` throws). `method` (any
   * case) narrows to one method; omitted matches all. Returns a fresh snapshot,
   * unlike the live `calls` array.
   *
   *   assert.equal(http.callsTo('/users', 'POST').length, 1)
   *   http.callsTo('/users')[0]?.json()
   */
  callsTo(pattern: MockPattern, method?: string): readonly MockCall[];
  /**
   * The calls that matched no route, in arrival order — a subset of `calls`
   * (the same objects), cleared whenever the log is. Each one rejected with
   * `'MockRouteError'`, but code under test often swallows that — asserting
   * this empty in teardown catches the swallowed typo. A pre-aborted request is
   * not here: it rejected before matching, like a real fetch that never dialed.
   */
  readonly unmatchedCalls: readonly MockCall[];
  /**
   * Routes never dispatched, as `'GET /users'`-style descriptions in
   * registration order (a fresh snapshot per read) — the mirror image of
   * `unmatchedCalls` for catching typo'd routes:
   * `assert.deepEqual(http.unusedRoutes, [])` in teardown fails with the list.
   * Two wrinkles: an `any()` fallback may be legitimately unused (filter
   * `'ANY *'` out), and re-registering a pattern replaces its route, so the
   * replacement counts as unused until it serves.
   */
  readonly unusedRoutes: readonly string[];
  /**
   * Resolve once every dispatch has settled and nothing new started in the
   * turns right after — the deterministic replacement for a `setTimeout(0)`
   * wait when the code under test fires a request the test can't await (a
   * `connectedCallback`, an event handler). A response that triggers the next
   * request keeps it waiting, so a chain settles as one unit.
   *
   *   element.connectedCallback()   // fires a request, returns void
   *   await http.settled()
   *   assert.equal(element.textContent, 'Ada')
   *
   * The guarantee is one zero-timer hop per link: a follow-up buried under
   * stacked `setTimeout(0)`s or a real delay escapes — await that directly.
   * A `{ hang: true }` dispatch is excluded (counting it would deadlock every
   * abort test), and retry backoff is invisible (it sleeps in `withRetry`, not
   * the transport) — for retry tests await the request promise, or shrink the
   * backoff with `{ status: 503, headers: { 'retry-after': '0.001' } }`.
   */
  settled(): Promise<void>;
  /**
   * Teardown: clears routes and calls, and rejects outstanding `{ hang: true }`
   * dispatches with `abortError()` — which can surface unhandled rejections
   * from requests the code under test dropped (a latent bug, not a mock bug).
   * Does not uninstall: the restore function from `install()` owns the global.
   */
  reset(): void;
  /** Clears the call log (and `unmatchedCalls`) for arrange/assert separation.
   * Touches nothing in flight: hangs and route queues survive. */
  resetCalls(): void;
}

const SENTINEL = 'http://corgi.invalid';

// The Response constructor throws on any body for these. Mirrors the set in
// parse.ts (not exported there).
const NULL_BODY_STATUS = new Set([204, 205, 304]);

// Hand-constructed Responses get an empty statusText (only a real fetch fills
// it in), rendering HttpError messages as `HTTP 404  ()` — so built replies and
// httpError() fill it from here.
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  205: 'Reset Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  418: "I'm a Teapot",
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

const assertStatus = (status: number, where: string): void => {
  if (!Number.isInteger(status) || status < 200 || status > 599) {
    throw new Error(
      `${where}: status ${status} — the Response constructor only accepts 200-599, and would throw a bare RangeError from deep inside the mock`,
    );
  }
};

// `instanceof` first, structural fallback second: test runners can hand the
// mock values from another realm, where instanceof silently fails.
const isResponseLike = (value: unknown): value is Response =>
  value instanceof Response ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as Response).status === 'number' &&
    typeof (value as Response).clone === 'function' &&
    typeof (value as Response).arrayBuffer === 'function');

const isErrorLike = (value: unknown): value is Error =>
  value instanceof Error ||
  (typeof value === 'object' &&
    value !== null &&
    typeof (value as Error).name === 'string' &&
    typeof (value as Error).message === 'string' &&
    typeof (value as Error).stack === 'string');

const isRequestLike = (input: RequestInfo | URL): input is Request =>
  input instanceof Request ||
  (typeof input === 'object' &&
    typeof (input as { url?: unknown }).url === 'string' &&
    typeof (input as { clone?: unknown }).clone === 'function');

// The object arms of MockReply, after Response/Error/function are ruled out.
type ReplyForm = {
  json?: unknown;
  text?: string;
  status?: number;
  body?: BodyInit | null;
  headers?: HeadersInit;
  delay?: number;
};

const validateReply = (reply: MockReply, where: string): void => {
  if (typeof reply === 'function') return; // validated at dispatch, on what it returns
  if (isHttpError(reply)) {
    throw new Error(
      `${where}: an HttpError is the pipeline's OUTPUT (throwOnError builds it from a non-2xx Response), not a ` +
        `transport failure. Replying with one skips throwOnError and retry-on-5xx — the test would pass for the ` +
        `wrong reason. Reply { status: ${reply.status} } (add { json } for the error body) and let corgi throw; ` +
        `httpError() builds the error you ASSERT against.`,
    );
  }
  if (isResponseLike(reply) || isErrorLike(reply)) return;
  if (typeof reply === 'object' && reply !== null) {
    if ('hang' in reply) return;
    if ('json' in reply || 'text' in reply || 'status' in reply) {
      const form = reply as ReplyForm;
      const status = form.status ?? 200;
      assertStatus(status, where);
      const carriesBody = 'json' in form || 'text' in form || form.body != null;
      if (NULL_BODY_STATUS.has(status) && carriesBody) {
        throw new Error(
          `${where}: a ${status} response cannot carry a body (the Response constructor throws) — drop the body or change the status`,
        );
      }
      if (form.delay !== undefined && (!Number.isFinite(form.delay) || form.delay < 0)) {
        throw new Error(
          `${where}: delay ${String(form.delay)} — expected a finite number of milliseconds >= 0. For a reply ` +
            `that never answers, use { hang: true } instead of a large delay.`,
        );
      }
      return;
    }
  }
  throw new Error(
    `${where}: unrecognized reply — expected { json } / { text } / { status } / { hang: true }, a Response, an Error, or a function returning one`,
  );
};

const MATCH_ANY = (): boolean => true;

const describePattern = (pattern: MockPattern): string =>
  pattern === MATCH_ANY
    ? '*'
    : typeof pattern === 'string'
      ? pattern
      : pattern instanceof RegExp
        ? String(pattern)
        : '[predicate]';

// Reserved, not ignored: matching `:name`/`*` literally today would make real
// pattern syntax a silent breaking change later.
const assertNotReserved = (pattern: string): void => {
  if (/\/:[A-Za-z_$]/.test(pattern) || pattern.endsWith('*')) {
    throw new Error(
      `mockFetch: pattern '${pattern}' — :name segments and trailing * aren't supported (the syntax is reserved so ` +
        `supporting it later can't change what existing patterns match). Use a RegExp or a predicate.`,
    );
  }
};

// A reset-cancelled hang surfaces as an unhandled rejection when the code under
// test dropped the promise; the default DOMException message explains none of
// that, so this one carries the diagnosis. The name stays 'AbortError' so
// `isAbortError` still holds.
const RESET_HANG_MESSAGE =
  'mockFetch.reset() cancelled a request that was still in flight — a { hang: true } reply that nothing aborted. ' +
  'If you are seeing this as an UNHANDLED REJECTION, the code under test started this request and dropped the ' +
  'promise without a .catch: attach one there, or abort the request in the test before teardown.';

// The `{ delay }` wait. Resolves (never rejects) when the signal fires — the
// caller already races the signal, so this early exit is pure timer hygiene.
// The `aborted` pre-check covers a function reply that awaited its way past a
// mid-flight abort.
const sleepUnlessAborted = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

type Route = { method: string; pattern: MockPattern; queue: readonly MockReply[]; served: number };

// Shared by the MockRouteError listing and `unusedRoutes`, so the two agree.
const describeRoute = (route: Route): string =>
  `${route.method === '*' ? 'ANY' : route.method} ${describePattern(route.pattern)}`;

// The six verbs with sugar methods; anything else registers via `on(...)`.
const VERB_SUGAR = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * Create a fake transport: a `fetch` with registrable routes, queued replies,
 * and a log of every call.
 *
 * The mock is one stable function with mutable internal state — corgi captures
 * `defaults.fetch` once at create time, so a transport you reassign later would
 * never be seen. Register routes on the mock after construction; `reset()` in
 * your teardown hook.
 *
 *   const http = mockFetch()
 *   const api = corgi.create({ fetch: http.fetch, baseURL: 'https://api.test' })
 *
 *   http.get('/users', { json: [] })                       // pathname match
 *   http.post(/\/users\/\d+$/, { status: 204 })            // raw-url RegExp
 *   http.get('/flaky', [{ status: 503 }, { json: 'ok' }])  // queue: retry sees both
 *
 * An unmatched request rejects with an error named `'MockRouteError'` listing
 * the registered routes — deliberately not a `Response` (`throwOnError` would
 * turn a 404 into a legitimate-looking `HttpError`) and not a `TypeError`
 * (`withRetry` treats network TypeErrors as transient, so a typo'd route would
 * burn real backoff time before failing). The call is still recorded;
 * `unmatchedCalls` and `unusedRoutes` are the debugging threads.
 *
 * To exercise retry against a client whose config you can't touch, reply
 * `{ status: 503, headers: { 'retry-after': '0.001' } }` — retry honors
 * fractional Retry-After seconds, so each backoff is 1ms instead of jittered
 * hundreds.
 */
export function mockFetch(): MockFetch {
  const routes: Route[] = [];
  const log: MockCall[] = [];
  // Subset of `log` (same objects, same order), cleared whenever `log` is.
  const unmatchedLog: MockCall[] = [];
  // Live restore while this mock owns the global — `install()` hands back the
  // same one instead of re-capturing the mock itself as "previous".
  let uninstall: (() => void) | undefined;
  const hangs = new Set<(reason: unknown) => void>();
  // Buffered bodies for Response replies, filled lazily on first dispatch.
  const buffered = new WeakMap<Response, Promise<{ body: ArrayBuffer | null; init: ResponseInit }>>();
  // One never-rejecting tracker per in-flight dispatch — what `settled()`
  // awaits. Never carries the dispatch's rejection, so awaiting can't mark a
  // dropped request as handled.
  const inFlight = new Set<Promise<void>>();

  // A drained body leaves nothing to buffer for replay — catch it here, where
  // the message can still name the route (at dispatch it surfaces as
  // `TypeError: Body is unusable`, which `withRetry` treats as a flaky
  // network). An already-buffered Response is fine: `bodyUsed` is true there
  // because a replay succeeded.
  const assertReplayable = (reply: MockReply, where: string): void => {
    if (isResponseLike(reply) && reply.bodyUsed && !buffered.has(reply)) {
      throw new Error(
        `${where}: this Response's body has already been read, so there is nothing left to replay. Register a ` +
          `fresh Response, or a function reply that builds one per dispatch — mockFetch replays each reply from a ` +
          `buffered copy, and a drained body cannot be buffered.`,
      );
    }
  };

  const register = (method: string, pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch => {
    if (typeof pattern === 'string') assertNotReserved(pattern);
    const where = `mockFetch route ${method === '*' ? 'ANY' : method} ${describePattern(pattern)}`;
    const queue = Array.isArray(reply) ? [...reply] : [reply];
    if (queue.length === 0) throw new Error(`${where}: an empty reply array has nothing to dispatch`);
    for (const entry of queue) {
      validateReply(entry, where);
      assertReplayable(entry, where);
    }
    // Re-registering the same method + pattern replaces (fresh queue), never
    // appends — sequences are the array form's job.
    const existing = routes.findIndex(
      (route) =>
        route.method === method &&
        (route.pattern === pattern ||
          (route.pattern instanceof RegExp && pattern instanceof RegExp && String(route.pattern) === String(pattern))),
    );
    if (existing !== -1) routes.splice(existing, 1);
    routes.push({ method, pattern, queue, served: 0 });
    return api;
  };

  const matches = (pattern: MockPattern, call: MockCall): boolean => {
    if (typeof pattern === 'string') {
      if (pattern.includes('://')) {
        const patternURL = new URL(pattern);
        const callURL = new URL(call.url, SENTINEL);
        return patternURL.origin === callURL.origin && patternURL.pathname === callURL.pathname;
      }
      return call.pathname === pattern;
    }
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0; // a /g or /y regex is stateful — never let one dispatch poison the next
      return pattern.test(call.url);
    }
    return pattern(call);
  };

  // Newest-registered wins: iterate back-to-front.
  const findRoute = (call: MockCall): Route | undefined => {
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i]!;
      if (route.method !== '*' && route.method !== call.method) continue;
      if (matches(route.pattern, call)) return route;
    }
    return undefined;
  };

  const unmatched = (call: MockCall): Error => {
    const listing =
      routes.length === 0
        ? 'no routes registered'
        : `registered routes (newest wins):\n  ${[...routes].reverse().map(describeRoute).join('\n  ')}`;
    // Near-miss probe: a route matching under a different method is almost
    // always the actual mistake. `findRoute` filtered these out by method, so a
    // user predicate is probed with a call it wasn't written for — a throw from
    // it means "no match", never masks the MockRouteError it decorates.
    const nearMisses = new Set<string>();
    for (const route of routes) {
      if (route.method === '*' || route.method === call.method) continue;
      try {
        if (matches(route.pattern, call)) nearMisses.add(route.method);
      } catch {
        /* probed outside its contract — no match */
      }
    }
    const registerCall = VERB_SUGAR.has(call.method)
      ? `http.${call.method.toLowerCase()}`
      : `http.on('${call.method}', …)`;
    const hint =
      nearMisses.size === 0
        ? ''
        : `\nNote: a ${[...nearMisses].join('/')} route matches this url. Either the request is sending the wrong ` +
          `method, or the route should be registered for ${call.method} (${registerCall}).`;
    const error = new Error(`mockFetch: no route matched ${call.method} ${call.url} — ${listing}${hint}`);
    error.name = 'MockRouteError';
    return error;
  };

  // Hand-constructed Responses have url === '' (only a real fetch fills it),
  // which would render every mocked HttpError as `HTTP 404  ()`. Patch the raw
  // request url on — never the sentinel form, so corgi.invalid can't leak into
  // assertion output.
  const withRequestURL = (response: Response, url: string): Response => {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
    return response;
  };

  // Response replies are stored pristine and rebuilt per dispatch from a
  // buffered body. Not `clone()`: retry cancels each discarded body, and on
  // undici a clone-branch cancel never settles (cloning a consumed original
  // throws) — buffering sidesteps tee semantics entirely.
  const rebuild = async (stored: Response): Promise<Response> => {
    let entry = buffered.get(stored);
    if (!entry) {
      entry = (async () => ({
        body: stored.body === null ? null : await stored.arrayBuffer(),
        init: { status: stored.status, statusText: stored.statusText, headers: stored.headers },
      }))();
      buffered.set(stored, entry);
    }
    const { body, init } = await entry;
    return new Response(body, init);
  };

  const build = (form: ReplyForm): Response => {
    const status = form.status ?? 200;
    const statusText = STATUS_TEXT[status] ?? '';
    const headers = new Headers(form.headers);
    if ('json' in form) {
      // Corgi's default parsing sniffs the content-type; without this header a
      // JSON reply would come back as a plain string.
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      // JSON.stringify returns undefined for undefined/function/symbol —
      // `?? 'null'` keeps `{ json: undefined }` a real body, not a bodyless 200.
      return new Response(JSON.stringify(form.json) ?? 'null', { status, statusText, headers });
    }
    if ('text' in form) {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
      return new Response(form.text, { status, statusText, headers });
    }
    return new Response(NULL_BODY_STATUS.has(status) ? null : (form.body ?? null), { status, statusText, headers });
  };

  // `onHang` drops the dispatch from the in-flight set the moment it hangs — a
  // hang never settles, so counting it would make `settled()` wait forever.
  // `signal` reaches only the `{ delay }` sleep; the race lives in the caller.
  const dispatch = async (
    route: Route,
    call: MockCall,
    signal: AbortSignal | undefined,
    onHang: () => void,
  ): Promise<Response> => {
    const index = Math.min(route.served, route.queue.length - 1);
    route.served += 1;
    let reply = route.queue[index]!;
    while (typeof reply === 'function') reply = await reply(call);
    const where = `mockFetch dispatch ${call.method} ${call.url}`;
    validateReply(reply, where);
    assertReplayable(reply, where);
    if (isResponseLike(reply)) return withRequestURL(await rebuild(reply), call.url);
    if (isErrorLike(reply)) throw reply;
    if ('hang' in reply) {
      // Only the caller's signal or reset() can end this.
      onHang();
      return new Promise<Response>((_resolve, reject) => {
        hangs.add(reject);
      });
    }
    const form = reply as ReplyForm;
    // `delay: 0` (falsy) deliberately skips the timer — identical to omitting it.
    if (form.delay) await sleepUnlessAborted(form.delay, signal);
    return withRequestURL(build(form), call.url);
  };

  // Race a dispatch against the request's signal, propagating `signal.reason`
  // verbatim — corgi's guards are name-based, so a hardcoded AbortError here
  // would silently turn timeout tests (TimeoutError) into abort tests. Matches
  // what a real fetch does with the same signal.
  const raced = (work: Promise<Response>, signal: AbortSignal | undefined): Promise<Response> => {
    if (!signal) return work;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      // Attach even when the signal already won: settling a settled promise is
      // a no-op, and it keeps a reset()-rejected hang from surfacing as an
      // unhandled rejection.
      void work.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  };

  // Normalize the full fetch contract (string, URL, or Request), `init` winning
  // over Request fields like `new Request(input, init)`. Without this, a
  // Request hitting the installed global would record `'[object Request]'` as
  // the url and lose its method/headers/body.
  const toCall = async (input: RequestInfo | URL, init?: RequestInit): Promise<MockCall> => {
    const request = isRequestLike(input) ? input : undefined;
    const url = typeof input === 'string' ? input : request ? request.url : String(input as URL);
    const parsed = new URL(url, SENTINEL);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers ?? request?.headers);
    let body: string | null = null;
    if (init?.body != null) body = typeof init.body === 'string' ? init.body : null;
    else if (request && request.body !== null) body = await request.clone().text();
    const call: MockCall = {
      method,
      url,
      pathname: parsed.pathname,
      query: parsed.searchParams,
      headers,
      body,
      init: init ?? {},
      json: <T = unknown>(): T => {
        if (body === null) {
          throw new Error(
            `mockFetch: ${method} ${url} has no string body — MockCall.body is null (non-string bodies stay on init.body)`,
          );
        }
        try {
          return JSON.parse(body) as T;
        } catch {
          throw new Error(`mockFetch: ${method} ${url} body is not valid JSON: ${body}`);
        }
      },
    };
    if (request) call.request = request;
    return call;
  };

  const transport: typeof fetch = async (input, init?) => {
    // The `!` is sound: a Promise executor runs synchronously, so `settle` is
    // assigned before the constructor returns — TypeScript just can't see it.
    let settle!: () => void;
    const tracker = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inFlight.add(tracker);
    // Idempotent — the hang path calls it early, `finally` calls it again.
    const finish = (): void => {
      inFlight.delete(tracker);
      settle();
    };
    try {
      const call = await toCall(input, init);
      log.push(call);
      const signal = init?.signal ?? call.request?.signal ?? undefined;
      // An already-aborted signal rejects before matching — a real fetch never
      // dials either. The call is still recorded above.
      if (signal?.aborted) throw signal.reason;
      const route = findRoute(call);
      if (!route) {
        unmatchedLog.push(call);
        throw unmatched(call);
      }
      // `return await`, not `return`: it keeps the dispatch inside the try, so
      // `finally` runs when the request settles, not when the promise is
      // handed back.
      return await raced(dispatch(route, call, signal, finish), signal);
    } finally {
      finish();
    }
  };

  const verb =
    (method: string) =>
    (pattern: MockPattern, reply: MockReply | MockReply[]): MockFetch =>
      register(method, pattern, reply);

  const api: MockFetch = {
    fetch: transport,
    install(): () => void {
      if (uninstall) return uninstall; // already installed: one capture, one restore
      const globals = globalThis as { fetch?: typeof fetch };
      const hadFetch = 'fetch' in globals;
      const previous = globals.fetch;
      globals.fetch = transport;
      let restored = false;
      uninstall = (): void => {
        if (restored) return; // restoring twice is a no-op
        restored = true;
        uninstall = undefined; // a later install() starts a fresh capture
        // Reinstate exactly what install() saw — assignment when fetch
        // existed, deletion when it was genuinely absent.
        if (hadFetch) globals.fetch = previous;
        else delete globals.fetch;
      };
      return uninstall;
    },
    on: (method, pattern, reply) => register(method.toUpperCase(), pattern, reply),
    get: verb('GET'),
    post: verb('POST'),
    put: verb('PUT'),
    patch: verb('PATCH'),
    delete: verb('DELETE'),
    head: verb('HEAD'),
    any: (reply) => register('*', MATCH_ANY, reply),
    get calls(): readonly MockCall[] {
      return log;
    },
    get lastCall(): MockCall | undefined {
      return log[log.length - 1];
    },
    callsTo(pattern: MockPattern, method?: string): readonly MockCall[] {
      if (typeof pattern === 'string') assertNotReserved(pattern);
      const wantedMethod = method?.toUpperCase();
      return log.filter(
        (call) => (wantedMethod === undefined || call.method === wantedMethod) && matches(pattern, call),
      );
    },
    get unmatchedCalls(): readonly MockCall[] {
      return unmatchedLog;
    },
    get unusedRoutes(): readonly string[] {
      return routes.filter((route) => route.served === 0).map(describeRoute);
    },
    async settled(): Promise<void> {
      let quietTurns = 0;
      for (;;) {
        while (inFlight.size > 0) {
          await Promise.all(inFlight);
          quietTurns = 0; // new work ran — an earlier quiet turn proves nothing now
        }
        const before = log.length;
        await new Promise((resolve) => setTimeout(resolve, 0));
        // Two consecutive quiet turns, not one: a handler deferring its
        // follow-up with setTimeout(0) creates that timer after our probe
        // timer, so the first probe fires ahead of it and sees a quiet log —
        // but the handler's timer fires ahead of the second probe. One extra
        // turn observes exactly a one-hop deferral.
        if (inFlight.size === 0 && log.length === before) {
          if (++quietTurns >= 2) return;
        } else quietTurns = 0;
      }
    },
    reset(): void {
      routes.length = 0;
      log.length = 0;
      unmatchedLog.length = 0;
      for (const reject of hangs) reject(abortError(RESET_HANG_MESSAGE));
      hangs.clear();
    },
    resetCalls(): void {
      log.length = 0;
      unmatchedLog.length = 0;
    },
  };
  return api;
}

/**
 * Build a real `HttpError` without a request — for driving code that consumes
 * corgi errors (error mappers, fallback UI, logging) and for asserting against
 * thrown ones.
 *
 * Hand-rolling one is subtly wrong twice: a hand-constructed `Response` has an
 * empty `statusText` and `url` (only a real fetch fills them), rendering the
 * message as `HTTP 404  ()` — and for 204/205/304 the constructor throws on any
 * body. This factory fills `statusText` from the reason-phrase table
 * (overridable via `init`), patches `url` on when given, and mirrors `data`
 * into the response body so `err.response.text()` behaves like the real thing.
 *
 *   const banner = bannerFor(httpError(503, { message: 'maintenance' }))
 *   assert.equal(banner.kind, 'maintenance')
 *
 * Not for `mockFetch` replies — reply `{ status: 503 }` and let the pipeline
 * construct the error instead.
 */
export function httpError<T = unknown>(
  status: number,
  data?: T,
  init?: { statusText?: string; url?: string; headers?: HeadersInit },
): HttpError<T> {
  assertStatus(status, 'httpError');
  const statusText = init?.statusText ?? STATUS_TEXT[status] ?? '';
  const headers = new Headers(init?.headers);
  // JSON.stringify also returns undefined for a function or a symbol —
  // `?? 'null'` keeps the body a string the Response constructor accepts.
  const body = NULL_BODY_STATUS.has(status) || data === undefined ? null : (JSON.stringify(data) ?? 'null');
  if (body !== null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = new Response(body, { status, statusText, headers });
  // Before constructing the error — its message interpolates response.url.
  if (init?.url) Object.defineProperty(response, 'url', { value: init.url, configurable: true });
  return new HttpError(response, data as T);
}

/**
 * A transport-level network failure: `new TypeError('fetch failed')`, undici's
 * literal message. The message matters, not just the type: `withRetry` refuses
 * TypeErrors that look like programmer errors ("is not a function", "cannot
 * read", …), so a hand-rolled message one word wrong can silently disable
 * retry in the test.
 */
export function networkError(message = 'fetch failed'): TypeError {
  return new TypeError(message);
}

/**
 * A caller cancel (or an `abortPrevious` supersede): a `DOMException` named
 * `"AbortError"` — what `isAbortError` checks. The default message is the
 * platform's own.
 */
export function abortError(message = 'This operation was aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

/**
 * A fired deadline: a `DOMException` named `"TimeoutError"` — what
 * `isTimeoutError` checks, and the shape `withTimeout` and
 * `AbortSignal.timeout()` abort with.
 */
export function timeoutError(message = 'Request timed out'): DOMException {
  return new DOMException(message, 'TimeoutError');
}
