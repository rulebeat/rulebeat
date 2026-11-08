import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getSavedView, transferSavedView } from '@/lib/db/saved-views';
import { writeAudit } from '@/lib/db/audit';
import { holdBackSavedViews } from '@/lib/db/held-back';
import { guardItem } from '@/lib/item-access';
import { staleStateMessage } from '@/lib/item-sharing';
import { savedViewNameTakenMessage } from '@/lib/saved-views';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: taking over needs the Manage action
  // on Shared items, which guardItem() checks next.
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getSavedView(id);
    const refused = guardItem(actor, 'view', before, 'take-over');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    if (before.visibility !== 'shared') return Response.json({ error: staleStateMessage('view') }, { status: 409 });

    const result = await transferSavedView(id, before.owner?.id ?? null, actor.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? savedViewNameTakenMessage(before.name) : staleStateMessage('view');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'view.take_over',
      entityType: 'saved_view',
      entityId: id,
      summary: `Took over saved view "${before.name}"`,
    });
    return Response.json((await holdBackSavedViews(actor.access, [result.view]))[0]);
  } catch (err) {
    return serverError('Could not take over the saved view', err);
  }
}
