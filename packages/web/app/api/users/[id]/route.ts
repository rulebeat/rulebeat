import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getUser, updateUserRole, deleteUser } from '@/lib/db/users';
import { writeAudit } from '@/lib/db/audit';
import { isRole } from '@/lib/rbac';

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<{ role?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!isRole(body.role)) return NextResponse.json({ error: 'Unknown role.' }, { status: 400 });

  const before = getUser(id);
  const result = updateUserRole(id, body.role);
  if (result === null) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  // Refusing to demote the last admin — otherwise a single click locks everyone out of a
  // self-hosted install with no recovery path short of editing SQLite by hand.
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  writeAudit({
    actor,
    action: 'user.role_change',
    entityType: 'user',
    entityId: id,
    summary: `Changed ${result.user.email} from ${before?.role ?? 'unknown'} to ${result.user.role}`,
    details: { from: before?.role, to: result.user.role },
  });

  return NextResponse.json(result.user);
}

export async function DELETE(
  _: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const before = getUser(id);
  const result = deleteUser(id);
  if (result === 'notfound') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'last-admin') {
    return NextResponse.json({ error: 'This is the only admin. Promote someone else to admin first.' }, { status: 409 });
  }

  writeAudit({
    actor,
    action: 'user.remove',
    entityType: 'user',
    entityId: id,
    summary: `Removed ${before?.email ?? id} (was ${before?.role ?? 'unknown'})`,
  });

  return NextResponse.json({ success: true });
}
