import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { createUser } from '@/lib/db/users';
import { listUsersWithAccess, withAccess, changedAccessFields } from '@/lib/access';
import { writeAudit } from '@/lib/db/audit';
import { isRole } from '@/lib/rbac';

export async function GET() {
  const actor = await requireRole('users:manage', { readOnly: true });
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await listUsersWithAccess());
}

export async function POST(req: Request) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ email?: string; role?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.email?.trim()) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });
  if (!isRole(body.role)) return NextResponse.json({ error: 'Unknown role.' }, { status: 400 });

  // The row is created without an oid; it gets linked when this person first signs in.
  const result = await createUser({ email: body.email, role: body.role });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  const created = await withAccess(result.user);
  await writeAudit({
    actor,
    action: 'user.invite',
    entityType: 'user',
    entityId: created.id,
    summary: `Assigned the ${created.role} role to ${created.email} (before first sign-in)`,
    details: { changed: changedAccessFields(null, created) },
  });

  return NextResponse.json(created, { status: 201 });
}
