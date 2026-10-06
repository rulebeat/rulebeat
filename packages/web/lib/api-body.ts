import { NextResponse } from 'next/server';

const JSON_CONTENT_TYPE_RESPONSE = () =>
  NextResponse.json({ error: 'Content-Type must be application/json.' }, { status: 415 });

/**
 * A cross-site "simple request" (one that needs no CORS preflight) can only ever carry one of
 * three browser-set Content-Types when it has a body: text/plain, application/x-www-form-urlencoded
 * or multipart/form-data — never application/json, and never no Content-Type at all. Requiring an
 * explicit JSON Content-Type before treating a body as JSON is what makes that distinction useful;
 * `;charset=...` and similar parameters are ignored, and the `application/*+json` structured
 * suffix (RFC 6839) is accepted the same as plain `application/json`.
 */
export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || (type.startsWith('application/') && type.endsWith('+json'));
}

/**
 * Parses a request's JSON body, turning malformed JSON into the same client-safe 400 every route
 * already returns for a missing/invalid field — instead of an uncaught `SyntaxError` from
 * `req.json()` surfacing as an unhandled 500. A Content-Type that does not say JSON is refused
 * with 415 before the body is even read.
 *
 * Mirrors `requireRole`'s calling convention: callers check `instanceof NextResponse` and return
 * it straight through, or use the parsed body.
 */
export async function parseJsonBody<T>(req: Request): Promise<T | NextResponse> {
  if (!isJsonContentType(req.headers.get('content-type'))) {
    return JSON_CONTENT_TYPE_RESPONSE();
  }
  try {
    return (await req.json()) as T;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
}

/**
 * The same Content-Type requirement as `parseJsonBody`, for the handful of routes where an empty
 * body is itself meaningful ("test what is currently saved", "generate a password") rather than an
 * error. Only an empty body with no Content-Type header at all, what a same-origin
 * `fetch(url, { method: 'POST' })` with no body produces, falls back to `fallback`; a non-empty
 * body or a Content-Type that is present but not JSON (an empty cross-site form still sets
 * application/x-www-form-urlencoded) is refused the same way `parseJsonBody` refuses it.
 */
export async function parseOptionalJsonBody<T>(req: Request, fallback: T): Promise<T | NextResponse> {
  const contentType = req.headers.get('content-type');
  const text = await req.text();
  if (!text) {
    if (!contentType) return fallback;
    return isJsonContentType(contentType) ? fallback : JSON_CONTENT_TYPE_RESPONSE();
  }
  if (!isJsonContentType(contentType)) {
    return JSON_CONTENT_TYPE_RESPONSE();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
}
