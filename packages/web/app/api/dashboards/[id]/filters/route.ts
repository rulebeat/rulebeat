import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { writeAudit } from '@/lib/db/audit';
import { parseFilterChanges, refusalMessage, saveDashboardFilters } from '@/lib/dashboard-filter-save';
import { markedDashboard } from '@/lib/outside-access';

/**
 * "Save as this dashboard's filters": the one way a dashboard's saved filters change (ADR 0013). The
 * body is `{ revision, changes }`; the answer is the new revision and the bar as the saver sees it.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requireRole('dashboards:write');
  if (actor instanceof NextResponse) return actor;

  const { id } = await params;
  const body = await parseJsonBody<{ revision?: unknown; changes?: unknown }>(req);
  if (body instanceof NextResponse) return body;
  const changes = parseFilterChanges(body.changes);
  if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || !changes) {
    return Response.json({ error: 'A save needs the dashboard revision and the filter changes.' }, { status: 400 });
  }

  const result = await saveDashboardFilters({ dashboardId: id, revision: body.revision, changes, access: actor.access });
  if (!result.ok) {
    switch (result.reason) {
      case 'not-found':
        return Response.json({ error: 'Not found' }, { status: 404 });
      case 'stale':
        return Response.json({
          error: 'This dashboard changed since you opened it. Nothing was saved and your changes are still in the address. Check them, then save again.',
          revision: result.revision,
        }, { status: 409 });
      case 'outside-access':
        return Response.json({ error: refusalMessage(result), code: result.reason, count: result.count }, { status: 422 });
      case 'any-over-held-back':
        return Response.json({ error: refusalMessage(result), code: result.reason, dimensions: result.dimensions }, { status: 422 });
    }
  }

  // Dimension names only, never the values. A save that changed nothing is not an event.
  if (result.changed.length > 0) {
    await writeAudit({
      actor,
      action: 'dashboard.filters_save',
      entityType: 'dashboard',
      entityId: id,
      summary: "Saved this dashboard's filters",
      details: { dimensions: result.changed },
    });
  }

  return Response.json({ revision: result.revision, bar: result.bar, dashboard: markedDashboard(actor.access, result.dashboard) });
}
