import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { getUser, updateUserRole, deleteUser } from '@/lib/db/users';
import type { AssignmentInput } from '@/lib/db/role-assignments';
import { withAccess, changedAccessFields } from '@/lib/access';
import { parseManualAccess } from '@/lib/access-model';
import { assignmentsFor } from '@/lib/manual-access';
import { writeAudit } from '@/lib/db/audit';
import { isRole } from '@/lib/rbac';

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<{ role?: string; access?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  if (!isRole(body.role)) return NextResponse.json({ error: 'Unknown role.' }, { status: 400 });
  // What the request asks to grant, not the signed-in person's own access.
  const { access: requested } = body;

  const before = await getUser(id);
  const beforeWithAccess = before ? await withAccess(before) : null;

  // Access comes with exactly one change: demoting an Admin, who holds nothing to carry over, so the
  // request says what they are to hold. The page sends Everything preselected. Every other Role change
  // keeps the Scopes the person has, and Manual access is edited on its own route.
  const demoting = before?.role === 'admin' && body.role !== 'admin';
  let access: AssignmentInput[] | undefined;
  if (before && demoting) {
    if (requested === undefined) return NextResponse.json({ error: 'Choose what this person can access.' }, { status: 400 });
    const parsed = parseManualAccess(requested);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
      const stored = await assignmentsFor(parsed.grants);
      if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: 400 });
      access = stored.assignments;
    } catch (err) {
      return serverError('Could not read the Azure tenant to store this access under', err);
    }
  } else if (requested !== undefined) {
    return NextResponse.json({ error: 'Access is chosen when an Admin is demoted. Change it on its own otherwise.' }, { status: 400 });
  }

  const result = await updateUserRole(id, body.role, access);
  if (result === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Refusing to demote the last admin, otherwise a single click locks everyone out of a
  // self-hosted install with no recovery path short of editing SQLite by hand.
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  const updated = await withAccess(result.user);
  await writeAudit({
    actor,
    action: 'user.role_change',
    entityType: 'user',
    entityId: id,
    summary: `Changed ${updated.email} from ${before?.role ?? 'unknown'} to ${updated.role}`,
    details: { changed: changedAccessFields(beforeWithAccess, updated) },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const before = await getUser(id);
  const result = await deleteUser(id);
  if (result === 'notfound') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'last-admin') {
    return NextResponse.json({ error: 'This is the only admin. Promote someone else to admin first.' }, { status: 409 });
  }

  await writeAudit({
    actor,
    action: 'user.remove',
    entityType: 'user',
    entityId: id,
    summary: `Removed ${before?.email ?? id} (was ${before?.role ?? 'unknown'})`,
  });
  // The person's open Library requests were withdrawn in the same transaction as their removal.
  if (result.withdrawnRequests > 0) {
    await writeAudit({
      actor,
      action: 'library_request.withdraw',
      entityType: 'library_request',
      entityId: id,
      summary: `Withdrew ${result.withdrawnRequests} open Library ${result.withdrawnRequests === 1 ? 'request' : 'requests'} because ${before?.email ?? id} was removed`,
      details: { withdrawn: result.withdrawnRequests, reason: 'author removed' },
    });
  }

  return NextResponse.json({ success: true });
}
