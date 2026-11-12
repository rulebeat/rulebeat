import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseOptionalJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { getDashboard, updateDashboard } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { holdBackDashboards, removeHeldBackFromDashboard } from '@/lib/db/held-back';
import { STALE_DASHBOARD_MESSAGE, claimedRevision } from '@/lib/held-back';
import { guardItem } from '@/lib/item-access';
import { sharedDashboardViewsRefusal } from '@/lib/saved-view-reference';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: removing values changes the
  // dashboard, which needs whatever editing it needs, and guardItem() checks that next.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getDashboard(id);
    const refused = guardItem(actor, 'dashboard', before, 'change');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    const body = await parseOptionalJsonBody<{ revision?: unknown }>(request, {});
    if (body instanceof NextResponse) return body;

    // The write is made on the revision of the copy the person saw the count on, so a dashboard that has moved
    // on since is refused rather than having values removed that the person never counted.
    const revision = claimedRevision(body) ?? before.revision;
    if (revision !== before.revision) return Response.json({ error: STALE_DASHBOARD_MESSAGE }, { status: 409 });

    const { config, removed } = await removeHeldBackFromDashboard(actor.access, before);
    if (removed === 0) return Response.json((await holdBackDashboards(actor.access, [before]))[0]);

    const result = await updateDashboard(id, { config }, { ifRevision: revision });
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      if (result.reason === 'views-not-shared') return Response.json({ error: sharedDashboardViewsRefusal(result.widgetTitles) }, { status: 400 });
      return Response.json({ error: STALE_DASHBOARD_MESSAGE }, { status: 409 });
    }

    // The count only: never the values. A Personal dashboard is logged by id and kind, without its name.
    await writeAudit({
      actor,
      action: 'dashboard.remove_held_back',
      entityType: 'dashboard',
      entityId: id,
      summary: before.visibility === 'personal'
        ? 'Removed values held back from a Personal dashboard'
        : `Removed values held back from dashboard "${before.name}"`,
      details: { heldBackCount: removed },
    });
    return Response.json((await holdBackDashboards(actor.access, [result.dashboard]))[0]);
  } catch (err) {
    return serverError('Could not remove the values from the dashboard', err);
  }
}
