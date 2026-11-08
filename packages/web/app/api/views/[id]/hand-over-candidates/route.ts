import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getSavedView } from '@/lib/db/saved-views';
import { guardItem } from '@/lib/item-access';
import { handOverCandidates } from '@/lib/hand-over-candidates';
import { staleStateMessage } from '@/lib/item-sharing';

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: handing over needs the Write action
  // on their own item or the Manage action on any Shared one, which guardItem() checks next.
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getSavedView(id);
    const refused = guardItem(actor, 'view', before, 'hand-over');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    if (before.visibility !== 'shared') return Response.json({ error: staleStateMessage('view') }, { status: 409 });

    return Response.json(await handOverCandidates('view', before.owner?.id ?? null));
  } catch (err) {
    return serverError('Could not list the people this saved view can be handed to', err);
  }
}
