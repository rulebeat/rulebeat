import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { listUsers, createUser } from '@/lib/db/users';
import { writeAudit } from '@/lib/db/audit';
import { isRole } from '@/lib/rbac';

export async function GET() {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(listUsers());
}

export async function POST(req: Request) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ email?: string; role?: string }>(req);
  if (body instanceof NextResponse) return body;
  if (!body.email?.trim()) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });
  if (!isRole(body.role)) return NextResponse.json({ error: 'Unknown role.' }, { status: 400 });

  // The row is created without an oid; it gets linked when this person first signs in.
  const result = createUser({ email: body.email, role: body.role });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  writeAudit({
    actor,
    action: 'user.invite',
    entityType: 'user',
    entityId: result.user.id,
    summary: `Assigned the ${result.user.role} role to ${result.user.email} (before first sign-in)`,
    details: { role: result.user.role },
  });

  return NextResponse.json(result.user, { status: 201 });
}
