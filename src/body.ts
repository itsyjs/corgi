/**
 * body.ts — turn whatever the caller passed as `body` into a real `BodyInit`.
 *
 * The rule: a plain object/array becomes JSON (and we report the content-type so
 * the caller can set it if not already set). Everything the platform already
 * knows how to send — FormData, Blob, URLSearchParams, streams, binary — passes
 * through UNTOUCHED so the runtime can set the correct headers itself (notably
 * the `multipart/form-data; boundary=...` header for FormData, which we must not
 * clobber).
 */

export interface SerializedBody {
  /** The value to hand to `fetch` (or `undefined`/`null` for "no body"). */
  body: BodyInit | null | undefined;
  /** Set to `application/json` only when we serialized a plain object/array. */
  contentType?: string;
}

export function serializeBody(body: unknown): SerializedBody {
  // Guard null/undefined FIRST. `typeof null === 'object'`, so without this the
  // null-check below would fall through and we'd send the literal string "null".
  if (body == null) return { body: body as null | undefined };

  // Primitives (realistically just strings) are valid BodyInit already.
  if (typeof body !== 'object') return { body: body as BodyInit };

  // Anything the platform serializes on its own passes straight through. Setting
  // a JSON content-type on any of these — especially FormData — would break the
  // request (FormData needs its auto-generated multipart boundary).
  if (
    body instanceof FormData ||
    body instanceof Blob || // covers File too
    body instanceof URLSearchParams ||
    body instanceof ReadableStream ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) // typed arrays & DataView
  ) {
    return { body: body as BodyInit };
  }

  // Plain object or array -> JSON.
  return { body: JSON.stringify(body), contentType: 'application/json' };
}
