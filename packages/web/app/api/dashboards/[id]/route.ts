import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getDashboard, updateDashboard, deleteDashboard, setDefaultDashboard } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import type { DashboardConfig } from '@/lib/types';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const d = await getDashboard(id);
  if (!d) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(d);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:write');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const body = await parseJsonBody<{ name?: string; description?: string; config?: DashboardConfig; isDefault?: boolean }>(req);
  if (body instanceof NextResponse) return body;

  if (body.isDefault) {
    const ok = await setDefaultDashboard(id);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
  }

  if (body.name === undefined && body.description === undefined && body.config === undefined) {
    // isDefault-only request — return the (now-updated) dashboard without touching other fields.
    return Response.json(await getDashboard(id));
  }

  const before = await getDashboard(id);
  const result = await updateDashboard(id, body);
  if (result === null) return Response.json({ error: 'Not found' }, { status: 404 });
  if ('error' in result) return Response.json({ error: result.error }, { status: 409 });

  // Only renames are audited. Every widget drag and resize also lands here as a `config` save,
  // and logging those would bury every meaningful entry under layout noise.
  const renamed = before && (
    (body.name !== undefined && body.name !== before.name) ||
    (body.description !== undefined && body.description !== before.description)
  );
  if (renamed) {
    await writeAudit({
      actor,
      action: 'dashboard.rename',
      entityType: 'dashboard',
      entityId: id,
      summary: `Renamed dashboard "${before.name}" to "${result.dashboard.name}"`,
    });
  }

  return Response.json(result.dashboard);
}

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:write');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const before = await getDashboard(id);
  const ok = await deleteDashboard(id);
  if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });

  await writeAudit({
    actor,
    action: 'dashboard.delete',
    entityType: 'dashboard',
    entityId: id,
    summary: `Deleted dashboard "${before?.name ?? id}"`,
  });

  return new Response(null, { status: 204 });
}
