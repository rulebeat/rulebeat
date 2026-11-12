import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getDashboard, transferDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { holdBackDashboards } from '@/lib/db/held-back';
import { guardItem } from '@/lib/item-access';
import { staleStateMessage } from '@/lib/item-sharing';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: taking over needs the Manage action
  // on Shared items, which guardItem() checks next.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getDashboard(id);
    const refused = guardItem(actor, 'dashboard', before, 'take-over');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    if (before.visibility !== 'shared') return Response.json({ error: staleStateMessage('dashboard') }, { status: 409 });

    const result = await transferDashboard(id, before.owner?.id ?? null, actor.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? dashboardNameTakenMessage(before.name) : staleStateMessage('dashboard');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'dashboard.take_over',
      entityType: 'dashboard',
      entityId: id,
      summary: `Took over dashboard "${before.name}"`,
    });
    return Response.json((await holdBackDashboards(actor.access, [result.dashboard]))[0]);
  } catch (err) {
    return serverError('Could not take over the dashboard', err);
  }
}
