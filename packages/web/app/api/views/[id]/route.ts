import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { deleteSavedView, getSavedView, updateSavedView } from '@/lib/db/saved-views';
import { SAVED_VIEW_FIELDS, parseSavedViewFields, savedViewNameTakenMessage } from '@/lib/saved-views';

type Params = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Params) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  try {
    const view = await getSavedView(id);
    if (!view) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(view);
  } catch (err) {
    return serverError('Could not load the saved view', err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const actor = await requireRole('views:write');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  const body = await parseJsonBody<unknown>(req);
  if (body instanceof NextResponse) return body;
  const fields = parseSavedViewFields(body, 'update');
  if (!fields.ok) return Response.json({ error: fields.error }, { status: 400 });

  try {
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
        summary: renamedOnly
          ? `Renamed saved view "${before.name}" to "${view.name}"`
          : `Updated saved view "${view.name}"`,
        details: { fields: changed },
      });
    }
    return Response.json(view);
  } catch (err) {
    return serverError('Could not update the saved view', err);
  }
}

export async function DELETE(_: Request, { params }: Params) {
  const actor = await requireRole('views:write');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;

  try {
    const removed = await deleteSavedView(id);
    if (!removed) return Response.json({ error: 'Not found' }, { status: 404 });

    await writeAudit({
      actor,
      action: 'view.delete',
      entityType: 'saved_view',
      entityId: id,
      summary: `Deleted saved view "${removed.name}"`,
      details: { fields: SAVED_VIEW_FIELDS },
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError('Could not delete the saved view', err);
  }
}
