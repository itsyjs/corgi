/**
 * body.ts — turn whatever the caller passed as `body` into a real `BodyInit`.
 *
 * A plain object/array becomes JSON (the content-type is reported so the caller
 * can set it if unset). Everything the platform already knows how to send —
 * FormData, Blob, URLSearchParams, streams, binary — passes through untouched
 * so the runtime can set its own headers, notably FormData's
 * `multipart/form-data; boundary=...`, which must not be clobbered.
 */

export interface SerializedBody {
  /** The value to hand to `fetch` (or `undefined`/`null` for "no body"). */
  body: BodyInit | null | undefined;
  /** Set to `application/json` only when a plain object/array was serialized. */
  contentType?: string;
}

export function serializeBody(body: unknown): SerializedBody {
  // Guard null/undefined first: `typeof null === 'object'`, so the JSON branch
  // below would otherwise send the literal string "null".
  if (body == null) return { body: body as null | undefined };

  // Primitives (realistically just strings) are valid BodyInit already.
  if (typeof body !== 'object') return { body: body as BodyInit };

  // Anything the platform serializes on its own passes straight through — a
  // JSON content-type on FormData would clobber its multipart boundary.
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

  return { body: JSON.stringify(body), contentType: 'application/json' };
}
