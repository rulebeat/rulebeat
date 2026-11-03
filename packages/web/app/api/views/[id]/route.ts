import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { markedSavedView } from '@/lib/outside-access';
import { guardItem } from '@/lib/item-access';
import { deleteSavedView, getSavedView, updateSavedView } from '@/lib/db/saved-views';
import { SAVED_VIEW_FIELDS, parseSavedViewFields, savedViewNameTakenMessage } from '@/lib/saved-views';

type Params = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Params) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  try {
    const view = await getSavedView(id);
    const refused = guardItem(actor, 'view', view, 'open');
    if (refused || !view) return refused ?? Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(markedSavedView(actor.access, view));
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
    const refused = guardItem(actor, 'view', await getSavedView(id), 'change');
    if (refused) return refused;
    const result = await updateSavedView(id, fields.value, actor.id);
    if (!result.ok) {
      if (result.reason === 'not-found') return Response.json({ error: 'Not found' }, { status: 404 });
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
    return Response.json(markedSavedView(actor.access, view));
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
