import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { chooseInstallDefault, getDashboard } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { heldBackDashboardFor } from '@/lib/db/default-dashboard';
import { guardItem } from '@/lib/item-access';

/**
 * Chooses the Install default (ADR 0012): a Shared dashboard, by an Admin or an Editor on Everything. It is
 * a curation call on the whole install, so it has its own route and action rather than riding on a dashboard save.
 */
export async function PUT(req: Request) {
  const actor = await requireRole('dashboards:manage');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ id?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.id !== 'string' || !body.id) return Response.json({ error: 'id is required' }, { status: 400 });

  try {
    // Someone else's Personal dashboard answers like an unknown id, an Admin included.
    const before = await getDashboard(body.id);
    const refused = guardItem(actor, 'dashboard', before, 'open');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });

    const result = await chooseInstallDefault(body.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ error: 'Only a Shared dashboard can be the Install default. Share it first.' }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'dashboard.install_default',
      entityType: 'dashboard',
      entityId: body.id,
      summary: `Set dashboard "${result.dashboard.name}" as the Install default`,
    });
    return Response.json(await heldBackDashboardFor(actor, result.dashboard));
  } catch (err) {
    return serverError('Could not set the Install default', err);
  }
}
