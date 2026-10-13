import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { getUser, setManualAccess } from '@/lib/db/users';
import { withAccess, changedAccessFields } from '@/lib/access';
import { parseManualAccess } from '@/lib/access-model';
import { assignmentsFor } from '@/lib/manual-access';
import { writeAudit } from '@/lib/db/audit';

const ADMIN_MESSAGE = 'An Admin has access to everything. Demote them first to choose their access.';

/** One person's access, for an Admin: the Scopes they hold and the Role at each. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('users:manage', { readOnly: true });
  if (actor instanceof NextResponse) return actor;

  const user = await getUser((await params).id);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(await withAccess(user));
}

/** Replaces a Viewer's or Editor's Manual access with the list in the body, in one transaction. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<{ access?: unknown }>(req);
  if (body instanceof NextResponse) return body;

  const before = await getUser(id);
  if (!before) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (before.role === 'admin') return NextResponse.json({ error: ADMIN_MESSAGE }, { status: 400 });

  const { access: requested } = body;
  const parsed = parseManualAccess(requested);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  // Read before the write, or the audit entry would compare the new access with itself.
  const beforeWithAccess = await withAccess(before);
  let result;
  try {
    const stored = await assignmentsFor(parsed.grants);
    if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: 400 });
    result = await setManualAccess(id, stored.assignments);
  } catch (err) {
    return serverError('Could not save this access', err);
  }
  if (result === 'notfound') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'admin') return NextResponse.json({ error: ADMIN_MESSAGE }, { status: 400 });

  const updated = await withAccess(result.user);
  await writeAudit({
    actor,
    action: 'user.access_change',
    entityType: 'user',
    entityId: id,
    summary: `Changed what ${updated.email} can access`,
    details: { changed: changedAccessFields(beforeWithAccess, updated) },
  });

  return NextResponse.json(updated);
}
