import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseOptionalJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { holdBackSavedViews, removeHeldBackFromView } from '@/lib/db/held-back';
import { STALE_VIEW_MESSAGE, claimedRevision } from '@/lib/held-back';
import { guardItem } from '@/lib/item-access';
import { getSavedView, updateSavedView } from '@/lib/db/saved-views';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Every Role holds the Personal action, so this only gets the person in: removing values changes the view,
  // which needs whatever editing it needs, and guardItem() checks that next.
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const before = await getSavedView(id);
    const refused = guardItem(actor, 'view', before, 'change');
    if (refused || !before) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    const body = await parseOptionalJsonBody<{ revision?: unknown }>(request, {});
    if (body instanceof NextResponse) return body;

    // The write is made on the revision of the copy the person saw the count on, so a view that has moved on
    // since is refused rather than having values removed that the person never counted.
    const revision = claimedRevision(body) ?? before.revision;
    if (revision !== before.revision) return Response.json({ error: STALE_VIEW_MESSAGE }, { status: 409 });

    const { query, removed } = await removeHeldBackFromView(actor.access, before);
    if (removed === 0) return Response.json((await holdBackSavedViews(actor.access, [before]))[0]);

    const result = await updateSavedView(id, { query }, actor.id, { ifRevision: revision });
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json({ error: STALE_VIEW_MESSAGE }, { status: 409 });
    }

    // The count only: never the values. A Personal view is logged by id and kind, without its name.
    await writeAudit({
      actor,
      action: 'view.remove_held_back',
      entityType: 'saved_view',
      entityId: id,
      summary: before.visibility === 'personal'
        ? 'Removed values held back from a Personal saved view'
        : `Removed values held back from saved view "${before.name}"`,
      details: { heldBackCount: removed },
    });
    return Response.json((await holdBackSavedViews(actor.access, [result.view]))[0]);
  } catch (err) {
    return serverError('Could not remove the values from the saved view', err);
  }
}
