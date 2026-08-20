import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { listDashboards, createDashboard, createStarterDashboard } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import type { DashboardConfig } from '@/lib/types';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  return Response.json(listDashboards());
}

export async function POST(req: Request) {
  const actor = await requireRole('dashboards:write');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<{ name?: string; description?: string; config?: DashboardConfig; template?: 'starter' }>(req);
  if (body instanceof NextResponse) return body;

  if (body.template === 'starter') {
    const dashboard = createStarterDashboard();
    writeAudit({
      actor,
      action: 'dashboard.create',
      entityType: 'dashboard',
      entityId: dashboard.id,
      summary: `Restored the starter dashboard "${dashboard.name}"`,
    });
    return Response.json(dashboard, { status: 201 });
  }

  if (!body.name?.trim()) return Response.json({ error: 'name is required' }, { status: 400 });

  const result = createDashboard({
    name: body.name.trim(),
    description: body.description,
    config: body.config ?? { autoRefresh: 0, widgets: [] },
  });

  if ('error' in result) return Response.json({ error: result.error }, { status: 409 });

  writeAudit({
    actor,
    action: 'dashboard.create',
    entityType: 'dashboard',
    entityId: result.dashboard.id,
    summary: `Created dashboard "${result.dashboard.name}"`,
  });

  return Response.json(result.dashboard, { status: 201 });
}
