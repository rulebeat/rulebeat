import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { createUser } from '@/lib/db/users';
import type { AssignmentInput } from '@/lib/db/role-assignments';
import { listUsersWithAccess, withAccess, changedAccessFields } from '@/lib/access';
import { parseManualAccess } from '@/lib/access-model';
import { assignmentsFor } from '@/lib/manual-access';
import { mirrorAccount } from '@/lib/access-mirror';
import { parseObjectId, type MirroredScope } from '@/lib/access-mirror-model';
import { INVITE_BOTH_SOURCES_MESSAGE, MIRROR_BAD_OBJECT_ID_MESSAGE, mirrorFailureResponse } from '@/lib/access-mirror-routes';
import { writeAudit } from '@/lib/db/audit';
import { isRole } from '@/lib/rbac';

export async function GET() {
  const actor = await requireRole('users:manage', { readOnly: true });
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json(await listUsersWithAccess());
}

/**
 * Invites a person before they first sign in. An Admin holds everything and chooses nothing. A Viewer or
 * Editor is given exactly one of the two sources, with no default: Manual access with the Scopes an Admin
 * picked (`access`), or Mirrored access (`source: 'mirrored'` and `objectId`), where the mirror runs here on
 * the server and only its result is stored. A request with neither creates no one.
 */
export async function POST(req: Request) {
  const actor = await requireRole('users:manage');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ email?: string; role?: string; access?: unknown; source?: unknown; objectId?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  // What the request asks to grant, not the signed-in person's own access.
  const { access: requested } = body;
  if (!body.email?.trim()) return NextResponse.json({ error: 'Email is required.' }, { status: 400 });
  if (!isRole(body.role)) return NextResponse.json({ error: 'Unknown role.' }, { status: 400 });
  const wantsMirror = body.source === 'mirrored';

  let access: AssignmentInput[] | undefined;
  let mirrored: { tenantId: string; objectId: string; scopes: MirroredScope[]; at: string } | undefined;
  if (body.role === 'admin') {
    if (requested !== undefined || body.source !== undefined || body.objectId !== undefined) {
      return NextResponse.json({ error: 'An Admin has access to everything, so there is no access to choose.' }, { status: 400 });
    }
  } else if (wantsMirror) {
    if (requested !== undefined) return NextResponse.json({ error: INVITE_BOTH_SOURCES_MESSAGE }, { status: 400 });
    const objectId = parseObjectId(body.objectId);
    if (!objectId) return NextResponse.json({ error: MIRROR_BAD_OBJECT_ID_MESSAGE }, { status: 400 });
    try {
      const result = await mirrorAccount(objectId);
      if (!result.ok) return mirrorFailureResponse(result.error);
      mirrored = { tenantId: result.tenantId, objectId, scopes: result.scopes, at: new Date().toISOString() };
    } catch (err) {
      return serverError('Could not read the Linked account for this invite', err);
    }
  } else {
    if (body.source !== undefined && body.source !== 'manual') {
      return NextResponse.json({ error: 'Choose Mirrored or Manual access.' }, { status: 400 });
    }
    if (body.objectId !== undefined) return NextResponse.json({ error: INVITE_BOTH_SOURCES_MESSAGE }, { status: 400 });
    if (!Array.isArray(requested) || requested.length === 0) {
      return NextResponse.json({ error: 'Choose what this person can access.' }, { status: 400 });
    }
    const parsed = parseManualAccess(requested);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    try {
      const stored = await assignmentsFor(parsed.grants);
      if (!stored.ok) return NextResponse.json({ error: stored.error }, { status: 400 });
      access = stored.assignments;
    } catch (err) {
      return serverError('Could not read the Azure tenant to store this access under', err);
    }
  }

  // The row is created without an oid; it gets linked when this person first signs in.
  const result = await createUser({ email: body.email, role: body.role, access, mirrored });
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 409 });

  const created = await withAccess(result.user);
  await writeAudit({
    actor,
    action: 'user.invite',
    entityType: 'user',
    entityId: created.id,
    summary: `Assigned the ${created.role} role to ${created.email} (before first sign-in)${mirrored ? ' with Mirrored access' : ''}`,
    details: { changed: changedAccessFields(null, created) },
  });

  return NextResponse.json(created, { status: 201 });
}
