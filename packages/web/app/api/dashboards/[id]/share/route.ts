import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getDashboard, shareDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { markedDashboard } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { staleStateMessage } from '@/lib/item-sharing';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: sharing needs the Write action on
  // their own item, which guardItem() checks next.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getDashboard(id);
    const refused = guardItem(actor, 'dashboard', before, 'share');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });

    const result = await shareDashboard(id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? dashboardNameTakenMessage(before.name) : staleStateMessage('dashboard');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'dashboard.share',
      entityType: 'dashboard',
      entityId: id,
      summary: `Shared dashboard "${result.dashboard.name}" with everyone on this install`,
    });
    return Response.json(markedDashboard(actor.access, result.dashboard));
  } catch (err) {
    return serverError('Could not share the dashboard', err);
  }
}
