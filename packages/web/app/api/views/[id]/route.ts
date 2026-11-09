import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { markedSavedView } from '@/lib/outside-access';
import { deleteSavedView, getSavedView } from '@/lib/db/saved-views';
import { saveViewChanges, staleAnswer, viewRefusalMessage } from '@/lib/saved-view-save';
import {
  SAVED_VIEW_CHANGED_MESSAGE, SAVED_VIEW_FIELDS, SAVED_VIEW_QUERY_TOO_LONG_MESSAGE, parseSavedViewUpdate, readRevision, savedViewNameTakenMessage,
} from '@/lib/saved-views';

type Params = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: Params) {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  const { id } = await params;
  try {
    const view = await getSavedView(id);
    if (!view) return Response.json({ error: 'Not found' }, { status: 404 });
    return Response.json(markedSavedView(actor.access, view));
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
  // A write over no revision is a write over one the page may not hold: nothing is saved (ADR 0013).
  const revision = readRevision(body);
  if (revision === null) return Response.json({ error: SAVED_VIEW_CHANGED_MESSAGE }, { status: 409 });
  const fields = parseSavedViewUpdate(body);
  if (!fields.ok) return Response.json({ error: fields.error }, { status: 400 });

  try {
    const result = await saveViewChanges({
      viewId: id, revision, name: fields.value.name, changes: fields.value.changes, access: actor.access, actorId: actor.id,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'not-found':
          return Response.json({ error: 'Not found' }, { status: 404 });
        case 'name-taken':
          return Response.json({ error: savedViewNameTakenMessage(fields.value.name ?? '') }, { status: 409 });
        case 'too-long':
          return Response.json({ error: SAVED_VIEW_QUERY_TOO_LONG_MESSAGE }, { status: 400 });
        case 'stale':
          return await staleAnswer(result.view, actor.access);
        case 'outside-access':
          return Response.json({ error: viewRefusalMessage(result), code: result.reason, count: result.count }, { status: 422 });
        case 'any-over-held-back':
          return Response.json({ error: viewRefusalMessage(result), code: result.reason, dimensions: result.dimensions }, { status: 422 });
      }
    }

    // The summary names the view, as the dashboard routes' summaries do, so the log reads without
    // a lookup. `details` holds field names only, never their values: a query is whatever the
    // person filtered on. A save that changed nothing is not an event.
    const { before, view, changed } = result;
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
    return Response.json(markedSavedView(actor.access, view));
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
