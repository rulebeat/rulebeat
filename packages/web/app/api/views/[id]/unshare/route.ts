import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { markedSavedView } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { getSavedView, unshareSavedView } from '@/lib/db/saved-views';
import { savedViewNameTakenMessage } from '@/lib/saved-views';
import { staleStateMessage, TAKE_OVER_BEFORE_UNSHARING } from '@/lib/item-sharing';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: unsharing needs the Write action
  // on their own item or the Manage action on any Shared one, which guardItem() checks next.
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getSavedView(id);
    const refused = guardItem(actor, 'view', before, 'unshare');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });

    const result = await unshareSavedView(id, actor.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? savedViewNameTakenMessage(before.name)
        : result.reason === 'no-owner' ? TAKE_OVER_BEFORE_UNSHARING
        : staleStateMessage('view');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'view.unshare',
      entityType: 'saved_view',
      entityId: id,
      // The name it had while Shared: a rename to the next free name is the owner's Personal name, never logged.
      summary: `Unshared saved view "${result.sharedName}"`,
    });
    // Someone else's unshare may have renamed it to a name only the owner should read, so only the owner gets the item.
    if (result.view.owner?.id !== actor.id) {
      return Response.json({ id, visibility: result.view.visibility, revision: result.view.revision });
    }
    return Response.json(markedSavedView(actor.access, result.view));
  } catch (err) {
    return serverError('Could not unshare the saved view', err);
  }
}
