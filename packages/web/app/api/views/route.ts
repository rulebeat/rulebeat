import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { markedSavedView } from '@/lib/outside-access';
import { createSavedView, listSavedViews } from '@/lib/db/saved-views';
import { buildViewFromOpen, staleAnswer } from '@/lib/saved-view-save';
import { SAVED_VIEW_UNAVAILABLE, type SavedViewFields } from '@/lib/saved-view-query';
import {
  SAVED_VIEW_CHANGED_MESSAGE, SAVED_VIEW_FIELDS, SAVED_VIEW_QUERY_TOO_LONG_MESSAGE, parseSavedViewFields, parseSavedViewFromOpen, readRevision, savedViewNameTakenMessage,
} from '@/lib/saved-views';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  try {
    return Response.json((await listSavedViews()).map(v => markedSavedView(actor.access, v)));
  } catch (err) {
    return serverError('Could not load saved views', err);
  }
}

export async function POST(req: Request) {
  const actor = await requireRole('views:write');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<unknown>(req);
  if (body instanceof NextResponse) return body;

  // With a view open the server builds the new one from it, so a value the saver cannot see is dropped
  // and counted here rather than lost or widened in a copy the browser built (ADR 0013).
  const fromView = typeof body === 'object' && body !== null && 'fromView' in body;
  let dropped: number | undefined;
  let fields: { name: string; tab: SavedViewFields['tab']; query: string };
  if (fromView) {
    const revision = readRevision(body);
    if (revision === null) return Response.json({ error: SAVED_VIEW_CHANGED_MESSAGE }, { status: 409 });
    const parsed = parseSavedViewFromOpen(body);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    try {
      const built = await buildViewFromOpen({ viewId: parsed.value.fromView, revision, changes: parsed.value.changes, access: actor.access });
      if (!built.ok) {
        if (built.reason === 'stale') return await staleAnswer(built.view, actor.access);
        if (built.reason === 'too-long') return Response.json({ error: SAVED_VIEW_QUERY_TOO_LONG_MESSAGE }, { status: 400 });
        return Response.json({ error: SAVED_VIEW_UNAVAILABLE }, { status: 404 });
      }
      dropped = built.dropped;
      fields = { name: parsed.value.name, tab: parsed.value.tab, query: built.query };
    } catch (err) {
      return serverError('Could not save the view', err);
    }
  } else {
    const parsed = parseSavedViewFields(body);
    if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
    fields = parsed.value;
  }

  try {
    const result = await createSavedView(fields, actor.id);
    if (!result.ok) return Response.json({ error: savedViewNameTakenMessage(fields.name) }, { status: 409 });

    await writeAudit({
      actor,
      action: 'view.create',
      entityType: 'saved_view',
      entityId: result.view.id,
      summary: `Saved view "${result.view.name}"`,
      details: { fields: SAVED_VIEW_FIELDS },
    });
    return Response.json({ ...markedSavedView(actor.access, result.view), ...(dropped !== undefined && { dropped }) }, { status: 201 });
  } catch (err) {
    return serverError('Could not save the view', err);
  }
}
