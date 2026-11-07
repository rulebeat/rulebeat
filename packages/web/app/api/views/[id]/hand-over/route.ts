import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { serverError } from '@/lib/api-error';
import { getSavedView, transferSavedView } from '@/lib/db/saved-views';
import { writeAudit } from '@/lib/db/audit';
import { markedSavedView } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { ownerLabel } from '@/lib/item-access-model';
import { handOverCandidates } from '@/lib/hand-over-candidates';
import { NOT_ELIGIBLE_TO_OWN, staleStateMessage } from '@/lib/item-sharing';
import { savedViewNameTakenMessage } from '@/lib/saved-views';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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

    // Eligibility is asked again here, from the same list the picker was given, never taken from the page.
    const body = await request.json().catch(() => null) as { userId?: unknown } | null;
    const chosen = typeof body?.userId === 'string'
      ? (await handOverCandidates('view', before.owner?.id ?? null)).find(c => c.id === body.userId)
      : undefined;
    if (!chosen) return Response.json({ error: NOT_ELIGIBLE_TO_OWN }, { status: 400 });

    const result = await transferSavedView(id, before.owner?.id ?? null, chosen.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      const error = result.reason === 'name-taken' ? savedViewNameTakenMessage(before.name) : staleStateMessage('view');
      return Response.json({ error }, { status: 409 });
    }

    await writeAudit({
      actor,
      action: 'view.hand_over',
      entityType: 'saved_view',
      entityId: id,
      summary: `Handed over saved view "${before.name}" from ${before.owner ? ownerLabel(before.owner) : 'no owner'} to ${chosen.displayName}`,
    });
    return Response.json(markedSavedView(actor.access, result.view));
  } catch (err) {
    return serverError('Could not hand over the saved view', err);
  }
}
