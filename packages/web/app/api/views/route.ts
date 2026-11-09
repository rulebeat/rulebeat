import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/api-auth';
import { parseJsonBody } from '@/lib/api-body';
import { serverError } from '@/lib/api-error';
import { writeAudit } from '@/lib/db/audit';
import { holdBackSavedViews, restoreHeldBackView } from '@/lib/db/held-back';
import { UNSEEN_VALUE_MESSAGE, withoutPlaceholder } from '@/lib/held-back';
import { openableItems } from '@/lib/item-access';
import { createSavedView, listSavedViews } from '@/lib/db/saved-views';
import { SAVED_VIEW_FIELDS, parseSavedViewFields, savedViewNameTakenMessage } from '@/lib/saved-views';

export async function GET() {
  const actor = await requireRole('read');
  if (actor instanceof NextResponse) return actor;
  try {
    return Response.json(await holdBackSavedViews(actor.access, openableItems(actor, await listSavedViews())));
  } catch (err) {
    return serverError('Could not load saved views', err);
  }
}

export async function POST(req: Request) {
  const actor = await requireRole('views:personal');
  if (actor instanceof NextResponse) return actor;

  const body = await parseJsonBody<unknown>(req);
  if (body instanceof NextResponse) return body;
  const fields = parseSavedViewFields(body, 'create');
  if (!fields.ok) return Response.json({ error: fields.error }, { status: 400 });

  try {
    // A new item holds no value yet, so every value outside the saver's Access in it is one they are bringing in.
    const { unseen } = await restoreHeldBackView(actor.access, { id: '', query: '' }, fields.value.query);
    if (unseen) return Response.json({ error: UNSEEN_VALUE_MESSAGE }, { status: 400 });
    const result = await createSavedView({ ...fields.value, query: withoutPlaceholder(fields.value.query) }, actor.id);
    if (!result.ok) return Response.json({ error: savedViewNameTakenMessage(fields.value.name) }, { status: 409 });

    await writeAudit({
      actor,
      action: 'view.create',
      entityType: 'saved_view',
      entityId: result.view.id,
      // A Personal item is logged by id and kind only: its name is its owner's alone.
      summary: 'Saved a Personal view',
      details: { fields: SAVED_VIEW_FIELDS },
    });
    const [view] = await holdBackSavedViews(actor.access, [result.view]);
    return Response.json(view, { status: 201 });
  } catch (err) {
    return serverError('Could not save the view', err);
  }
}
