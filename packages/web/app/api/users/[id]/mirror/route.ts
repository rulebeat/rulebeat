import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { mirrorAccount } from '@/lib/access-mirror';
import { parseObjectId } from '@/lib/access-mirror-model';
import {
  MIRROR_ADMIN_MESSAGE, MIRROR_BAD_OBJECT_ID_MESSAGE, MIRROR_BAD_ROLE_MESSAGE, mirrorFailureResponse, mirrorTarget,
} from '@/lib/access-mirror-routes';
import { changedAccessFields, withAccess } from '@/lib/access';
import { listUsersLinkedTo, setMirroredAccess } from '@/lib/db/users';
import { writeAudit } from '@/lib/db/audit';

export const dynamic = 'force-dynamic';

/**
 * Gives a Viewer or Editor Mirrored access: one Role and a Linked account. The mirror runs again here on the
 * server and its result is what is stored, replacing any Manual access. The Scopes are never read from the
 * body, and neither is the tenant they are stored under. A run that fails changes nothing. The audit entry
 * holds field names only.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<{ objectId?: unknown; role?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  const objectId = parseObjectId(body.objectId);
  if (!objectId) return NextResponse.json({ error: MIRROR_BAD_OBJECT_ID_MESSAGE }, { status: 400 });
  if (body.role !== 'viewer' && body.role !== 'editor') {
    return NextResponse.json({ error: MIRROR_BAD_ROLE_MESSAGE }, { status: 400 });
  }
  const role = body.role;

  try {
    const target = await mirrorTarget(id);
    if (target instanceof NextResponse) return target;
    // Read before the write, or the audit entry would compare the new access with itself.
    const before = await withAccess(target);

    const result = await mirrorAccount(objectId);
    if (!result.ok) return mirrorFailureResponse(result.error);

    const stored = await setMirroredAccess(id, {
      role, tenantId: result.tenantId, objectId, scopes: result.scopes, at: new Date().toISOString(),
    });
    if (stored === 'notfound') return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (stored === 'admin') return NextResponse.json({ error: MIRROR_ADMIN_MESSAGE }, { status: 400 });

    const updated = await withAccess(stored.user);
    await writeAudit({
      actor,
      action: 'user.mirror_set',
      entityType: 'user',
      entityId: id,
      summary: `Gave ${updated.email} Mirrored access`,
      details: { changed: changedAccessFields(before, updated) },
    });
    return NextResponse.json({ ...updated, alsoLinkedTo: await listUsersLinkedTo(objectId, id) });
  } catch (err) {
    return serverError('Could not save this Mirrored access', err);
  }
}
