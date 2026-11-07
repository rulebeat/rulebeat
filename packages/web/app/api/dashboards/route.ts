import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { listDashboards, createDashboard, createStarterDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { holdBackDashboards } from '@/lib/db/held-back';
import { openableItems } from '@/lib/item-access';
import type { DashboardConfig } from '@/lib/types';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  return Response.json(await holdBackDashboards(actor.access, openableItems(actor, await listDashboards())));
}

export async function POST(req: Request) {
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ name?: string; description?: string; config?: DashboardConfig; template?: 'starter' }>(req);
  if (body instanceof NextResponse) return body;

  if (body.template === 'starter') {
    const dashboard = await createStarterDashboard(actor.id);
    // A Personal item is logged by id and kind only: its name is its owner's alone.
    await writeAudit({
      actor,
      action: 'dashboard.create',
      entityType: 'dashboard',
      entityId: dashboard.id,
      summary: 'Restored the starter as a Personal dashboard',
    });
    const [held] = await holdBackDashboards(actor.access, [dashboard]);
    return Response.json(held, { status: 201 });
  }

  if (!body.name?.trim()) return Response.json({ error: 'name is required' }, { status: 400 });

  const name = body.name.trim();
  const result = await createDashboard({
    name,
    description: body.description,
    config: body.config ?? { autoRefresh: 0, widgets: [] },
  }, actor.id);

  if (!result.ok) {
    const error = result.reason === 'empty-name' ? 'Name is required.' : dashboardNameTakenMessage(name);
    return Response.json({ error }, { status: 409 });
  }

  await writeAudit({
    actor,
    action: 'dashboard.create',
    entityType: 'dashboard',
    entityId: result.dashboard.id,
    summary: 'Created a Personal dashboard',
  });

  const [held] = await holdBackDashboards(actor.access, [result.dashboard]);
  return Response.json(held, { status: 201 });
}
