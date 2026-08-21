/**
 * testing.ts — `mockFetch` + error factories, exported at "@itsy/corgi/testing".
 *
 * Corgi's testing seam is the TRANSPORT: `CorgiOptions.fetch` becomes the base of
 * the pipeline (`resolveFetch` in core.ts), and when it's omitted the default is
 * a late-bound `globalThis.fetch` wrapper — so even a module-scope client picks
 * up a stubbed global, per call, with no module mocking. Faking the transport
 * means the REAL pipeline runs in tests: url joining, query building, body
 * serialization, plugins, retry, cancel, parsing, `HttpError`. Faking the value
 * layer instead — replacing the corgi instance with framework spies — exercises
 * none of that, and corgi's callable-with-methods shape makes such mocks fragile:
 * `.extend` runs at module scope in real apps, so a spy whose implementation is
 * wiped by a clearAllMocks-style reset breaks the next file's imports. This
 * module ships the transport fake so nobody has to hand-roll it.
 *
 * Framework-agnostic on purpose: plain functions and a plain array of recorded
 * calls. Nothing here needs vitest/jest/node:test, and nothing here can be
 * broken by a framework's spy reset.
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
 * For a module-scope client the test never constructs, make the transport the
 * global instead (`const restore = http.install()` in a setup file, `restore()`
 * in teardown): the client's default base fetcher dereferences
 * `globalThis.fetch` on every call, so an already-created client picks it up.
 */

import { HttpError, isHttpError } from './error.ts';

/**
 * One recorded transport invocation. EVERY invocation is recorded — matched,
 * unmatched, even pre-aborted — because code under test often swallows the
 * rejection (a try/catch falling back to null); the log is then the only
 * evidence of what was attempted.
 *
 * `url` is RAW — exactly the string the pipeline produced, query already merged,
 * and usually RELATIVE: with no `baseURL`, corgi passes the path straight
 * through (`joinURL` never absolutizes). `pathname`/`query` are parsed against a
 * sentinel base (`http://corgi.invalid`, an RFC 2606 reserved TLD) so they work
 * for relative and absolute urls alike; the sentinel never appears in `url` or
 * in any error message.
 */
export interface MockCall {
  /** Upper-cased; `'GET'` when the request didn't specify one. */
  method: string;
  /** The raw url as the pipeline produced it — often relative, never normalized. */
  url: string;
  /** Path portion, parsed against the sentinel base. */
  pathname: string;
  /** Query portion, parsed against the sentinel base. */
  query: URLSearchParams;
  headers: Headers;
  /**
   * The serialized string body, or `null`. Corgi serializes plain-object bodies
   * to JSON strings BEFORE the transport, so this covers the common case; a
   * non-string `BodyInit` (`FormData`, `Blob`, a stream) is deliberately NOT
   * stringified — it stays reachable on `init.body`, untouched.
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
 * How a route matches a call.
 *
 * A STRING matches `pathname` exactly, ignoring origin and query — so one route
 * works whether the client has a `baseURL`, has none (relative urls), or has a
 * plugin that absolutizes. A string containing `://` matches origin + pathname
 * instead. `:name` segments and a trailing `*` are RESERVED: they throw at
 * registration rather than silently matching literally, so a future pattern
 * syntax can't change what existing patterns mean. A REGEXP tests the raw,
 * un-normalized `url` — the escape hatch when the exact string matters. A
 * PREDICATE receives the full {@link MockCall}.
 */
export type MockPattern = string | RegExp | ((call: MockCall) => boolean);

/**
 * What a route answers with.
 *
 *   { json: data }                    200, content-type: application/json
 *   { text: '<p>hi</p>' }            200, content-type: text/plain
 *   { status: 503, headers: {...} }   any status, optional BodyInit body
 *   { json: data, delay: 30 }         any object form, answered after 30ms —
 *                                     loading states; aborting cancels the wait
 *   new Response(...)                 stored pristine; a FRESH copy is dispatched
 *                                     each time, so a retry can't poison the route
 *   networkError()                    the dispatch REJECTS (transport-level failure)
 *   { hang: true }                    never settles — exits only via the request's
 *                                     signal or `reset()`
 *   (call) => reply                   computed per dispatch; may be async — the
 *                                     recipe for a DELAYED error: sleep, then
 *                                     return networkError()
 *
 * An ARRAY is a queue consumed in order, the LAST entry sticking once exhausted —
 * one entry per DISPATCH: a request whose signal was already aborted is recorded
 * in `calls` but never dispatched, so it consumes nothing (a real fetch wouldn't
 * have dialed either). An abort mid-dispatch has already taken its entry.
 * `[{ status: 503 }, { json: ok }]` is how you exercise retry.
 *
 * An `HttpError` is deliberately REJECTED in reply position: corgi CONSTRUCTS
 * `HttpError` from a non-2xx `Response` (`throwOnError`), so replying with one
 * would bypass that logic — and retry-on-5xx — making the test pass for the
 * wrong reason. Reply `{ status }` and let the pipeline throw; `httpError()`
 * builds the error you ASSERT against.
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
   * it honors the full fetch contract (string, `URL`, or `Request` input). The
   * function identity is STABLE for the life of the mock: corgi captures the
   * transport once at `create` time, so routes are registered on the mock
   * afterwards, never by swapping the function.
   */
  readonly fetch: typeof fetch;
  /**
   * Make this mock the global `fetch` and get back a restore function — the
   * managed version of `globalThis.fetch = http.fetch` for reaching clients the
   * test didn't create (a module-scope client's default base dereferences
   * `globalThis.fetch` per call). The bare assignment leaks past the suite in
   * runners that share one process; `install()` captures what was there
   * (including "nothing") and the restore puts exactly that back.
   *
   *   const restore = http.install()   // in your setup hook
   *   restore()                        // in your after-all hook
   *
   * Calling `install()` again while installed returns the SAME restore (no
   * self-capture); calling the restore twice is a no-op. Two mocks may nest —
   * restore in reverse order (LIFO), as the restores are snapshots, not a
   * stack. `reset()` never touches the global: routes/calls hygiene and global
   * ownership are separate lifecycles.
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
   * Match every method and url — an ordinary route, so registered FIRST (e.g. in
   * a setup file) it acts as a fallback that later, specific routes shadow.
   */
  any(reply: MockReply | MockReply[]): MockFetch;
  /** Every transport invocation, oldest first — including unmatched and pre-aborted ones. */
  readonly calls: readonly MockCall[];
  readonly lastCall: MockCall | undefined;
  /**
   * The recorded calls a pattern matches, oldest first — "was `/users` POSTed
   * exactly once, and with what?" without re-implementing the route semantics
   * in a hand-rolled filter. The pattern means EXACTLY what it means at
   * registration: a string matches `pathname` (origin + pathname with `://`),
   * a RegExp tests the raw url, a predicate gets the full {@link MockCall} —
   * and `:name`/`*` syntax throws, same as `get()` would. `method` (any case)
   * narrows to one method; omitted matches all. Returns a fresh snapshot,
   * unlike the live `calls` array.
   *
   *   assert.equal(http.callsTo('/users', 'POST').length, 1)
   *   http.callsTo('/users')[0]?.json()
   */
  callsTo(pattern: MockPattern, method?: string): readonly MockCall[];
  /**
   * The calls that matched NO route, in arrival order — always a subset of
   * `calls` (the same objects), cleared whenever the log is. Each one rejected
   * with `'MockRouteError'`, but code under test often swallows that (a
   * try/catch falling back to null), and then this list is the evidence:
   * asserting it empty in teardown catches the swallowed typo. A request whose
   * signal was already aborted is NOT here — it rejected before matching, like
   * a real fetch that never dialed.
   */
  readonly unmatchedCalls: readonly MockCall[];
  /**
   * Routes never dispatched, as `'GET /users'`-style descriptions in
   * REGISTRATION order (a fresh snapshot per read, unlike the live `calls`).
   * The mirror image of `unmatchedCalls`: when a route is typo'd, the route
   * serves nothing while the real request goes unmatched — and if the code
   * under test swallows the rejection, the test passes silently.
   * `assert.deepEqual(http.unusedRoutes, [])` in teardown fails with the list.
   * Two deliberate wrinkles: an `any()` fallback may be LEGITIMATELY unused
   * (filter `'ANY *'` out, or skip the assertion in suites that register one),
   * and re-registering a pattern replaces its route, so an exercised-then-
   * re-registered route counts as unused again — the replacement never served.
   */
  readonly unusedRoutes: readonly string[];
  /**
   * Resolve once every dispatch the mock started has settled AND nothing new
   * started in the turns right after. This is the deterministic replacement for
   * `await new Promise((r) => setTimeout(r, 0))` when the code under test fires a
   * request the test can't await — a custom element's `connectedCallback`, an
   * event handler, anything fire-and-forget. A response that triggers the NEXT
   * request keeps it waiting, so a chain settles as one unit — whether each link
   * follows from a promise chain, `queueMicrotask`, or one `setTimeout(0)` hop
   * (a common framework-scheduler shape).
   *
   *   element.connectedCallback()   // fires a request, returns void
   *   await http.settled()
   *   assert.equal(element.textContent, 'Ada')
   *
   * The guarantee is ONE zero-timer hop per link, not arbitrary timer chains: a
   * follow-up buried under two stacked `setTimeout(0)`s with no request between
   * them, or scheduled with a real delay (`setTimeout(50)`), escapes — await
   * that directly. Two more blind spots by design: a `{ hang: true }` dispatch
   * is excluded — it never settles, so counting it would deadlock every abort
   * test. And a client sleeping BETWEEN retry attempts is invisible: that wait
   * lives in `withRetry`, not in the transport, so with the default 300ms
   * backoff `settled()` can return after the first attempt. For retry tests
   * either await the request promise directly, or bring the backoff down to ~1ms
   * with `{ status: 503, headers: { 'retry-after': '0.001' } }`.
   */
  settled(): Promise<void>;
  /**
   * Teardown: clears routes AND calls, and rejects outstanding `{ hang: true }`
   * dispatches with `abortError()`. Rejecting hangs can surface unhandled
   * rejections from fire-and-forget requests the code under test dropped —
   * that's usually a latent bug being surfaced, not a mock bug. Does NOT
   * uninstall: the restore function from `install()` owns the global.
   */
  reset(): void;
  /** Clears the call log (and with it `unmatchedCalls`) — for arrange/assert
   * separation mid-test. Touches nothing in flight: a hang held across an act
   * phase survives it, and routes keep their queues. */
  resetCalls(): void;
}

/* -------------------------------------------------------------------------- */
/* Shared tables and guards (used by both mockFetch replies and httpError).   */
/* -------------------------------------------------------------------------- */

const SENTINEL = 'http://corgi.invalid';

// Statuses defined to carry no body — the Response constructor THROWS on any
// body for these. Mirrors the set in parse.ts (not exported there).
const NULL_BODY_STATUS = new Set([204, 205, 304]);

// Standard reason phrases. Hand-constructed Responses get an EMPTY statusText
// (only a real fetch fills it in), which turns HttpError messages into
// `HTTP 404  ()` — so built replies and httpError() fill it from here.
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
// mock values from another realm/global, where instanceof silently fails.
// (Corgi itself uses `instanceof TypeError` in retry, so this is hardening,
// not purism.)
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
  if (typeof reply === 'function') return; // validated at dispatch, on what it RETURNS
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

// Matched routes matter for readable failures: `ANY *`, `GET /users`, …
const MATCH_ANY = (): boolean => true;

const describePattern = (pattern: MockPattern): string =>
  pattern === MATCH_ANY
    ? '*'
    : typeof pattern === 'string'
      ? pattern
      : pattern instanceof RegExp
        ? String(pattern)
        : '[predicate]';

// `:name` and trailing `*` are reserved, not ignored: matching them literally
// today would make adding real pattern syntax a silent breaking change later.
const assertNotReserved = (pattern: string): void => {
  if (/\/:[A-Za-z_$]/.test(pattern) || pattern.endsWith('*')) {
    throw new Error(
      `mockFetch: pattern '${pattern}' — :name segments and trailing * aren't supported (the syntax is reserved so ` +
        `supporting it later can't change what existing patterns match). Use a RegExp or a predicate.`,
    );
  }
};

// `reset()` cancels leftover hangs, and a request the code under test dropped
// without a `.catch` then surfaces as an unhandled rejection — from a teardown
// hook, with a stack pointing into this module. The default DOMException message
// ("This operation was aborted") explains none of that, so the message carries
// the diagnosis itself. The NAME stays 'AbortError' so `isAbortError` still holds.
const RESET_HANG_MESSAGE =
  'mockFetch.reset() cancelled a request that was still in flight — a { hang: true } reply that nothing aborted. ' +
  'If you are seeing this as an UNHANDLED REJECTION, the code under test started this request and dropped the ' +
  'promise without a .catch: attach one there, or abort the request in the test before teardown.';

// The `{ delay }` wait. RESOLVES (never rejects) when the signal fires: the
// dispatch is already raced against the signal, which rejects the caller with
// `signal.reason` — this early exit is pure timer hygiene, so an aborted
// request leaves no stray timer running out the remaining delay. The `aborted`
// pre-check matters too: the transport's own pre-abort guard only covers
// aborts BEFORE matching, but a function reply that awaited something can
// reach this sleep after a mid-flight abort.
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

/* -------------------------------------------------------------------------- */
/* The transport fake.                                                        */
/* -------------------------------------------------------------------------- */

type Route = { method: string; pattern: MockPattern; queue: readonly MockReply[]; served: number };

// One line per route, the way tests name them: `GET /users`, `ANY *`. Shared by
// the MockRouteError listing and `unusedRoutes`, so the two always agree.
const describeRoute = (route: Route): string =>
  `${route.method === '*' ? 'ANY' : route.method} ${describePattern(route.pattern)}`;

// The six verbs that have sugar methods; anything else registers via `on(...)`.
const VERB_SUGAR = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * Create a fake transport: a `fetch` with registrable routes, queued replies,
 * and a log of every call.
 *
 * The mock is ONE stable function with mutable internal state — that shape is
 * forced by corgi itself: `createCorgi` captures `defaults.fetch` once at create
 * time, so a transport you reassign later would never be seen. Register routes
 * on the mock after construction instead; `reset()` in your teardown hook.
 *
 *   const http = mockFetch()
 *   const api = corgi.create({ fetch: http.fetch, baseURL: 'https://api.test' })
 *
 *   http.get('/users', { json: [] })                       // pathname match
 *   http.post(/\/users\/\d+$/, { status: 204 })            // raw-url RegExp
 *   http.get('/flaky', [{ status: 503 }, { json: 'ok' }])  // queue: retry sees both
 *
 * An UNMATCHED request rejects with an error named `'MockRouteError'` listing
 * the registered routes — and when some route matches the url under a different
 * method, it says so. Deliberately NOT a `Response` (a 404 would be converted
 * by `throwOnError` into a legitimate-looking `HttpError`) and NOT a `TypeError`
 * (`withRetry` treats network TypeErrors as transient, so a typo'd route on a
 * retrying client would burn real backoff time before failing). The call is
 * still recorded — if the code under test swallows the rejection,
 * `unmatchedCalls` and `unusedRoutes` are the debugging threads.
 *
 * Replies that are 2xx or non-retryable cost ZERO wall-clock against a retrying
 * client. To exercise retry against a client whose config you can't touch (a
 * module-scope production client), reply
 * `{ status: 503, headers: { 'retry-after': '0.001' } }` — retry honors
 * fractional Retry-After seconds, so each backoff is 1ms instead of jittered
 * hundreds.
 */
export function mockFetch(): MockFetch {
  const routes: Route[] = [];
  const log: MockCall[] = [];
  // Calls that reached matching and found no route. Always a subset of `log`
  // (same objects, same relative order), cleared whenever `log` is.
  const unmatchedLog: MockCall[] = [];
  // The live restore function while this mock owns the global — `install()`
  // hands back the same one instead of re-capturing (a second capture would
  // record the mock itself as "previous" and restore could never escape it).
  let uninstall: (() => void) | undefined;
  const hangs = new Set<(reason: unknown) => void>();
  // Buffered bodies for Response replies, filled lazily on first dispatch.
  const buffered = new WeakMap<Response, Promise<{ body: ArrayBuffer | null; init: ResponseInit }>>();
  // One never-rejecting tracker per in-flight dispatch — what `settled()` awaits.
  // Trackers never carry the dispatch's rejection, so awaiting them can't mark a
  // dropped request as handled and hide it from the runner.
  const inFlight = new Set<Promise<void>>();

  // A Response reply is replayed from a buffered copy (see `rebuild`), so a body
  // that was already drained before we ever buffered it leaves nothing to replay.
  // Catch it HERE, where the message can still name the route: at dispatch it
  // surfaces as `TypeError: Body is unusable`, which `withRetry` would classify
  // as a flaky network and retry with real backoff before failing opaquely.
  // Already-buffered Responses are fine — that's the shared-across-routes case,
  // where `bodyUsed` is true precisely BECAUSE we replayed it successfully.
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
    // Re-registering the same method + pattern OVERRIDES (fresh queue) rather
    // than appending — sequences are expressed with the array form, so a second
    // registration can only mean "replace what this route answers".
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
        const want = new URL(pattern);
        const got = new URL(call.url, SENTINEL);
        return want.origin === got.origin && want.pathname === got.pathname;
      }
      return call.pathname === pattern;
    }
    if (pattern instanceof RegExp) {
      pattern.lastIndex = 0; // a /g or /y regex is stateful — never let one dispatch poison the next
      return pattern.test(call.url);
    }
    return pattern(call);
  };

  // Newest-registered wins: iterate back-to-front, first match answers.
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
    // Near-miss probe: a route whose PATTERN matches under a different METHOD
    // is almost always the actual mistake. `findRoute` never ran `matches()` on
    // these (it filters by method first), so a user predicate is being probed
    // here with a call it was never written for — a throw from it must be
    // treated as "no match", never allowed to mask the MockRouteError this
    // hint merely decorates.
    const nearMisses = new Set<string>();
    for (const route of routes) {
      if (route.method === '*' || route.method === call.method) continue;
      try {
        if (matches(route.pattern, call)) nearMisses.add(route.method);
      } catch {
        /* probed outside its contract — no match */
      }
    }
    const register = VERB_SUGAR.has(call.method) ? `http.${call.method.toLowerCase()}` : `http.on('${call.method}', …)`;
    const hint =
      nearMisses.size === 0
        ? ''
        : `\nNote: a ${[...nearMisses].join('/')} route matches this url. Either the request is sending the wrong ` +
          `method, or the route should be registered for ${call.method} (${register}).`;
    const error = new Error(`mockFetch: no route matched ${call.method} ${call.url} — ${listing}${hint}`);
    error.name = 'MockRouteError';
    return error;
  };

  // Hand-constructed Responses have url === '' (only a real fetch populates it),
  // which would reproduce the `HTTP 404  ()` defect on every mocked HttpError.
  // Patch the RAW request url on (never the sentinel-normalized form, so
  // corgi.invalid can't leak into assertion output).
  const withRequestURL = (response: Response, url: string): Response => {
    Object.defineProperty(response, 'url', { value: url, configurable: true });
    return response;
  };

  // A Response reply is stored pristine and REBUILT per dispatch from a buffered
  // body. Not `clone()`: retry cancels the body of every discarded response, and
  // on undici a clone-branch cancel never settles (and cloning an already-
  // consumed original throws) — buffering sidesteps tee semantics entirely, so
  // a route survives any number of dispatches and retries.
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
      // Corgi's default parsing SNIFFS the content-type; without this header a
      // JSON reply would come back as a plain string.
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      return new Response(JSON.stringify(form.json) ?? 'null', { status, statusText, headers });
    }
    if ('text' in form) {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain');
      return new Response(form.text, { status, statusText, headers });
    }
    return new Response(NULL_BODY_STATUS.has(status) ? null : (form.body ?? null), { status, statusText, headers });
  };

  // `onHang` lets the transport drop this dispatch from the in-flight set the
  // moment it becomes a hang: a hang never settles by design, so leaving it
  // counted would make `settled()` wait forever. `signal` reaches only the
  // `{ delay }` sleep — everything else here is instantaneous, and the race
  // against the signal happens in the caller.
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
      // Never settles on its own: the caller's signal (raced below) or reset()
      // are the only exits. Replaces hand-rolled "slow fetch" helpers.
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
  // VERBATIM. That's load-bearing: withTimeout aborts with a TimeoutError and
  // abortPrevious with an AbortError, and corgi's guards are name-based — a
  // hardcoded AbortError here would silently turn timeout tests into abort
  // tests. Matches what a real fetch does with the same signal.
  const raced = (work: Promise<Response>, signal: AbortSignal | undefined): Promise<Response> => {
    if (!signal) return work;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      // Attach both handlers even when the signal already won: settling a
      // settled promise is a no-op, and it keeps a reset()-rejected hang from
      // surfacing as an unhandled rejection.
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

  // Normalize the full fetch contract — string, URL, or Request input — with
  // `init` taking precedence over Request fields, exactly like `new
  // Request(input, init)`. Without this, a non-corgi caller hitting the
  // installed global with a Request would record `'[object Request]'` as the
  // url and lose its method/headers/body.
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
    let settle!: () => void;
    const tracker = new Promise<void>((resolve) => {
      settle = resolve;
    });
    inFlight.add(tracker);
    // Idempotent — the hang path calls it early, the `finally` calls it again.
    const finish = (): void => {
      inFlight.delete(tracker);
      settle();
    };
    try {
      const call = await toCall(input, init);
      log.push(call);
      const signal = init?.signal ?? call.request?.signal ?? undefined;
      // An already-aborted signal rejects BEFORE matching — a real fetch never
      // dials either. The call is still recorded above.
      if (signal?.aborted) throw signal.reason;
      const route = findRoute(call);
      if (!route) {
        unmatchedLog.push(call);
        throw unmatched(call);
      }
      // `return await` (not `return`) is load-bearing: it keeps this dispatch
      // inside the try, so `finally` runs when the request SETTLES rather than
      // when the promise is handed back.
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
      const g = globalThis as { fetch?: typeof fetch };
      const had = 'fetch' in g;
      const previous = g.fetch;
      g.fetch = transport;
      let done = false;
      uninstall = (): void => {
        if (done) return; // restoring twice is a no-op
        done = true;
        uninstall = undefined; // a later install() starts a fresh capture
        // Reinstate exactly what install() saw — assignment when fetch existed
        // (even inherited: assignment shadows, restore re-shadows with the
        // captured value), deletion when it was genuinely absent.
        if (had) g.fetch = previous;
        else delete g.fetch;
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
      const want = method?.toUpperCase();
      return log.filter((call) => (want === undefined || call.method === want) && matches(pattern, call));
    },
    get unmatchedCalls(): readonly MockCall[] {
      return unmatchedLog;
    },
    get unusedRoutes(): readonly string[] {
      return routes.filter((route) => route.served === 0).map(describeRoute);
    },
    async settled(): Promise<void> {
      let quiet = 0;
      for (;;) {
        // Trackers never reject, so this can't throw and can't mark a dropped
        // request as handled.
        while (inFlight.size > 0) {
          await Promise.all(inFlight);
          quiet = 0; // new work ran — an earlier quiet turn proves nothing now
        }
        const before = log.length;
        await new Promise((resolve) => setTimeout(resolve, 0));
        // TWO consecutive quiet turns, not one. A response handler that defers
        // its follow-up with setTimeout(0) creates that timer AFTER our probe
        // timer: this continuation resumes the moment the tracker settles,
        // while the handler still sits behind body parsing in the same
        // microtask drain. So the FIRST probe always fires ahead of the
        // handler's timer and sees a quiet log — but the handler's timer fires
        // ahead of the SECOND probe. One extra turn is exactly enough to
        // observe a one-hop timer deferral and keep waiting.
        if (inFlight.size === 0 && log.length === before) {
          if (++quiet >= 2) return;
        } else quiet = 0;
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

/* -------------------------------------------------------------------------- */
/* Error factories — for the name-based guards.                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a real `HttpError` without a request — for driving code that CONSUMES
 * corgi errors (error mappers, fallback UI, logging) and for asserting against
 * thrown ones.
 *
 * Hand-rolling one is subtly wrong twice: `new Response(null, { status: 404 })`
 * has an EMPTY `statusText` and an EMPTY `url` (only a real fetch fills them),
 * so the error's message renders as `HTTP 404  ()` — and for 204/205/304 the
 * Response constructor outright THROWS on any body. This factory fills
 * `statusText` from the standard reason-phrase table (overridable via `init`),
 * patches `url` on when given, and mirrors `data` into the response body so
 * `err.response.text()` behaves like the real thing.
 *
 *   const banner = bannerFor(httpError(503, { message: 'maintenance' }))
 *   assert.equal(banner.kind, 'maintenance')
 *
 * NOT for `mockFetch` replies — those are rejected with an explanation: reply
 * `{ status: 503 }` and let the pipeline construct the error instead.
 */
export function httpError<T = unknown>(
  status: number,
  data?: T,
  init?: { statusText?: string; url?: string; headers?: HeadersInit },
): HttpError<T> {
  assertStatus(status, 'httpError');
  const statusText = init?.statusText ?? STATUS_TEXT[status] ?? '';
  const headers = new Headers(init?.headers);
  const body = NULL_BODY_STATUS.has(status) || data === undefined ? null : (JSON.stringify(data) ?? 'null');
  if (body !== null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = new Response(body, { status, statusText, headers });
  // Before constructing the error — its message interpolates response.url.
  if (init?.url) Object.defineProperty(response, 'url', { value: init.url, configurable: true });
  return new HttpError(response, data as T);
}

/**
 * A transport-level network failure: `new TypeError('fetch failed')`, undici's
 * literal message. The MESSAGE matters, not just the type: `withRetry` retries a
 * `TypeError` only when it doesn't look like a programmer error (it rejects
 * messages matching "is not a function", "cannot read", …) — a hand-rolled
 * message one word wrong can silently disable retry in the test.
 */
export function networkError(message = 'fetch failed'): TypeError {
  return new TypeError(message);
}

/**
 * A caller cancel (or an `abortPrevious` supersede): a `DOMException` named
 * `"AbortError"`, which is what `isAbortError` checks. The default message is
 * the platform's own (`AbortController.abort()` with no reason).
 */
export function abortError(message = 'This operation was aborted'): DOMException {
  return new DOMException(message, 'AbortError');
}

/**
 * A fired deadline: a `DOMException` named `"TimeoutError"`, which is what
 * `isTimeoutError` checks — the same shape `withTimeout` and
 * `AbortSignal.timeout()` abort with.
 */
export function timeoutError(message = 'Request timed out'): DOMException {
  return new DOMException(message, 'TimeoutError');
}
