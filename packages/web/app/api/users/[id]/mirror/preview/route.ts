import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { mirrorAccount } from '@/lib/access-mirror';
import { parseObjectId } from '@/lib/access-mirror-model';
import { MIRROR_BAD_OBJECT_ID_MESSAGE, mirrorFailureResponse, mirrorTarget, previewScopes } from '@/lib/access-mirror-routes';
import { listUsersLinkedTo } from '@/lib/db/users';

export const dynamic = 'force-dynamic';

/**
 * Runs the mirror once for an account and answers with the Scopes it would give, each with the Azure roles
 * behind it, and the other people already linked to that account. It writes nothing: no row, no status and
 * no audit entry. The Admin confirms with PUT, which runs the mirror again on the server.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<{ objectId?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  const objectId = parseObjectId(body.objectId);
  if (!objectId) return NextResponse.json({ error: MIRROR_BAD_OBJECT_ID_MESSAGE }, { status: 400 });

  try {
    const target = await mirrorTarget(id);
    if (target instanceof NextResponse) return target;

    const result = await mirrorAccount(objectId);
    if (!result.ok) return mirrorFailureResponse(result.error);
    return NextResponse.json({
      scopes: previewScopes(result.scopes),
      alsoLinkedTo: await listUsersLinkedTo(objectId, id),
    });
  } catch (err) {
    return serverError('Could not preview this Linked account', err);
  }
}
