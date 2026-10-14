import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { refreshMirroredUser } from '@/lib/access-mirror';
import { NOT_MIRRORED_MESSAGE, REFRESH_RACE_MESSAGE, mirrorFailureResponse, mirrorTarget } from '@/lib/access-mirror-routes';
import { changedAccessFields, withAccess } from '@/lib/access';
import { getUser } from '@/lib/db/users';
import { writeAudit } from '@/lib/db/audit';

export const dynamic = 'force-dynamic';

/**
 * Reads one mirrored person's Linked account again now. On success their Scopes and the Azure roles behind
 * them are replaced. On a failure the last Scopes stay, the attempt is recorded with a stable code, and the
 * answer is 502 (503 when Azure is not connected) carrying the person as stored. A Manual person or an Admin is
 * refused. One audit entry either way, with field names only.
 */
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  try {
    const target = await mirrorTarget(id);
    if (target instanceof NextResponse) return target;
    if (target.accessSource !== 'mirrored' || !target.linkedAccount) {
      return NextResponse.json({ error: NOT_MIRRORED_MESSAGE }, { status: 400 });
    }
    const before = await withAccess(target);

    const outcome = await refreshMirroredUser(target);
    if (outcome.stale) return NextResponse.json({ error: REFRESH_RACE_MESSAGE }, { status: 409 });

    const current = await getUser(id);
    if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const updated = await withAccess(current);
    await writeAudit({
      actor,
      action: 'user.mirror_refresh',
      entityType: 'user',
      entityId: id,
      summary: outcome.ok
        ? `Refreshed the Mirrored access of ${updated.email}`
        : `Tried to refresh the Mirrored access of ${updated.email} and it failed`,
      details: { changed: changedAccessFields(before, updated) },
    });
    return outcome.ok ? NextResponse.json(updated) : mirrorFailureResponse(outcome.error, updated);
  } catch (err) {
    return serverError('Could not refresh this Mirrored access', err);
  }
}
