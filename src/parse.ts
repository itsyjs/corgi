/**
 * parse.ts — turn a `Response` into a value.
 *
 * This is where several real fetch footguns get handled once, correctly:
 *   - 204/205/304 and HEAD have no body: reading it throws or hangs, so we
 *     short-circuit to `undefined`.
 *   - An empty body with a JSON content-type makes `res.json()` throw
 *     "Unexpected end of JSON input" — we read text first and only parse if
 *     non-empty.
 *   - A missing/unknown content-type is treated as text, NOT guessed as JSON,
 *     so a plain-text or HTML response never blows up.
 */

/**
 * What to parse a response into. `json` is the default.
 *
 * With no explicit `responseType`, the client sniffs the `content-type`:
 *   - `application/json` and structured `+json` suffixes (e.g.
 *     `application/problem+json`, `application/vnd.api+json`), ignoring `; charset`
 *     -> parsed JSON; an empty body yields `undefined` (never throws "Unexpected
 *     end of JSON input");
 *   - `text/*`, or a missing/unknown content-type -> text (never guessed as JSON,
 *     so an HTML error page won't blow up); empty -> `undefined`;
 *   - anything else (octet-stream, images, `application/xml`, …) -> `Blob`.
 * A no-body response (204/205/304, or a HEAD request) is always `undefined`.
 *
 * An explicit `responseType` overrides sniffing — but forcing `'json'` on a
 * non-JSON body throws a `SyntaxError`.
 */
export type ParseAs = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'formData' | 'stream';

// Matches `application/json` and structured-suffix JSON like `application/ld+json`
// or `application/vnd.api+json`, ignoring any `; charset=...` parameter.
const JSON_CONTENT_TYPE = /^application\/([\w.+-]+\+)?json\b/i;

// Statuses that are defined to have no body.
const NULL_BODY_STATUS = new Set([204, 205, 304]);

/**
 * Parse `res` into a value.
 *
 * @param res           the response to read
 * @param method        the request method (HEAD responses carry no body)
 * @param responseType  optional explicit override; when omitted we sniff the
 *                       content-type and fall back to text for unknown types
 */
export async function parseResponse(res: Response, method = 'GET', responseType?: ParseAs): Promise<unknown> {
  // No body to read for these — don't touch the stream.
  if (method.toUpperCase() === 'HEAD' || NULL_BODY_STATUS.has(res.status)) return undefined;

  // Explicit override always wins over content-type sniffing.
  if (responseType) return readAs(res, responseType);

  const contentType = res.headers.get('content-type') ?? '';

  if (JSON_CONTENT_TYPE.test(contentType)) {
    // Read as text first so an empty body yields `undefined` instead of throwing.
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }

  if (contentType.startsWith('text/') || contentType === '') {
    // Known text, or unknown type: return text (empty -> undefined). Never guess
    // JSON here — that's how "smart" parsers explode on HTML error pages.
    const text = await res.text();
    return text || undefined;
  }

  // Everything else (octet-stream, images, etc.): a Blob is the safe default.
  return res.blob();
}

function readAs(res: Response, responseType: ParseAs): Promise<unknown> {
  switch (responseType) {
    case 'text':
      return res.text();
    case 'blob':
      return res.blob();
    case 'arrayBuffer':
      return res.arrayBuffer();
    case 'formData':
      return res.formData();
    case 'stream':
      // The raw byte stream (or null for an empty body). Caller owns it.
      return Promise.resolve(res.body);
    case 'json':
    default:
      return res.text().then((text) => (text ? (JSON.parse(text) as unknown) : undefined));
  }
}
