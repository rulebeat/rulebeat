import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getDashboard, unshareDashboard, dashboardNameTakenMessage } from '@/lib/db/dashboards';
import { writeAudit } from '@/lib/db/audit';
import { markedDashboard } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { staleStateMessage, TAKE_OVER_BEFORE_UNSHARING } from '@/lib/item-sharing';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: unsharing needs the Write action
  // on their own item or the Manage action on any Shared one, which guardItem() checks next.
  const actor = await requireRole('dashboards:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getDashboard(id);
    const refused = guardItem(actor, 'dashboard', before, 'unshare');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });

    const result = await unshareDashboard(id, actor.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? dashboardNameTakenMessage(before.name)
        : result.reason === 'no-owner' ? TAKE_OVER_BEFORE_UNSHARING
        : staleStateMessage('dashboard');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'dashboard.unshare',
      entityType: 'dashboard',
      entityId: id,
      // The name it had while Shared: a rename to the next free name is the owner's Personal name, never logged.
      summary: `Unshared dashboard "${result.sharedName}"`,
    });
    // Someone else's unshare may have renamed it to a name only the owner should read, so only the owner gets the item.
    if (result.dashboard.owner?.id !== actor.id) {
      return Response.json({ id, visibility: result.dashboard.visibility, revision: result.dashboard.revision });
    }
    return Response.json(markedDashboard(actor.access, result.dashboard));
  } catch (err) {
    return serverError('Could not unshare the dashboard', err);
  }
}
