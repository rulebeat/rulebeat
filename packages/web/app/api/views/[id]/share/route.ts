import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { holdBackSavedViews } from '@/lib/db/held-back';
import { guardItem } from '@/lib/item-access';
import { getSavedView, shareSavedView } from '@/lib/db/saved-views';
import { savedViewNameTakenMessage } from '@/lib/saved-views';
import { staleStateMessage } from '@/lib/item-sharing';

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: sharing needs the Write action on
  // their own item, which guardItem() checks next.
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getSavedView(id);
    const refused = guardItem(actor, 'view', before, 'share');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });

    const result = await shareSavedView(id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? savedViewNameTakenMessage(before.name) : staleStateMessage('view');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'view.share',
      entityType: 'saved_view',
      entityId: id,
      summary: `Shared saved view "${result.view.name}" with everyone on this install`,
    });
    return Response.json((await holdBackSavedViews(actor.access, [result.view]))[0]);
  } catch (err) {
    return serverError('Could not share the saved view', err);
  }
}
