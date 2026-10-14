import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { mirrorAccount } from '@/lib/access-mirror';
import { parseObjectId } from '@/lib/access-mirror-model';
import { MIRROR_BAD_OBJECT_ID_MESSAGE, mirrorFailureResponse, previewScopes } from '@/lib/access-mirror-routes';
import { listUsersLinkedTo } from '@/lib/db/users';

export const dynamic = 'force-dynamic';

/**
 * The preview an invite with Mirrored access shows before it is sent: the mirror runs once for the account and
 * answers with the Scopes it would give and the people already linked to it, as
 * `POST /api/users/[id]/mirror/preview` does for someone who exists. It writes nothing. The invite runs the
 * mirror again on the server and stores that result.
 */
export async function POST(req: Request) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ objectId?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  const objectId = parseObjectId(body.objectId);
  if (!objectId) return NextResponse.json({ error: MIRROR_BAD_OBJECT_ID_MESSAGE }, { status: 400 });

  try {
    const result = await mirrorAccount(objectId);
    if (!result.ok) return mirrorFailureResponse(result.error);
    return NextResponse.json({ scopes: previewScopes(result.scopes), alsoLinkedTo: await listUsersLinkedTo(objectId) });
  } catch (err) {
    return serverError('Could not preview this Linked account', err);
  }
}
