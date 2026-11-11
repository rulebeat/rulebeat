import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { setMyDefault } from '@/lib/db/default-dashboard';

/**
 * Sets the signed-in person's My default (ADR 0012): their own Personal dashboard or any Shared one. It is
 * their own preference, so it is not audited, and choosing one clears the "no longer available" notice.
 */
export async function PUT(req: Request) {
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ id?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.id !== 'string' || !body.id) return Response.json({ error: 'id is required' }, { status: 400 });

  try {
    const result = await setMyDefault(actor.id, body.id);
    if (!result.ok) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json({ id: body.id });
  } catch (err) {
    return serverError('Could not set your default dashboard', err);
  }
}
