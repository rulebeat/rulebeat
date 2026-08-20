import { NextResponse } from 'next/server';

/**
 * Parses a request's JSON body, turning malformed JSON into the same client-safe 400 every route
 * already returns for a missing/invalid field — instead of an uncaught `SyntaxError` from
 * `req.json()` surfacing as an unhandled 500.
 *
 * Mirrors `requireRole`'s calling convention: callers check `instanceof NextResponse` and return
 * it straight through, or use the parsed body.
 */
export async function parseJsonBody<T>(req: Request): Promise<T | NextResponse> {
  try {
    return (await req.json()) as T;
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 });
  }
}
