import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { holdBackSavedViews, restoreHeldBackView } from '@/lib/db/held-back';
import { carriesPlaceholder, claimedRevision } from '@/lib/held-back';
import { guardItem } from '@/lib/item-access';
import { deleteSavedView, getSavedView, updateSavedView } from '@/lib/db/saved-views';
import { SAVED_VIEW_FIELDS, parseSavedViewFields, savedViewNameTakenMessage } from '@/lib/saved-views';

const STALE_COPY = 'This saved view changed while you were editing it. Reload it and try again.';

type Params = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Params) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  try {
    const view = await getSavedView(id);
    const refused = guardItem(actor, 'view', view, 'open');
    if (refused || !view) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    const [held] = await holdBackSavedViews(actor.access, [view]);
    return Response.json(held);
  } catch (err) {
    return serverError('Could not load the saved view', err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  // Every Role holds the Personal action, so this only gets the person in: which action the change needs
  // depends on the view's owner and visibility, which guardItem() checks next.
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  const body = await parseJsonBody<unknown>(req);
  if (body instanceof NextResponse) return body;
  const fields = parseSavedViewFields(body, 'update');
  if (!fields.ok) return Response.json({ error: fields.error }, { status: 400 });

  try {
    const current = await getSavedView(id);
    const refused = guardItem(actor, 'view', current, 'change');
    if (refused || !current) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    // What the person was sent never held the stored values outside their Access, so they go back in before the
    // save. The write is made on the revision of the copy they were sent, not the one read just now: a copy the
    // item has moved on from is refused, since it would put values (or a placeholder) back that are no longer there.
    const revision = claimedRevision(body);
    const restored = fields.value.query === undefined
      ? { query: undefined, restored: false }
      : await restoreHeldBackView(actor.access, current, fields.value.query);
    if (revision === undefined && (restored.restored || (fields.value.query !== undefined && carriesPlaceholder(fields.value.query)))) {
      return Response.json({ error: STALE_COPY }, { status: 409 });
    }
    const result = await updateSavedView(
      id, { ...fields.value, ...(restored.query !== undefined && { query: restored.query }) }, actor.id,
      revision === undefined ? {} : { ifRevision: revision },
    );
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
      if (result.reason === 'conflict') return Response.json({ error: STALE_COPY }, { status: 409 });
      return Response.json({ error: savedViewNameTakenMessage(fields.value.name ?? '') }, { status: 409 });
    }

    // The summary names the view, as the dashboard routes' summaries do, so the log reads without
    // a lookup. `details` holds field names only, never their values: a query is whatever the
    // person filtered on.
    const { before, view } = result;
    const changed = SAVED_VIEW_FIELDS.filter(f => f in fields.value && view[f] !== before[f]);
    if (changed.length > 0) {
      const renamedOnly = changed.length === 1 && changed[0] === 'name';
      await writeAudit({
        actor,
        action: renamedOnly ? 'view.rename' : 'view.update',
        entityType: 'saved_view',
        entityId: id,
        // A Personal item is logged by id and kind only: its name is its owner's alone.
        summary: before.visibility === 'personal'
          ? (renamedOnly ? 'Renamed a Personal saved view' : 'Updated a Personal saved view')
          : renamedOnly
            ? `Renamed saved view "${before.name}" to "${view.name}"`
            : `Updated saved view "${view.name}"`,
        details: { fields: changed },
      });
    }
    const [held] = await holdBackSavedViews(actor.access, [view]);
    return Response.json(held);
  } catch (err) {
    return serverError('Could not update the saved view', err);
  }
}

export async function DELETE(_: Request, { params }: Params) {
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const refused = guardItem(actor, 'view', await getSavedView(id), 'change');
    if (refused) return refused;
    const removed = await deleteSavedView(id);
    if (!removed) return Response.json({ error: 'Not found' }, { status: 404 });

    await writeAudit({
      actor,
      action: 'view.delete',
      entityType: 'saved_view',
      entityId: id,
      summary: removed.visibility === 'personal' ? 'Deleted a Personal saved view' : `Deleted saved view "${removed.name}"`,
      details: { fields: SAVED_VIEW_FIELDS },
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError('Could not delete the saved view', err);
  }
}
