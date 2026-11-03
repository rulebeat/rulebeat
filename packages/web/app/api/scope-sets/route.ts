import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseCappedJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { createScopeSet } from '@/lib/db/scope-sets';
import { SCOPE_SET_MAX_BODY_BYTES, SCOPE_SET_MAX_PATHS, checkScopeSetShape, pathsOutsideAccess } from '@/lib/scope-sets';

/**
 * Turns a Scope list too long for an address into the hash it travels as (ADR 0016). The server checks
 * every path, takes only what the caller holds (Everything may send any) and computes the hash itself.
 * Nothing is changed for anyone else and the row is immutable, so there is no audit entry.
 */
export async function POST(req: Request) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;

  const body = await parseCappedJsonBody<{ paths?: unknown } | null>(req, SCOPE_SET_MAX_BODY_BYTES);
  if (body instanceof NextResponse) return body;
  const shape = checkScopeSetShape(body !== null && typeof body === 'object' && !Array.isArray(body) ? body.paths : undefined);
  if (!shape.ok) {
    return Response.json({
      error: shape.reason === 'too-many'
        ? `A set holds at most ${SCOPE_SET_MAX_PATHS} paths.`
        : 'Send paths as a list of management group, subscription, resource group or Directory paths.',
    }, { status: 400 });
  }
  if (pathsOutsideAccess(actor.access, shape.paths).length > 0) {
    return Response.json({ error: 'A path in the list is outside the Scopes you hold.' }, { status: 400 });
  }

  try {
    const set = await createScopeSet(shape.paths);
    return Response.json({ hash: set.hash, count: set.paths.length });
  } catch (err) {
    return serverError('Could not store the Scope list', err);
  }
}
