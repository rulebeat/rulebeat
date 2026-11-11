import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { getDashboard, updateDashboard, deleteDashboard, setDefaultDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { keepSavedFilters } from '@/lib/dashboard-filters';
import { markedDashboard } from '@/lib/outside-access';
import type { DashboardConfig } from '@/lib/types';

const DASHBOARD_CHANGED = 'This dashboard changed since you opened it. Reload to continue.';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const d = await getDashboard(id);
  if (!d) return Response.json({ error: 'Not found' }, { status: 404 });
  return Response.json(markedDashboard(actor.access, d));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:write');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  const body = await parseJsonBody<{ name?: string; description?: string; config?: DashboardConfig; isDefault?: boolean; revision?: number }>(req);
  if (body instanceof NextResponse) return body;

  const writesContent = body.name !== undefined || body.description !== undefined || body.config !== undefined;
  // An old tab still running the autosave never sends a revision. Refusing it before anything is written
  // keeps it from overwriting the layout or the name. Only an isDefault-only request is exempt.
  if (writesContent && typeof body.revision !== 'number') {
    return Response.json({ error: DASHBOARD_CHANGED }, { status: 409 });
  }

  if (body.isDefault) {
    const ok = await setDefaultDashboard(id);
    if (!ok) return Response.json({ error: 'Not found' }, { status: 404 });
  }

  if (!writesContent) {
    // isDefault-only request: return the (now-updated) dashboard without touching other fields.
    const updated = await getDashboard(id);
    return Response.json(updated && markedDashboard(actor.access, updated));
  }

  const before = await getDashboard(id);
  // The saved filters change only by an explicit save, never through a layout write.
  const config = body.config && before ? keepSavedFilters(before.config, body.config) : body.config;
  const result = await updateDashboard(id, { ...body, config });
  if (!result.ok) {
    if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
    const error = result.reason === 'empty-name' ? 'Name cannot be empty.' : dashboardNameTakenMessage((body.name ?? '').trim());
    return Response.json({ error }, { status: 409 });
  }

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

  return Response.json(markedDashboard(actor.access, result.dashboard));
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
