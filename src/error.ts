/**
 * error.ts — the single error type the client throws, plus name-based guards.
 *
 * Native `fetch` resolves successfully even on 404/500 — you have to remember to
 * check `res.ok` yourself. That silent-success is the #1 footgun Corgi
 * fixes: the value-returning client throws `HttpError` on any non-2xx response.
 * (Use `client.raw(...)` if you want the raw `Response` and no throwing.)
 */

/**
 * Thrown by the client when a response has a non-2xx status (unless
 * `throwOnError: false`).
 *
 * `response` is a *clone* taken before we read the body, so it is still fully
 * readable (`await err.response.text()` works). `data` is a best-effort parse of
 * the error body (JSON or text) for convenience — typed `unknown` because error
 * shapes aren't known at compile time.
 */
export class HttpError extends Error {
  override readonly name = 'HttpError';
  // `declare` keeps the (readonly) types + `.d.ts` surface but emits NO runtime
  // field slots — the constructor below assigns them. Without `declare`, es2022
  // would emit five empty `field;` declarations that the constructor immediately
  // overwrites: pure dead bytes.
  declare readonly status: number;
  declare readonly statusText: string;
  declare readonly url: string;
  declare readonly response: Response;
  declare readonly data: unknown;

  constructor(response: Response, data: unknown) {
    super(`HTTP ${response.status} ${response.statusText} (${response.url})`);
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
    this.response = response;
    this.data = data;
  }
}

/**
 * Is this an {@link HttpError}? Checked by `name`, not `instanceof`, so it stays
 * correct across iframes, web workers, and vm contexts, and across duplicate bundled
 * copies — both situations where `instanceof` silently returns false.
 */
export function isHttpError(error: unknown): error is HttpError {
  return hasName(error, 'HttpError');
}

/**
 * Did a request time out (as opposed to being cancelled by the caller)?
 * Timeouts abort with a `DOMException` named `"TimeoutError"`; caller aborts use
 * `"AbortError"`. We compare the name, not `instanceof`, so the check is name-based.
 */
export function isTimeoutError(error: unknown): boolean {
  return hasName(error, 'TimeoutError');
}

/** Was a request aborted by the caller (or a superseding call)? See above. */
export function isAbortError(error: unknown): boolean {
  return hasName(error, 'AbortError');
}

function hasName(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name;
}
